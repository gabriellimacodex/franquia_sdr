import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AGENT_OUTPUT_JSON_SCHEMA, AgentDecisionSchema, TenantConfigSchema, KnowledgeSourceSchema, LeadStateSchema, mergeFactProposals, hasTrustedEvidence, deriveQualification, guardDecision, type TrustedMessage } from './domain.js';
import { scoped } from './database.js';
import { Store, type Channel, type JobRow, type CandidateRow, type ConversationRow } from './store.js';
import { ServiceError } from './security.js';
import type { Config } from './config.js';
import { transcribeAudio } from './audio.js';
import { retrieveKnowledge, buildEmbedding } from './knowledge.js';
import { UsageSchema } from './usage.js';
import { reserveLabBudget, settleLabBudget } from './lab-budget.js';
import { reconcileMemoryReply } from './memory-reply.js';
import { persistLeadMemory } from './persist-lead-memory.js';
import { FINANCIAL_OUTPUT_JSON_SCHEMA, FinancialDecisionSchema, guardFinancialDecision } from './financial-reply.js';
import { guardQuestionReply } from './question-reply.js';
import { CompletionSnapshot } from './completion-snapshot.js';
import { LaboratoryDispatch } from './laboratory-dispatch.js';

export const SnapshotSchema=z.object({tenant:TenantConfigSchema,sources:z.array(KnowledgeSourceSchema),prompt:z.string().min(1),model:z.literal('gpt-5.4-2026-03-05'),briefingModel:z.literal('gpt-5-mini'),outputContract:z.literal('financial-v2').optional()}).strict().refine(s=>s.sources.every(x=>x.tenantId===s.tenant.tenantId&&x.brandId===s.tenant.brandId),'All version sources must belong to this brand');
export const CompletionSchema=z.object({
 jobId:z.string(),contextVersion:z.number().int(),result:z.union([AgentDecisionSchema,FinancialDecisionSchema]),
 model:z.string().optional(),usage:UsageSchema.optional(),configVersion:z.string().optional(),
 timings:z.object({modelRoundTripMs:z.number().int().min(0).max(180000)}).strict().optional().catch(undefined),
}).strict();
const DurationMsSchema=z.number().int().nonnegative();
const StoredTimingsSchema=z.object({attempt:z.number().int().nonnegative(),dispatchPreparationUntilContextWriteMs:DurationMsSchema.optional(),dispatchPreparationMs:DurationMsSchema.optional(),prepareUntilContextWriteMs:DurationMsSchema.optional(),preflightMs:DurationMsSchema.optional(),prepareMs:DurationMsSchema.optional(),budgetReservationMs:DurationMsSchema.optional(),n8nAckMs:DurationMsSchema.optional()}).strict();

