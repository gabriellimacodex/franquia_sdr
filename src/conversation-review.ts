import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scoped, type Database, type Queryable } from './database.js';
import type { LabIdentity } from './lab.js';
import { LeadStateSchema } from './domain.js';
import { SnapshotSchema } from './engine.js';
import { snapshotHash } from './versioning.js';
import { ConversationReviewInputSchema, ConversationReviewRecordSchema, ConversationReviewTargetSchema, type ConversationReviewResult, type ConversationReviewSpec, type ConversationReviewTarget } from './conversation-review.spec.js';

type Code=Extract<ConversationReviewResult,{success:false}>['error']['code'];
const fail=(code:Code):ConversationReviewResult=>({success:false,error:{code}});
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
type ReviewRow={id:string,conversation_id:string,at:string,detail:unknown};
function readReview(row:ReviewRow,identity:LabIdentity){
 const parsed=ConversationReviewRecordSchema.safeParse(row.detail);if(!parsed.success)return null;
 const review=parsed.data,target=review.target;
 return target.tenantId===identity.tenantId&&target.brandId===identity.brandId&&target.conversationId===row.conversation_id&&target.selectedJobId===review.jobId&&
  digest(target)===review.targetHash&&review.id===row.id&&review.reviewedAt===row.at&&
  review.id==='s4-review:'+digest([identity.tenantId,identity.brandId,row.conversation_id,review.actorUserId,review.idempotencyKey])?review:null;
}
const Job=z.object({id:z.string(),candidate_id:z.string(),conversation_id:z.string(),version_id:z.string(),trigger_message_id:z.string(),context_version:z.number(),state:z.string(),completed_at:z.string().nullable(),
 result:z.object({bubbles:z.array(z.string()).min(1)}).nullable(),context:z.unknown(),error_code:z.string().nullable()});
const Context=z.object({origin:z.string().optional(),sources:z.array(z.object({id:z.string(),title:z.string(),content:z.string()})).optional(),excludedSources:z.array(z.object({id:z.string(),title:z.string(),reason:z.string()})).optional(),lead:z.unknown().optional(),guardReview:z.object({violations:z.array(z.string()).optional()}).optional()});

