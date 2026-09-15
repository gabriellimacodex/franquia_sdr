import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Database, Queryable, Scope } from './database.js';
import { scoped } from './database.js';
import { createLeadState, LeadStateSchema, type LeadState } from './domain.js';

export type RuntimeRoleResult = {ok:true,value:{role:string}} | {ok:false,error:{code:'UNSAFE_DATABASE_ROLE'|'DATABASE_UNAVAILABLE'}};

/** Fails closed: FORCE ROW LEVEL SECURITY does not constrain superusers or BYPASSRLS. */
export async function assertRuntimeRole(db:Database):Promise<RuntimeRoleResult> {
  try {
    const {rows}=await db.query<{rolname:string,rolsuper:boolean,rolbypassrls:boolean,rolcreaterole:boolean,rolcreatedb:boolean}>(
      'SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user');
    const role=rows[0];
    if(!role||role.rolsuper||role.rolbypassrls||role.rolcreaterole||role.rolcreatedb) return {ok:false,error:{code:'UNSAFE_DATABASE_ROLE'}};
    return {ok:true,value:{role:role.rolname}};
  } catch {return {ok:false,error:{code:'DATABASE_UNAVAILABLE'}};}
}

export const RetentionOptionsSchema=z.object({days:z.number().int().min(1).max(30),dryRun:z.boolean().default(true),now:z.date().refine(value=>Number.isFinite(value.getTime()))}).strict();
const countSchema=z.number().int().nonnegative();
export const RetentionReportSchema=z.object({
  event:z.literal('retention_sweep'),dryRun:z.boolean(),cutoff:z.string().datetime(),
  counts:z.object({candidatesDeleted:countSchema,candidatesRedacted:countSchema,messagesDeleted:countSchema,factsDeleted:countSchema,relationsDeleted:countSchema,jobsDeleted:countSchema,jobSnapshotsRedacted:countSchema,briefingsDeleted:countSchema,eventsDeleted:countSchema,evaluationsDeleted:countSchema,deliveriesDeleted:countSchema,receiptsDeleted:countSchema}),
});
export type RetentionReport=z.infer<typeof RetentionReportSchema>;
export type RetentionResult={ok:true,value:RetentionReport}|{ok:false,error:{code:'INVALID_RETENTION_POLICY'|'RETENTION_FAILED'}};
const newCounts=():RetentionReport['counts']=>({candidatesDeleted:0,candidatesRedacted:0,messagesDeleted:0,factsDeleted:0,relationsDeleted:0,jobsDeleted:0,jobSnapshotsRedacted:0,briefingsDeleted:0,eventsDeleted:0,evaluationsDeleted:0,deliveriesDeleted:0,receiptsDeleted:0});

export async function purgeRetention(db:Database,days=30,options:{dryRun?:boolean,now?:Date}={}):Promise<RetentionResult> {
  const parsed=RetentionOptionsSchema.safeParse({days,dryRun:options.dryRun??true,now:options.now??new Date()});
  if(!parsed.success)return {ok:false,error:{code:'INVALID_RETENTION_POLICY'}};
  const cutoff=new Date(parsed.data.now.getTime()-days*86_400_000).toISOString();
  const counts=newCounts();
  try {
    const scopes=(await db.query<{tenant_id:string,id:string}>('SELECT tenant_id,id FROM sdr.brands')).rows;
    for(const scope of scopes)await scoped(db,{tenantId:scope.tenant_id,brandId:scope.id},async tx=>{
      const scopeCounts=await purgeScope(tx,{tenantId:scope.tenant_id,brandId:scope.id},cutoff,parsed.data.dryRun);
      for(const key of Object.keys(counts) as (keyof typeof counts)[])counts[key]+=scopeCounts[key];
    });
    // Receipt hashes contain no message bodies and are global, unlike all candidate data.
    counts.receiptsDeleted=Number((await db.query<{count:string}>('SELECT count(*) FROM sdr.webhook_receipts WHERE created_at<$1',[cutoff])).rows[0].count);
    if(!parsed.data.dryRun)await db.query('DELETE FROM sdr.webhook_receipts WHERE created_at<$1',[cutoff]);
    return {ok:true,value:RetentionReportSchema.parse({event:'retention_sweep',dryRun:parsed.data.dryRun,cutoff,counts})};
  }catch{return {ok:false,error:{code:'RETENTION_FAILED'}};}
}