export class Engine {
 constructor(private store:Store,private config:Config,private transport:typeof fetch=fetch,private clock:()=>number=()=>performance.now()) {}
 async prepare(channel:Channel,job:JobRow) {
  const prepareStarted=this.clock();
  let embedding:Awaited<ReturnType<typeof buildEmbedding>>|null=null;
  if(channel.kind!=='laboratory') {
   const recent=await scoped(this.store.db,channel,tx=>tx.query<{text:string}>("SELECT text FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3 AND actor='candidate' ORDER BY provider_timestamp DESC LIMIT 4",[channel.tenantId,channel.brandId,job.candidate_id]));
   embedding=await buildEmbedding(recent.rows.map(m=>m.text).join(' ').slice(0,12000),this.config.OPENAI_API_KEY,this.transport);
  }
  return scoped(this.store.db,channel,async tx=>{
   const s=[channel.tenantId,channel.brandId];
   // Independent preparation reads share one round trip after the existing scope lock.
   const loaded=(await tx.query<{versions:{snapshot:unknown}[],leads:Pick<CandidateRow,'id'|'lead_state'>[],messages:{id:string,actor:string,text:string,type:string,provider_timestamp:string}[]}>(`SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('snapshot',snapshot)) FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3),'[]'::jsonb) AS versions,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'lead_state',lead_state)) FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$4),'[]'::jsonb) AS leads,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'actor',actor,'text',text,'type',type,'provider_timestamp',provider_timestamp) ORDER BY provider_timestamp)
      FROM (SELECT id,actor,text,type,provider_timestamp FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$4 ORDER BY provider_timestamp DESC,created_at DESC LIMIT 24) recent),'[]'::jsonb) AS messages`,[...s,job.version_id,job.candidate_id])).rows[0];
   const version=loaded.versions[0];
   const snapshot=SnapshotSchema.parse(version.snapshot);
   if(snapshot.tenant.tenantId!==channel.tenantId||snapshot.tenant.brandId!==channel.brandId) throw new ServiceError('VERSION_SCOPE_MISMATCH',409);
   const lead=loaded.leads[0];
   const parsedLead=LeadStateSchema.parse(lead.lead_state);
   if(parsedLead.tenantId!==channel.tenantId||parsedLead.brandId!==channel.brandId||parsedLead.leadId!==lead.id) throw new ServiceError('MEMORY_SCOPE_MISMATCH',409);
   const messages=loaded.messages;
   const question=messages.filter(m=>m.actor==='candidate').slice(-4).map(m=>m.text).join(' ');
   const retrieval=await retrieveKnowledge(tx,channel,job.version_id,question,embedding?.ok?embedding.embedding:undefined);
   if(retrieval.mode==='unavailable')throw new ServiceError('KNOWLEDGE_UNAVAILABLE',503);
   const context={tenant:snapshot.tenant,lead:parsedLead,messages:messages.map(m=>({id:m.id,role:m.actor==='candidate'?'user':m.actor==='human'?'operator':'assistant',text:m.text,type:m.type,createdAt:new Date(m.provider_timestamp).toISOString()})),sources:retrieval.sources,excludedSources:retrieval.excludedSources,retrieval:retrieval.mode,contextVersion:job.context_version};
   // Private partial interval survives a callback that arrives before dispatch stores its ACK.
   // It excludes this context UPDATE and the preparation transaction's COMMIT.
   const backendTimings={attempt:job.attempts,prepareUntilContextWriteMs:Math.round(this.clock()-prepareStarted)};
   await tx.query('UPDATE sdr.jobs SET context=$4 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,job.id,JSON.stringify({...context,backendTimings})]);
   return {jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:snapshot.model,instructions:snapshot.prompt,context,outputSchema:snapshot.outputContract==='financial-v2'?FINANCIAL_OUTPUT_JSON_SCHEMA:AGENT_OUTPUT_JSON_SCHEMA,callbackUrl:this.config.PUBLIC_API_URL.replace(/\/$/,'')+'/internal/n8n/jobs/'+encodeURIComponent(job.id)+'/complete'};
  });
 }
 async dispatch(channel:Channel,job:JobRow):Promise<void> {
  if(channel.kind==='laboratory')return this.dispatchLaboratory(channel,job);
  return this.dispatchLegacy(channel,job);
 }
 private async dispatchLaboratory(channel:Channel,job:JobRow):Promise<void> {
  const started=this.clock();
  const prepared=await new LaboratoryDispatch(this.store.db,channel,this.config,undefined,this.clock).execute({jobId:job.id,attempt:job.attempts,contextVersion:job.context_version,epoch:job.epoch,versionId:job.version_id});
  if(!prepared.success)throw new ServiceError(prepared.error.code,503);
  if(prepared.data.kind!=='ready')return;
  const n8nStarted=this.clock();
  const response=await this.transport(this.config.N8N_WEBHOOK_URL,{method:'POST',headers:{Authorization:'Bearer '+this.config.N8N_WEBHOOK_TOKEN,'Content-Type':'application/json'},body:prepared.data.body,signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new ServiceError('N8N_UNAVAILABLE',503);
  const backendTimings={attempt:job.attempts,dispatchPreparationMs:Math.round(n8nStarted-started),n8nAckMs:Math.round(this.clock()-n8nStarted)};
  await scoped(this.store.db,channel,tx=>tx.query("UPDATE sdr.jobs SET state='running',context=COALESCE(context,'{}'::jsonb)||$4::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND state='working' AND attempts=$5",[channel.tenantId,channel.brandId,job.id,JSON.stringify({backendTimings}),job.attempts]));
 }
 private async dispatchLegacy(channel:Channel,job:JobRow):Promise<void> {
  const dispatchStarted=this.clock();
  const s=[channel.tenantId,channel.brandId];
  const {audio,latest}=await scoped(this.store.db,channel,async tx=>{
   // Independent preflight reads share a round trip, after the existing scope lock.
   const row=(await tx.query<{audio:{id:string,media_id:string,type:string,text:string}[],latest_type:string|null}>(`SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'media_id',media_id,'type',type,'text',text) ORDER BY provider_timestamp DESC)
      FROM (SELECT id,media_id,type,text,provider_timestamp FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND actor='candidate' ORDER BY provider_timestamp DESC LIMIT 24) recent
      WHERE type='audio' AND text=''),'[]'::jsonb) AS audio,
    (SELECT type FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND id=$4) AS latest_type`,[...s,job.conversation_id,job.trigger_message_id])).rows[0];
   return {audio:{rows:row.audio},latest:{rows:row.latest_type===null?[]:[{type:row.latest_type}]}};
  });
  if(channel.kind==='laboratory'&&audio.rows.length){await this.setCapabilityReply(channel,job,'Nesta etapa do laboratório, envie sua mensagem por texto.');return;}
  if(audio.rows.length>3){await this.setCapabilityReply(channel,job,'Recebi vários áudios. Pode resumir por texto os pontos principais para que eu registre corretamente?');return;}
  for(const message of audio.rows) {
   try {
    const text=await transcribeAudio(message.media_id,channel.phoneNumberId,this.config,this.transport);
    await scoped(this.store.db,channel,tx=>tx.query("UPDATE sdr.messages SET text=$4,transcript_origin='openai' WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,message.id,text]));
   } catch {
    await this.setCapabilityReply(channel,job,'Não consegui compreender este áudio com segurança. Pode enviar a informação por texto?'); return;
   }
  }
  if(latest.rows[0]?.type==='unsupported') { await this.setCapabilityReply(channel,job,'Nesta etapa, consigo conversar por texto e receber áudio. Pode escrever a sua dúvida?'); return; }
  const prepareStarted=this.clock();
  const payload=await this.prepare(channel,job);
  const preparedAt=this.clock();
  if(channel.kind==='laboratory'&&!await reserveLabBudget(this.store,this.config,channel,job,payload))return;
  const n8nStarted=this.clock();
  const response=await this.transport(this.config.N8N_WEBHOOK_URL,{method:'POST',headers:{Authorization:'Bearer '+this.config.N8N_WEBHOOK_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});
  if(!response.ok) throw new ServiceError('N8N_UNAVAILABLE',503);
  // The asynchronous webhook ACK is not the model/callback round trip. Store only durations.
  const backendTimings={attempt:job.attempts,preflightMs:Math.round(prepareStarted-dispatchStarted),prepareMs:Math.round(preparedAt-prepareStarted),...(channel.kind==='laboratory'?{budgetReservationMs:Math.round(n8nStarted-preparedAt)}:{}),n8nAckMs:Math.round(this.clock()-n8nStarted)};
  await scoped(this.store.db,channel,tx=>tx.query("UPDATE sdr.jobs SET state='running',context=COALESCE(context,'{}'::jsonb)||$4::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND state='working' AND attempts=$5",[...s,job.id,JSON.stringify({backendTimings}),job.attempts]));
 }
 private async setCapabilityReply(channel:Channel,job:JobRow,text:string) {
  await scoped(this.store.db,channel,async tx=>{
   const s=[channel.tenantId,channel.brandId];
   const updated=await tx.query("UPDATE sdr.jobs SET state=$5,result=$4,completed_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND state='working' RETURNING id",[...s,job.id,JSON.stringify({bubbles:[text],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}),channel.kind==='laboratory'?'completed':'ready']);
   if(channel.kind==='laboratory'&&updated.rows.length)await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'agent','text',$6,now()) ON CONFLICT DO NOTHING",[...s,job.id+':capability',job.conversation_id,job.candidate_id,text]);
  });
 }
 async complete(raw:unknown):Promise<{accepted:boolean,reason?:string}> {
  const completeStarted=this.clock();
  const input=CompletionSchema.parse(raw); const channel=await this.store.scopeForJob(input.jobId);
  return scoped(this.store.db,channel,async tx=>{
   const s=[channel.tenantId,channel.brandId];
   let job:Omit<JobRow,'result'|'context'>&{context?:unknown},conv:ConversationRow,candidate:{id:string,revision:number,lead_state?:unknown},version:{snapshot?:unknown};
   let rows:{id:string,text:string,actor:string,conversation_id:string,provider_timestamp:Date}[]|undefined;
   if(channel.kind==='laboratory') {
    const loaded=await new CompletionSnapshot(tx,channel).execute({jobId:input.jobId,contextVersion:input.contextVersion});
    if(!loaded.success) {
     if(loaded.error.code==='STALE_RESULT')return {accepted:false,reason:'STALE_RESULT'};
     if(loaded.error.code==='JOB_NOT_FOUND')throw new ServiceError('JOB_NOT_FOUND',404);
     throw new ServiceError('COMPLETION_SNAPSHOT_UNAVAILABLE',503);
    }
    ({job,conversation:conv,candidate,version,messages:rows}=loaded.data);
   } else {
    job=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,input.jobId])).rows[0];
    if(!job)throw new ServiceError('JOB_NOT_FOUND',404);
    conv=(await tx.query<ConversationRow>('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,job.conversation_id])).rows[0];
    candidate=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,job.candidate_id])).rows[0];
    if(!['working','running'].includes(job.state)||job.context_version!==input.contextVersion||candidate.revision!==job.context_version||conv.epoch!==job.epoch||conv.state!=='automatic'||job.deadline<new Date()) return {accepted:false,reason:'STALE_RESULT'};
    version=(await tx.query<{snapshot:unknown}>('SELECT snapshot FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,job.version_id])).rows[0];
   }
   const snapshot=SnapshotSchema.parse(version.snapshot);
   if(input.model&&input.model!==snapshot.model) throw new ServiceError('MODEL_MISMATCH',409);
   if(input.configVersion&&input.configVersion!==job.version_id) throw new ServiceError('VERSION_MISMATCH',409);
   const outputSchema=snapshot.outputContract==='financial-v2'?FinancialDecisionSchema:AgentDecisionSchema;
   if(!outputSchema.safeParse(input.result).success) throw new ServiceError('OUTPUT_CONTRACT_MISMATCH',409);
   const context=job.context as {sources:z.infer<typeof KnowledgeSourceSchema>[],backendTimings?:unknown} | null;
   const lead=LeadStateSchema.parse(candidate.lead_state);
   rows??=(await tx.query<{id:string,text:string,actor:string,conversation_id:string,provider_timestamp:Date}>('SELECT id,text,actor,conversation_id,provider_timestamp FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3',[...s,candidate.id])).rows;
   const trusted:TrustedMessage[]=rows.map(m=>({id:m.id,text:m.text,role:m.actor==='candidate'?'user':m.actor==='human'?'operator':'assistant',tenantId:channel.tenantId,brandId:channel.brandId,leadId:candidate.id,conversationId:m.conversation_id,createdAt:m.provider_timestamp.toISOString()}));
   const guardStarted=this.clock();
   const guardFunction=snapshot.outputContract==='financial-v2'?guardFinancialDecision:guardDecision;
   const {guard,originalGuard,repairCode}=guardQuestionReply({decision:input.result,tenant:snapshot.tenant,lead,sources:context?.sources??[],now:new Date().toISOString(),trustedMessages:trusted,conversationId:conv.id,latestMessageId:job.trigger_message_id,latestMessage:trusted.find(message=>message.id===job.trigger_message_id&&message.role==='user')?.text},guardFunction,channel.kind==='laboratory');
   let result=guard.ok?guard.decision:guard.safeDecision;
   const next=mergeFactProposals(lead,result.proposals,trusted);
   if(guard.ok)result=reconcileMemoryReply(result,lead,next);
   for(const relation of result.relations) if(hasTrustedEvidence(lead,relation.evidence,trusted)&&!next.relations.some(r=>r.id===relation.id)) next.relations.push(relation);
   if(result.referral&&hasTrustedEvidence(lead,result.referral.evidence,trusted)) next.referral=result.referral;
   next.status=result.nextAction==='continue'?'active':result.nextAction==='stop'?'stopped':result.nextAction==='handoff'?'handoff':'nurture';
   next.qualification=deriveQualification(next,snapshot.tenant);
   const persistenceStarted=this.clock();
   await tx.query('UPDATE sdr.candidates SET lead_state=$4,updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,candidate.id,JSON.stringify(next)]);
   await persistLeadMemory(tx,channel,candidate.id,next);
   const handoff=['handoff','stop'].includes(result.nextAction)||!guard.ok;
   // Laboratory replies and the terminal state commit together; no intermediate ready write is needed.
   await tx.query('UPDATE sdr.jobs SET state=$4,result=$5,usage=$6,completed_at=now(),error_code=$7 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,job.id,handoff?'handoff':channel.kind==='laboratory'?'completed':'ready',JSON.stringify(result),JSON.stringify(input.usage??{}),guard.ok?null:'POLICY_GUARD']);
   if(channel.kind==='laboratory'&&!originalGuard.ok)await tx.query("UPDATE sdr.jobs SET context=COALESCE(context,'{}'::jsonb)||$4::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,job.id,JSON.stringify({guardReview:{violations:originalGuard.violations,bubbles:input.result.bubbles,...(repairCode?{repairCode}:{})}})]);
   if(channel.kind==='laboratory'&&result.bubbles.length) {
    await tx.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp)
     SELECT $3||':reply:'||(reply_index-1),$1,$2,$4,$5,'agent','text',text,now()
     FROM jsonb_array_elements_text($6::jsonb) WITH ORDINALITY AS replies(text,reply_index) ORDER BY reply_index`,[...s,job.id,conv.id,candidate.id,JSON.stringify(result.bubbles)]);
   }
   if(handoff) {
    await tx.query('UPDATE sdr.conversations SET state=$4,epoch=epoch+1,updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,conv.id,result.nextAction==='stop'?'stopped':'human']);
    await this.store.briefTx(tx,channel,conv,result.handoffReason??'Revisão humana necessária',job.version_id);
   }
   // These monotonic intervals end before the event INSERT, budget settlement and COMMIT.
   // n8n reports its own HTTP/node interval; it is not pure model inference time.
   const storedTimings=StoredTimingsSchema.safeParse(context?.backendTimings);
   const {attempt:timingAttempt,...workerTimings}=storedTimings.success?storedTimings.data:{attempt:-1};
   const timings={backend:{...(timingAttempt===job.attempts?workerTimings:{}),completeReadMs:Math.round(guardStarted-completeStarted),guardMemoryMs:Math.round(persistenceStarted-guardStarted),persistBeforeEventMs:Math.round(this.clock()-persistenceStarted)},...(input.timings?{n8nReported:input.timings}:{})};
   await tx.query('INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($3,$1,$2,$4,$5,$6)',[...s,randomUUID(),conv.id,'turn_completed',JSON.stringify({jobId:job.id,versionId:job.version_id,guardPassed:guard.ok,...(!guard.ok?{guardViolations:guard.violations}:{}),...(repairCode&&!originalGuard.ok?{modelGuardPassed:false,originalGuardViolations:originalGuard.violations,replyRepair:repairCode}:{}),timings})]);
   if(channel.kind==='laboratory')await settleLabBudget(tx,channel,job.id,input.model,input.usage);
   return {accepted:true};
  });
 }
}