/** Authenticated review input only: no model call, campaign receipt, rating aggregation or publication. */
export class ConversationReview implements ConversationReviewSpec {
 constructor(private db:Database){}
 async execute(identity:LabIdentity,raw:unknown):Promise<ConversationReviewResult>{
  try{
   const parsed=ConversationReviewInputSchema.safeParse(raw);if(!parsed.success)return fail('INVALID_INPUT');
   return await scoped(this.db,identity,async tx=>{
    const membership=(await tx.query<{role:string}>('SELECT role FROM sdr.memberships WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3 AND active',[identity.tenantId,identity.brandId,identity.userId])).rows[0];
    if(!membership||!['admin','reviewer'].includes(membership.role))return fail('FORBIDDEN');
    const input=parsed.data;
    if(input.action==='target')return this.target(tx,identity,input.conversationId,input.jobId);
    const scope=[identity.tenantId,identity.brandId,input.conversationId];
    const conversation=(await tx.query(`SELECT c.id FROM sdr.conversations c JOIN sdr.channels ch ON (ch.tenant_id,ch.brand_id,ch.phone_number_id)=(c.tenant_id,c.brand_id,c.phone_number_id)
     WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.id=$3 AND ch.kind='laboratory'`,scope)).rows[0];
    if(!conversation)return fail('TARGET_NOT_FOUND');
    if(input.action==='history'){
     const rows=(await tx.query<ReviewRow>("SELECT id,conversation_id,to_jsonb(created_at)#>>'{}' AS at,detail FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND type='sprint4_human_review_recorded' ORDER BY created_at DESC,id",scope)).rows;
     const reviews=rows.map(row=>readReview(row,identity));if(reviews.some(review=>review===null))return fail('READ_FAILED');
     return {success:true,data:{reviews:reviews.filter(review=>review!==null)}};
    }
    const prior=(await tx.query<ReviewRow>(`SELECT id,conversation_id,to_jsonb(created_at)#>>'{}' AS at,detail FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND type='sprint4_human_review_recorded' AND detail->>'actorUserId'=$3
     AND (detail->>'idempotencyKey'=$4 OR (conversation_id=$5 AND detail->>'jobId'=$6 AND detail->>'targetHash'=$7)) ORDER BY created_at,id`,
     [identity.tenantId,identity.brandId,identity.userId,input.submission.idempotencyKey,input.conversationId,input.submission.jobId,input.submission.targetHash])).rows;
    if(prior.length){
     if(prior.length!==1)return fail('REVIEW_CONFLICT');
     const review=readReview(prior[0],identity),submission=input.submission;if(!review)return fail('READ_FAILED');
     if(review.target.conversationId!==input.conversationId||review.jobId!==submission.jobId||review.targetHash!==submission.targetHash||canonical(review.scores)!==canonical(submission.scores)||review.notes!==submission.notes)return fail('REVIEW_CONFLICT');
     return {success:true,data:{review,duplicate:true}};
    }
    const view=await this.target(tx,identity,input.conversationId,input.submission.jobId);
    if(!view.success)return view;if(!('target' in view.data))return fail('READ_FAILED');
    if(input.submission.targetHash!==view.data.targetHash)return fail('TARGET_CHANGED');
    const stamp=(await tx.query<{at:string}>("SELECT to_jsonb(clock_timestamp())#>>'{}' AS at")).rows[0].at;
    const review=ConversationReviewRecordSchema.parse({...input.submission,id:'s4-review:'+digest([...scope,identity.userId,input.submission.idempotencyKey]),kind:'sprint4-human-review-v1',rubric:'sprint4-conversation-v1',
     actorUserId:identity.userId,reviewedAt:stamp,target:view.data.target});
    await tx.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail,created_at) VALUES($4,$1,$2,$3,'sprint4_human_review_recorded',$5,$6)",[...scope,review.id,JSON.stringify(review),stamp]);
    return {success:true,data:{review,duplicate:false}};
   });
  }catch{return fail('READ_FAILED');}
 }
 private async target(tx:Queryable,identity:LabIdentity,conversationId:string,jobId:string):Promise<ConversationReviewResult>{
  const scope=[identity.tenantId,identity.brandId,conversationId];
  const selected=(await tx.query<{job:unknown,kind:string,candidate_id:string}>(`SELECT to_jsonb(j) AS job,ch.kind,c.candidate_id FROM sdr.jobs j
   JOIN sdr.conversations c ON (c.tenant_id,c.brand_id,c.id)=(j.tenant_id,j.brand_id,j.conversation_id)
   JOIN sdr.channels ch ON (ch.tenant_id,ch.brand_id,ch.phone_number_id)=(c.tenant_id,c.brand_id,c.phone_number_id)
   WHERE j.tenant_id=$1 AND j.brand_id=$2 AND j.conversation_id=$3 AND j.id=$4`,[...scope,jobId])).rows[0];
  if(!selected)return fail('TARGET_NOT_FOUND');
  const parsed=Job.safeParse(selected.job);if(!parsed.success)return fail('INCOMPLETE_TARGET');
  const last=parsed.data;
  if(last.candidate_id!==selected.candidate_id)return fail('INCOMPLETE_TARGET');
  if(selected.kind!=='laboratory'||!['completed','handoff'].includes(last.state)||!last.completed_at)return fail('TARGET_NOT_REVIEWABLE');
  const rows=(await tx.query<{job:unknown,content_hash:string,model:string,snapshot:unknown,special_ids:string[]}>(`SELECT to_jsonb(j) AS job,v.content_hash,v.model,v.snapshot,
   ARRAY(SELECT m.id FROM sdr.messages m WHERE m.tenant_id=j.tenant_id AND m.brand_id=j.brand_id AND m.conversation_id=j.conversation_id AND m.id=ANY(ARRAY[j.id||':greeting',j.id||':capability',j.id||':budget',j.id||':reply:0']) ORDER BY m.id) AS special_ids
   FROM sdr.jobs j JOIN sdr.versions v ON (v.tenant_id,v.brand_id,v.id)=(j.tenant_id,j.brand_id,j.version_id)
   WHERE j.tenant_id=$1 AND j.brand_id=$2 AND j.conversation_id=$3 AND j.context_version<=$4 AND j.completed_at IS NOT NULL AND j.result IS NOT NULL
   ORDER BY j.context_version,j.created_at,j.id LIMIT 101`,[...scope,last.context_version])).rows;
  if(rows.length>100)return fail('INCOMPLETE_TARGET');
  const guards=(await tx.query<{detail:{jobId?:string,versionId?:string,guardViolations?:string[],originalGuardViolations?:string[]}}>("SELECT detail FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND type='turn_completed' ORDER BY created_at,id",scope)).rows;
  const turns:ConversationReviewTarget['turns']=[];const messageIds:string[]=[];
  for(const row of rows){
   const job=Job.parse(row.job),snapshot=SnapshotSchema.safeParse(row.snapshot);
   if(!job.result||!job.completed_at||job.candidate_id!==last.candidate_id||!snapshot.success||snapshot.data.tenant.tenantId!==identity.tenantId||snapshot.data.tenant.brandId!==identity.brandId||
    snapshot.data.model!==row.model||snapshotHash(snapshot.data)!==row.content_hash)return fail('INCOMPLETE_TARGET');
   const context=Context.safeParse(job.context),lead=context.success?LeadStateSchema.safeParse(context.data.lead):null;
   if(job.context!==null&&!context.success||context.success&&(
    context.data.sources?.some(source=>!snapshot.data.sources.some(pinned=>pinned.id===source.id&&pinned.title===source.title&&pinned.content.includes(source.content)))||
    context.data.excludedSources?.some(source=>!snapshot.data.sources.some(pinned=>pinned.id===source.id&&pinned.title===source.title))))return fail('INCOMPLETE_TARGET');
   if(lead?.success&&(lead.data.tenantId!==identity.tenantId||lead.data.brandId!==identity.brandId||lead.data.leadId!==last.candidate_id))return fail('INCOMPLETE_TARGET');
   if(context.success&&context.data.lead!==undefined&&!lead?.success)return fail('INCOMPLETE_TARGET');
   const specialIds=row.special_ids.filter(id=>id!==job.id+':reply:0');
   if(specialIds.length&&(specialIds.length!==1||job.result.bubbles.length!==1||row.special_ids.length!==1))return fail('INCOMPLETE_TARGET');
   const responseMessageIds=specialIds.length?specialIds:job.result.bubbles.map((_,i)=>job.id+':reply:'+i);
   messageIds.push(job.trigger_message_id,...responseMessageIds);
   turns.push({jobId:job.id,versionId:job.version_id,contentHash:row.content_hash,model:row.model,status:job.state,completedAt:job.completed_at,triggerMessageId:job.trigger_message_id,responseMessageIds,
    sources:context.success?(context.data.sources??[]).map(s=>({id:s.id,title:s.title,excerpt:s.content})):[],excludedSources:context.success?context.data.excludedSources??[]:[],
    guardCodes:[...new Set([...(job.error_code?[job.error_code]:[]),...(context.success?context.data.guardReview?.violations??[]:[]),
     ...guards.filter(g=>g.detail.jobId===job.id&&g.detail.versionId===job.version_id).flatMap(g=>[...g.detail.guardViolations??[],...g.detail.originalGuardViolations??[]])])].sort(),
    memoryBefore:lead?.success?{facts:lead.data.facts,relations:lead.data.relations}:null});
  }
  // Bound linked turns by the laboratory revision, not wall-clock rounding. Include exact
  // response IDs even when a deterministic reply was inserted after completed_at.
  // Older unlinked messages use the trigger cutoff; future-job identities stay excluded.
  const messages=(await tx.query<{id:string,actor:string,type:string,text:string,createdAt:string,jobId:string|null}>(`SELECT m.id,m.actor,m.type,m.text,to_jsonb(m.created_at)#>>'{}' AS "createdAt",NULL::text AS "jobId"
   FROM sdr.messages m WHERE m.tenant_id=$1 AND m.brand_id=$2 AND m.conversation_id=$3 AND m.candidate_id=$4 AND
   (m.id=ANY($5::text[]) OR (m.created_at<(SELECT created_at FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND id=$6)
    AND NOT EXISTS(SELECT 1 FROM sdr.jobs future WHERE future.tenant_id=$1 AND future.brand_id=$2 AND future.conversation_id=$3 AND future.context_version>$7 AND (future.trigger_message_id=m.id OR left(m.id,length(future.id)+1)=future.id||':'))))
   ORDER BY m.created_at,array_position($5::text[],m.id),m.id LIMIT 501`,[...scope,last.candidate_id,messageIds,last.trigger_message_id,last.context_version])).rows;
  if(messages.length>500||!turns.some(t=>t.jobId===last.id))return fail('INCOMPLETE_TARGET');
  for(const row of rows){
   const job=Job.parse(row.job),input=messages.find(m=>m.id===job.trigger_message_id);
   const turn=turns.find(t=>t.jobId===job.id)!;
   if(!input||input.actor!=='candidate'||job.result!.bubbles.some((text,i)=>!messages.some(m=>m.id===turn.responseMessageIds[i]&&m.actor==='agent'&&m.text===text)))return fail('INCOMPLETE_TARGET');
   for(const message of messages)if(message.id===job.trigger_message_id||turn.responseMessageIds.includes(message.id))message.jobId=job.id;
  }
  for(const [index,turn] of turns.entries()){
   const references=[...turn.memoryBefore?.facts??[],...turn.memoryBefore?.relations??[]];
   if(references.some(item=>!messages.some(message=>message.actor==='candidate'&&message.id===item.evidence.messageId&&message.text.includes(item.evidence.quote)&&
    (message.jobId!==null?turns.findIndex(t=>t.jobId===message.jobId)<=index:messages.indexOf(message)<=messages.findIndex(m=>m.id===turn.triggerMessageId)))))return fail('INCOMPLETE_TARGET');
  }
  const target=ConversationReviewTargetSchema.parse({kind:'sprint4-conversation-target-v1',tenantId:identity.tenantId,brandId:identity.brandId,conversationId,candidateId:last.candidate_id,selectedJobId:jobId,turns,messages,
   limitations:['conversation-prefix-not-campaign-execution-proof','provider-original-output-not-retained','private-runtime-context-not-exposed','memory-is-pre-turn-projection-only','human-review-is-not-objective-audit-receipt-or-publication-approval']});
  return {success:true,data:{targetHash:digest(target),target}};
 }
}