type MessageRow={id:string,candidate_id:string,conversation_id:string,provider_timestamp:Date,actor:string};
type CandidateRow={id:string,lead_state:unknown,updated_at:Date};
type ConversationRow={id:string,candidate_id:string,updated_at:Date};
type DataRow={id:string,candidate_id:string,data:Record<string,unknown>};
type JobRow={id:string,candidate_id:string,conversation_id:string,created_at:Date,context:unknown,result:unknown,state:string};
type EventRow={id:string,conversation_id:string,created_at:Date,detail:unknown};
type BriefRow={id:string,conversation_id:string,created_at:Date,data:unknown};
type EvalRow={id:string,conversation_id:string,created_at:Date,job_id:string};

function hasReference(value:unknown,expired:Set<string>):boolean {
  if(typeof value==='string')return expired.has(value);
  if(Array.isArray(value))return value.some(item=>hasReference(item,expired));
  if(value&&typeof value==='object')return Object.values(value).some(item=>hasReference(item,expired));
  return false;
}

function missingEvidence(value:unknown,retainedMessages:Set<string>):boolean {
  if(Array.isArray(value))return value.some(item=>missingEvidence(item,retainedMessages));
  if(value&&typeof value==='object') {
    const record=value as Record<string,unknown>;
    if(typeof record.messageId==='string'&&!retainedMessages.has(record.messageId))return true;
    if(typeof record.sourceMessageId==='string'&&!retainedMessages.has(record.sourceMessageId))return true;
    if(Array.isArray(record.messages)&&record.messages.some(message=>!message||typeof message!=='object'||!retainedMessages.has(String((message as Record<string,unknown>).id))))return true;
    return Object.values(record).some(item=>missingEvidence(item,retainedMessages));
  }
  return false;
}

function pruneLead(raw:unknown,scope:Scope,id:string,retainedMessages:Set<string>,cutoff:string):LeadState {
  const parsed=LeadStateSchema.safeParse(raw);
  if(!parsed.success||parsed.data.tenantId!==scope.tenantId||parsed.data.brandId!==scope.brandId||parsed.data.leadId!==id)return createLeadState(scope.tenantId,scope.brandId,id);
  const lead=parsed.data;
  const facts=lead.facts.filter(fact=>retainedMessages.has(fact.evidence.messageId)&&fact.createdAt>=cutoff);
  const factIds=new Set(facts.map(fact=>fact.id));
  const relations=lead.relations.filter(relation=>retainedMessages.has(relation.evidence.messageId));
  const relationIds=new Set(relations.map(relation=>relation.id));
  const referral=lead.referral&&retainedMessages.has(lead.referral.evidence.messageId)?lead.referral:null;
  const next={...lead,facts:facts.map(fact=>({...fact,replacesFactId:fact.replacesFactId&&factIds.has(fact.replacesFactId)?fact.replacesFactId:null,relationId:fact.relationId&&relationIds.has(fact.relationId)?fact.relationId:null})),relations,referral};
  if(!isDeepStrictEqual(lead,next)) {
    const required=['city','capital_available','opening_months','decision_role','operating_role'] as const;
    next.qualification={priority:lead.status==='handoff'||lead.status==='stopped'?'review':'qualifying',temperature:'unknown',canHandoff:false,reasons:['retention_context_pruned'],missingFields:required.filter(field=>!next.facts.some(fact=>fact.field===field&&fact.attribution==='candidate'&&['declared','confirmed'].includes(fact.status)))};
  }
  return next;
}

