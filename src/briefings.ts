import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Config } from './config.js';
import { scoped } from './database.js';
import { Store, type Channel, type CandidateRow } from './store.js';
import { BRIEFING_PROMPT } from './prompts.js';
import { LeadStateSchema } from './domain.js';
import { ServiceError } from './security.js';
import { UsageSchema } from './usage.js';

const BriefSchema=z.object({summary:z.string().min(1).max(2000),gaps:z.array(z.string()).max(20),objections:z.array(z.string()).max(20),suggestedQuestions:z.array(z.string()).max(10),factIds:z.array(z.string()).max(100)}).strict();
const CallbackSchema=z.object({jobId:z.string(),contextVersion:z.number().int(),configVersion:z.string(),result:BriefSchema,model:z.string(),usage:UsageSchema.optional()}).strict();
export class Briefings {
 constructor(private store:Store,private config:Config,private transport:typeof fetch=fetch) {}
 async dispatch(channel:Channel):Promise<void> {
  if(channel.kind==='laboratory')return;
  const s=[channel.tenantId,channel.brandId];
  const prepared=await scoped(this.store.db,channel,async tx=>{
   await tx.query("UPDATE sdr.briefings SET model_status='failed',data=data||'{\"pendingModelBriefing\":false,\"modelBriefingError\":\"PROCESSING_TIMEOUT\"}'::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND split_part(id,':',1)=$3 AND model_status='running' AND model_deadline<now()",[...s,channel.phoneNumberId]);
   const b=(await tx.query<{id:string,conversation_id:string,version_id:string|null,context_version:number}>("UPDATE sdr.briefings SET model_status='running',model_deadline=now()+interval '60 seconds' WHERE id=(SELECT id FROM sdr.briefings WHERE tenant_id=$1 AND brand_id=$2 AND split_part(id,':',1)=$3 AND model_status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",[...s,channel.phoneNumberId])).rows[0];
   if(!b)return;
   const lead=(await tx.query<CandidateRow>('SELECT p.* FROM sdr.candidates p JOIN sdr.conversations c ON (p.tenant_id,p.brand_id,p.id)=(c.tenant_id,c.brand_id,c.candidate_id) WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.id=$3',[...s,b.conversation_id])).rows[0];
   const state=LeadStateSchema.parse(lead.lead_state);
   const messages=(await tx.query('SELECT id,text,actor FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3 ORDER BY provider_timestamp DESC LIMIT 24',[...s,lead.id])).rows;
   const context={lead:state,messages,referralStatus:'human_requested',qualification:state.qualification};
   await tx.query('UPDATE sdr.briefings SET model_context=$4,context_version=$5 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,b.id,JSON.stringify(context),lead.revision]);
   return {task:'briefing',jobId:b.id,contextVersion:lead.revision,configVersion:b.version_id??'unversioned',model:'gpt-5-mini',instructions:BRIEFING_PROMPT,context,outputSchema:zodToJsonSchema(BriefSchema,{$refStrategy:'none'}),callbackUrl:this.config.PUBLIC_API_URL.replace(/\/$/,'')+'/internal/n8n/briefings/'+encodeURIComponent(b.id)+'/complete'};
  });
  if(!prepared)return;
  try {
   const r=await this.transport(this.config.N8N_WEBHOOK_URL,{method:'POST',headers:{Authorization:'Bearer '+this.config.N8N_WEBHOOK_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(prepared),signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw new Error('upstream');
  } catch {await scoped(this.store.db,channel,tx=>tx.query("UPDATE sdr.briefings SET model_status='failed',data=data||'{\"pendingModelBriefing\":false,\"modelBriefingError\":\"ORCHESTRATOR_UNAVAILABLE\"}'::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,prepared.jobId]));}
 }
 async complete(raw:unknown) {
  const input=CallbackSchema.parse(raw);const channel=await this.store.scopeForJob(input.jobId);
  if(!/^gpt-5-mini(?:-\d{4}-\d{2}-\d{2})?$/.test(input.model))throw new ServiceError('BRIEFING_MODEL_MISMATCH',409);
  return scoped(this.store.db,channel,async tx=>{
   const s=[channel.tenantId,channel.brandId];
   const b=(await tx.query<{model_status:string,context_version:number,version_id:string,conversation_id:string,model_context:{lead:z.infer<typeof LeadStateSchema>},model_deadline:Date}>('SELECT * FROM sdr.briefings WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,input.jobId])).rows[0];
   if(!b||b.model_status!=='running'||b.context_version!==input.contextVersion||b.version_id!==input.configVersion||b.model_deadline<new Date())return {accepted:false};
   const current=(await tx.query<{revision:number}>('SELECT p.revision FROM sdr.candidates p JOIN sdr.conversations c ON (p.tenant_id,p.brand_id,p.id)=(c.tenant_id,c.brand_id,c.candidate_id) WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.id=$3',[...s,b.conversation_id])).rows[0];
   if(current.revision!==b.context_version){await tx.query("UPDATE sdr.briefings SET model_status='stale',data=data||'{\"pendingModelBriefing\":false,\"modelBriefingError\":\"CONTEXT_CHANGED\"}'::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,input.jobId]);return {accepted:false};}
   if(input.result.factIds.some(id=>!b.model_context.lead.facts.some(f=>f.id===id)))throw new ServiceError('BRIEFING_UNKNOWN_FACT',409);
   // The briefing never writes facts or priority; these remain deterministic, sourced records.
   await tx.query("UPDATE sdr.briefings SET model_status='complete',usage=$4,data=data||$5::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,input.jobId,JSON.stringify(input.usage??{}),JSON.stringify({...input.result,priority:b.model_context.lead.qualification.priority,generation:'model',model:input.model,pendingModelBriefing:false,requiresHumanReview:true})]);
   return {accepted:true};
  });
 }
}