/** One scope-wide advisory lock (inside scoped()) prevents a concurrent turn from rebuilding expired snapshots. */
async function purgeScope(tx:Queryable,scope:Scope,cutoff:string,dryRun:boolean):Promise<RetentionReport['counts']> {
  const s=[scope.tenantId,scope.brandId];
  const counts=newCounts();
  const candidates=(await tx.query<CandidateRow>('SELECT id,lead_state,updated_at FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 FOR UPDATE',s)).rows;
  const conversations=(await tx.query<ConversationRow>('SELECT id,candidate_id,updated_at FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const messages=(await tx.query<MessageRow>('SELECT id,candidate_id,conversation_id,provider_timestamp,actor FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const facts=(await tx.query<DataRow>('SELECT id,candidate_id,data FROM sdr.facts WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const relations=(await tx.query<DataRow>('SELECT id,candidate_id,data FROM sdr.relations WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const jobs=(await tx.query<JobRow>('SELECT id,candidate_id,conversation_id,created_at,context,result,state FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const events=(await tx.query<EventRow>('SELECT id,conversation_id,created_at,detail FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const briefings=(await tx.query<BriefRow>('SELECT id,conversation_id,created_at,data FROM sdr.briefings WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const evaluations=(await tx.query<EvalRow>('SELECT id,conversation_id,created_at,job_id FROM sdr.evaluations WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const deliveries=(await tx.query<{job_id:string,created_at:Date}>('SELECT job_id,created_at FROM sdr.deliveries WHERE tenant_id=$1 AND brand_id=$2',s)).rows;
  const older=(date:Date)=>date.getTime()<Date.parse(cutoff);
  const deleteCandidates=new Set<string>(),deleteMessages=new Set<string>(),deleteFacts=new Set<string>(),deleteRelations=new Set<string>(),deleteJobs=new Set<string>(),redactJobs=new Set<string>(),deleteEvents=new Set<string>(),deleteBriefings=new Set<string>(),deleteEvaluations=new Set<string>(),deleteDeliveries=new Set<string>();
  for(const candidate of candidates) {
    const candidateMessages=messages.filter(row=>row.candidate_id===candidate.id);
    const candidateJobs=jobs.filter(row=>row.candidate_id===candidate.id);
    const candidateConversations=conversations.filter(row=>row.candidate_id===candidate.id);
    const conversationIds=new Set(candidateConversations.map(row=>row.id));
    const inactive=older(candidate.updated_at)&&candidateMessages.every(row=>older(row.provider_timestamp))&&candidateJobs.every(row=>older(row.created_at))&&candidateConversations.every(row=>older(row.updated_at));
    if(inactive)deleteCandidates.add(candidate.id);
    const expired=new Set(candidateMessages.filter(row=>inactive||older(row.provider_timestamp)).map(row=>row.id));
    for(const id of expired)deleteMessages.add(id);
    const retained=new Set(candidateMessages.filter(row=>!expired.has(row.id)&&row.actor==='candidate').map(row=>row.id));
    const retainedHistory=new Set(candidateMessages.filter(row=>!expired.has(row.id)).map(row=>row.id));
    const next=pruneLead(candidate.lead_state,scope,candidate.id,retained,cutoff);
    const retainedFacts=new Map(next.facts.map(fact=>[fact.id,fact]));
    const retainedRelations=new Set(next.relations.map(relation=>relation.id));
    for(const row of facts.filter(row=>row.candidate_id===candidate.id))if(inactive||!retainedFacts.has(row.id)){deleteFacts.add(row.id);expired.add(row.id);}
    for(const row of relations.filter(row=>row.candidate_id===candidate.id))if(inactive||!retainedRelations.has(String(row.data.id))){deleteRelations.add(row.id);expired.add(row.id);if(typeof row.data.id==='string')expired.add(row.data.id);}
    const leadChanged=!isDeepStrictEqual(candidate.lead_state,next);
    const candidateChanged=leadChanged||expired.size>0;
    if(!inactive&&candidateChanged) {
      counts.candidatesRedacted++;
      if(!dryRun) {
        // Preserve updated_at: retention is not new candidate activity.
        await tx.query('UPDATE sdr.candidates SET lead_state=$4,revision=revision+1 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,candidate.id,JSON.stringify(next)]);
        for(const row of facts.filter(row=>row.candidate_id===candidate.id&&!deleteFacts.has(row.id))) {
          const fact=retainedFacts.get(row.id)!;
          if(!isDeepStrictEqual(row.data,fact))await tx.query('UPDATE sdr.facts SET data=$4 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,row.id,JSON.stringify(fact)]);
        }
      }
    }
    for(const job of candidateJobs) {
      if(inactive||older(job.created_at))deleteJobs.add(job.id);
      else if(hasReference(job.context,expired)||hasReference(job.result,expired)||missingEvidence(job.context,retainedHistory)||missingEvidence(job.result,retainedHistory)||(candidateChanged&&['pending','working','running','ready'].includes(job.state)))redactJobs.add(job.id);
    }
    const derivativeIds=new Set([...expired,...deleteJobs,...redactJobs]);
    for(const row of events.filter(row=>conversationIds.has(row.conversation_id)))if(inactive||older(row.created_at)||hasReference(row.detail,derivativeIds)||missingEvidence(row.detail,retainedHistory))deleteEvents.add(row.id);
    // A natural-language summary cannot be safely edited to remove one fact: regenerate it from retained evidence.
    for(const row of briefings.filter(row=>conversationIds.has(row.conversation_id)))if(inactive||older(row.created_at)||candidateChanged||hasReference(row.data,derivativeIds)||missingEvidence(row.data,retainedHistory))deleteBriefings.add(row.id);
    for(const row of evaluations.filter(row=>conversationIds.has(row.conversation_id)))if(inactive||older(row.created_at)||deleteJobs.has(row.job_id)||redactJobs.has(row.job_id))deleteEvaluations.add(row.id);
  }
  for(const row of deliveries)if(older(row.created_at)||deleteJobs.has(row.job_id))deleteDeliveries.add(row.job_id);
  counts.candidatesDeleted=deleteCandidates.size;counts.messagesDeleted=deleteMessages.size;counts.factsDeleted=deleteFacts.size;counts.relationsDeleted=deleteRelations.size;counts.jobsDeleted=deleteJobs.size;counts.jobSnapshotsRedacted=redactJobs.size;counts.eventsDeleted=deleteEvents.size;counts.briefingsDeleted=deleteBriefings.size;counts.evaluationsDeleted=deleteEvaluations.size;counts.deliveriesDeleted=deleteDeliveries.size;
  if(!dryRun) {
    // Table and column names below are fixed source-code values, never caller input.
    const removals:[string,string,Set<string>][]=[['evaluations','id',deleteEvaluations],['events','id',deleteEvents],['briefings','id',deleteBriefings],['deliveries','job_id',deleteDeliveries],['jobs','id',deleteJobs],['facts','id',deleteFacts],['relations','id',deleteRelations],['messages','id',deleteMessages],['candidates','id',deleteCandidates]];
    for(const [table,column,ids] of removals)if(ids.size)await tx.query(`DELETE FROM sdr.${table} WHERE tenant_id=$1 AND brand_id=$2 AND ${column}=ANY($3::text[])`,[...s,[...ids]]);
    if(redactJobs.size)await tx.query("UPDATE sdr.jobs SET context=NULL,result=NULL,state=CASE WHEN state IN ('pending','working','running','ready') THEN 'stale' ELSE state END,error_code='RETENTION_CONTEXT_PRUNED' WHERE tenant_id=$1 AND brand_id=$2 AND id=ANY($3::text[])",[...s,[...redactJobs]]);
  }
  return counts;
}
