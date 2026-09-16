import { createHash, randomUUID } from 'node:crypto';
import type { Database, Queryable, Scope } from './database.js';
import { scoped } from './database.js';
import { createLeadState, detectControlIntent, LeadStateSchema, type LeadState, type AgentDecision,isResetCommand} from './domain.js';
import type { IncomingMessage, TurnInput, TurnView } from './contracts.js';
import { ServiceError } from './security.js';

export type Channel = Scope & { phoneNumberId:string; enabled:boolean; responsibleUserId:string|null; kind?:'whatsapp'|'laboratory' };
export type ControlEvidence = { providerOccurredAt?:string; providerSource:'native_execution'|'signed_webhook' };
function providerTime(value:unknown):number|undefined {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return;
 const time=Date.parse(value);return Number.isFinite(time)&&time<=Date.now()?time:undefined;
}
export interface JobRow {
 id:string; tenant_id:string; brand_id:string; conversation_id:string; candidate_id:string;
 context_version:number; epoch:number; version_id:string; state:string; result:AgentDecision|null;trigger_message_id:string;
 error_code:string|null; created_at:Date; deadline:Date; context:unknown; attempts:number;
}
export interface ConversationRow {
 id:string; candidate_id:string; phone_number_id:string; state:string; epoch:number;
 execution_id:string|null; control_fingerprint:string|null; last_inbound_at:Date|null;
}
export interface CandidateRow { id:string; lead_state:LeadState; revision:number; label:string; contact_id:string;authorized_contact_id:string; reset_at:Date|string|null }
export const digest = (value:string) => createHash('sha256').update(value).digest('hex');

export class Store {
 constructor(public db:Database) {}
 async channel(phoneNumberId:string):Promise<Channel> {
   const {rows} = await this.db.query<{phone_number_id:string,tenant_id:string,brand_id:string,enabled:boolean,responsible_user_id:string|null,kind:'whatsapp'|'laboratory'}>('SELECT * FROM sdr.channels WHERE phone_number_id=$1',[phoneNumberId]);
   if (!rows[0]) throw new ServiceError('CHANNEL_NOT_CONFIGURED',404);
   return {phoneNumberId,tenantId:rows[0].tenant_id,brandId:rows[0].brand_id,enabled:rows[0].enabled,responsibleUserId:rows[0].responsible_user_id,kind:rows[0].kind};
 }
 async scopeForJob(id:string):Promise<Channel> { return this.channel(id.split(':')[0]); }
 async channels():Promise<Channel[]> {
   const {rows} = await this.db.query<{phone_number_id:string,tenant_id:string,brand_id:string,enabled:boolean,responsible_user_id:string|null,kind:'whatsapp'|'laboratory'}>('SELECT phone_number_id,tenant_id,brand_id,enabled,responsible_user_id,kind FROM sdr.channels');
   return rows.map(row=>({phoneNumberId:row.phone_number_id,tenantId:row.tenant_id,brandId:row.brand_id,enabled:row.enabled,responsibleUserId:row.responsible_user_id,kind:row.kind}));
 }
 async ingest(input:TurnInput):Promise<{channel:Channel,accepted:boolean,reset?:boolean}> {
   const channel = await this.channel(input.phoneNumberId);
   return scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId];
     const tester=(await tx.query<{label:string,contact_id:string}>(`SELECT label,contact_id FROM sdr.testers WHERE tenant_id=$1 AND brand_id=$2 AND enabled AND (contact_id=$3 OR contact_id=$4)`,[...s,input.contactId,input.contactPhone??''])).rows[0];
     if(!tester) return {channel,accepted:false}; // No unapproved contact content is retained.
     const id=randomUUID();
     await tx.query(`INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,label,lead_state,authorized_contact_id) VALUES($3,$1,$2,$4,$5,$6,$7) ON CONFLICT(tenant_id,brand_id,contact_id) DO NOTHING`,[...s,id,input.contactId,tester.label,JSON.stringify(createLeadState(channel.tenantId,channel.brandId,id)),tester.contact_id]);
     const candidate=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND contact_id=$3 FOR UPDATE',[...s,input.contactId])).rows[0];
     await tx.query(`INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id,execution_id,control_fingerprint) VALUES($3,$1,$2,$4,$5,$6,$7) ON CONFLICT(tenant_id,brand_id,id) DO NOTHING`,[...s,input.conversationId,candidate.id,input.phoneNumberId,input.executionId??null,input.controlFingerprint??null]);
     const conv=(await tx.query<ConversationRow>('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,input.conversationId])).rows[0];
     if(conv.candidate_id!==candidate.id || conv.phone_number_id!==input.phoneNumberId) throw new ServiceError('IDENTITY_MISMATCH',409);
     // A reset needs the conversation row to exist (it may be the first message of a new conversation) so the
     // confirmation can be recorded there; the Kapso Decide can replay the same message, so one command resets once.
     if(isResetCommand(input.text)) {
       const first=await tx.query('INSERT INTO sdr.webhook_receipts(id,payload_hash) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',[digest(`reset:${channel.tenantId}:${channel.brandId}:${input.messageId}`),'reset']);
       if(!first.rows.length) return {channel,accepted:false};
       await this.resetTesterTx(tx,channel,input.contactId); return {channel,accepted:false,reset:true};
     }
     if(input.executionId&&conv.execution_id===null) {
       await tx.query('UPDATE sdr.conversations SET execution_id=$4,control_fingerprint=$5 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,conv.id,input.executionId,input.controlFingerprint??null]);
     } else if(input.executionId&&conv.execution_id!==input.executionId) {
       // A timed-out/human-paused thread can bind a fresh running native execution. A live automatic owner cannot.
       if(conv.state!=='human') throw new ServiceError('NATIVE_OWNER_CHANGED',409);
       await this.controlTx(tx,channel,conv.id,'resume',input.executionId+':running-retry',input.executionId,input.controlFingerprint);
     }
     const messages:IncomingMessage[]=[...input.messages];
     if(!messages.some(m=>m.id===input.messageId)) messages.push({id:input.messageId,text:input.audio?.transcript??input.text,type:input.audio?'audio':'text',actor:'candidate',mediaId:input.audio?.mediaId,transcriptOrigin:input.audio?.transcript?'kapso':undefined});
     messages.sort((a,b)=>(a.timestamp??'').localeCompare(b.timestamp??''));
     const triggerTime=Date.parse(messages.find(message=>message.id===input.messageId)?.timestamp??'')||Date.now();
     for(const message of messages) {
       // The history API may not identify the sender. Only an already reconciled provider ID
       // can turn an unknown outbound actor into our agent; matching text alone is insufficient.
       if(message.actor==='human'&&(await tx.query('SELECT job_id FROM sdr.deliveries WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND message_id=$4',[...s,input.conversationId,message.id])).rows.length) message.actor='agent';
       const timestamp=message.timestamp??new Date().toISOString();
       // Provider history replays older turns; nothing before a tester reset (nor the command itself) is re-ingested.
       if(candidate.reset_at&&Date.parse(timestamp)<=new Date(candidate.reset_at).getTime())continue;
       if(message.actor==='candidate'&&isResetCommand(message.text))continue;
       if(Date.parse(timestamp)<Date.now()-30*86400000)continue;
       if(Date.parse(timestamp)>Date.now()+60_000) throw new ServiceError('FUTURE_MESSAGE',400);
       const inserted=await tx.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,media_id,transcript_origin,provider_timestamp) VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,[...s,message.id,input.conversationId,candidate.id,message.actor,message.type,message.text,message.mediaId??null,message.transcriptOrigin??null,timestamp]);
       if(!inserted.rows.length) continue;
       if(message.actor!=='agent') {
         await tx.query('UPDATE sdr.candidates SET revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,candidate.id]);
         await tx.query("UPDATE sdr.jobs SET state='stale',error_code='CONTEXT_CHANGED' WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3 AND state IN ('pending','working','running','ready')",[...s,candidate.id]);
       }
       if(message.actor==='candidate') {
         await tx.query('UPDATE sdr.conversations SET last_inbound_at=GREATEST(last_inbound_at,$4::timestamptz),updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,input.conversationId,timestamp]);
         const intent=detectControlIntent(message.text);
         if(intent) await this.controlTx(tx,channel,input.conversationId,intent==='stop'?'stop':'handoff',message.id);
       }
       // History backfill of old outbound/templates is not a live operator takeover.
       if(message.actor==='human' && Date.parse(timestamp)>=triggerTime-120_000) await this.controlTx(tx,channel,input.conversationId,'handoff',message.id);
     }
     return {channel,accepted:true};
   });
 }
 /** The reset confirmation is an agent message from the start, so provider history replays it as known, never as a human takeover. */
 async recordResetConfirmation(channel:Channel,conversationId:string,contactId:string,messageId:string,text:string):Promise<void> {
   await scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId];
     const candidate=(await tx.query<{id:string}>('SELECT id FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND contact_id=$3',[...s,contactId])).rows[0];
     const conversation=(await tx.query<{id:string}>('SELECT id FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,conversationId])).rows[0];
     if(!candidate||!conversation) return;
     await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'agent','text',$6,now()) ON CONFLICT DO NOTHING",[...s,messageId,conversationId,candidate.id,text]);
     await tx.query('UPDATE sdr.candidates SET reset_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,candidate.id]);
   });
 }
 /** Tester-only. Conversations stay (the native binding remains valid); everything the candidate said or received goes, and the lead state restarts. */
 private async resetTesterTx(tx:Queryable,channel:Channel,contactId:string):Promise<void> {
   const s=[channel.tenantId,channel.brandId];
   const candidate=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND contact_id=$3 FOR UPDATE',[...s,contactId])).rows[0];
   if(!candidate) return;
   await tx.query('DELETE FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3',[...s,candidate.id]);
   await tx.query('DELETE FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3',[...s,candidate.id]);
   await tx.query('DELETE FROM sdr.briefings WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id IN (SELECT id FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3)',[...s,candidate.id]);
   await tx.query('DELETE FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id IN (SELECT id FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3)',[...s,candidate.id]);
   await tx.query("UPDATE sdr.conversations SET state='automatic',updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3",[...s,candidate.id]);
   await tx.query('DELETE FROM sdr.facts WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3',[...s,candidate.id]);
   await tx.query('DELETE FROM sdr.relations WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3',[...s,candidate.id]);
   await tx.query('UPDATE sdr.candidates SET lead_state=$4,revision=revision+1,reset_at=now(),updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,candidate.id,JSON.stringify(createLeadState(channel.tenantId,channel.brandId,candidate.id))]);
 }
 async startTurn(input:TurnInput):Promise<TurnView> {
   const {channel,accepted,reset}=await this.ingest(input);
   if(!accepted) return {id:'',state:'ignored',reply:[],contextVersion:0,...(reset?{reset:true}:{})};
   return scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId];
     const conv=(await tx.query<ConversationRow>('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,input.conversationId])).rows[0];
     let lead=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,conv.candidate_id])).rows[0];
     if(!(await tx.query('SELECT id FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND id=$4',[...s,conv.id,input.messageId])).rows.length)return {id:'',state:'ignored',reply:[],contextVersion:lead.revision};
     if(conv.state!=='automatic') return {id:'',state:conv.state==='stopped'?'ignored':'handoff',reply:[],contextVersion:lead.revision};
     // Native running + automatic thread owns the turn. A prior timeout must not keep the lead in handoff.
     if(LeadStateSchema.parse(lead.lead_state).status==='handoff') {
       await tx.query("UPDATE sdr.candidates SET lead_state=jsonb_set(jsonb_set(lead_state,'{status}',to_jsonb('active'::text)),'{qualification,priority}',to_jsonb('qualifying'::text)),updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,lead.id]);
       lead=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,lead.id])).rows[0];
     }
     const active=(await tx.query<{version_id:string}>('SELECT version_id FROM sdr.active_versions WHERE tenant_id=$1 AND brand_id=$2',s)).rows[0];
     if(!active) throw new ServiceError('NO_ACTIVE_VERSION',503);
     const id=channel.phoneNumberId+':'+randomUUID();
     await tx.query(`INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,deadline) VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,now()+($10::int * interval '1 second')) ON CONFLICT DO NOTHING`,[...s,id,conv.id,lead.id,input.messageId,lead.revision,conv.epoch,active.version_id,channel.kind==='laboratory'?60:180]);
     const job=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND trigger_message_id=$4 AND epoch=$5',[...s,conv.id,input.messageId,conv.epoch])).rows[0];
     return this.view(job);
   });
 }
 view(job:JobRow):TurnView {
   // `dispatching` is the API sending right now: callers must poll, not treat it as an ambiguous native send.
   const state:TurnView['state']= ['pending','working','running','dispatching'].includes(job.state)?'pending':job.state==='dispatched'?'unknown':job.state as TurnView['state'];
   return {id:job.id,state,reply:state==='ready'?job.result?.bubbles??[]:[],contextVersion:job.context_version,...(job.error_code?{errorCode:job.error_code}:{})};
 }
 /** The native execution a conversation is bound to, as recorded at ingest; null until the first bound turn. */
 async nativeBinding(id:string):Promise<{executionId:string,controlFingerprint:string}|null> {
   const channel=await this.scopeForJob(id);
   return scoped(this.db,channel,async tx=>{
     const row=(await tx.query<{execution_id:string|null,control_fingerprint:string|null}>('SELECT c.execution_id,c.control_fingerprint FROM sdr.jobs j JOIN sdr.conversations c ON c.tenant_id=j.tenant_id AND c.brand_id=j.brand_id AND c.id=j.conversation_id WHERE j.tenant_id=$1 AND j.brand_id=$2 AND j.id=$3',[channel.tenantId,channel.brandId,id])).rows[0];
     return row?.execution_id&&row.control_fingerprint?{executionId:row.execution_id,controlFingerprint:row.control_fingerprint}:null;
   });
 }
 async getJob(id:string):Promise<{channel:Channel,job:JobRow}> {
   const channel=await this.scopeForJob(id);
   return scoped(this.db,channel,async tx=>{
     const job=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[channel.tenantId,channel.brandId,id])).rows[0];
     if(!job) throw new ServiceError('JOB_NOT_FOUND',404);
     return {channel,job};
   });
 }
 async control(channel:Channel,conversationId:string,event:'handoff'|'resume'|'stop',eventId:string,executionId?:string,fingerprint?:string,evidence?:ControlEvidence):Promise<void> {
   return scoped(this.db,channel,tx=>this.controlTx(tx,channel,conversationId,event,eventId,executionId,fingerprint,evidence));
 }
 async controlTx(tx:Queryable,scope:Scope,id:string,event:'handoff'|'resume'|'stop',eventId:string,executionId?:string,fingerprint?:string,evidence?:ControlEvidence):Promise<void> {
   const s=[scope.tenantId,scope.brandId];
   const conv=(await tx.query<ConversationRow>('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,id])).rows[0];
   if(!conv) return;
   const occurredAt=providerTime(evidence?.providerOccurredAt);
   const detail={executionId,fingerprint,...(occurredAt!==undefined?{
    providerOccurredAt:new Date(occurredAt).toISOString(),providerSource:evidence!.providerSource,
   }:{})};
   const eventKey=digest(s.join(':')+id+event+eventId);
   // Only provider-native event time can prove ordering. Receipt time and UUID order cannot.
   if(event==='handoff'&&evidence?.providerSource==='signed_webhook'&&occurredAt!==undefined&&executionId&&conv.execution_id===executionId) {
    const resumes=(await tx.query<{detail:{providerOccurredAt?:string}}>("SELECT detail FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND type='resume' AND detail->>'executionId'=$4 AND detail->>'providerSource'='native_execution'",[...s,id,executionId])).rows;
    const resumedAt=resumes.map(row=>providerTime(row.detail.providerOccurredAt)).filter((time):time is number=>time!==undefined);
    const laterResume=resumedAt.find(time=>time>occurredAt);
    if(laterResume!==undefined) {
     await tx.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($3,$1,$2,$4,'handoff_ignored_stale',$5) ON CONFLICT DO NOTHING",[...s,eventKey,id,JSON.stringify({...detail,supersededByNativeResumeAt:new Date(laterResume).toISOString()})]);
     return;
    }
   }
   const inserted=await tx.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($3,$1,$2,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",[...s,eventKey,id,event,JSON.stringify(detail)]);
   if(!inserted.rows.length) return;
   if(conv.state==='stopped'&&event==='handoff') return; // A fallback handoff cannot reopen an opt-out.
   // A stop requires an explicit new consent workflow, not the generic resume control.
   if(conv.state==='stopped'&&event==='resume') throw new ServiceError('EXPLICIT_RECONSENT_REQUIRED',409);
   const state=event==='resume'?'automatic':event==='stop'?'stopped':'human';
   await tx.query('UPDATE sdr.conversations SET state=$4,epoch=epoch+1,execution_id=COALESCE($5,execution_id),control_fingerprint=COALESCE($6,control_fingerprint),updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,id,state,executionId??null,fingerprint??null]);
   await tx.query("UPDATE sdr.candidates SET revision=revision+1,updated_at=now(),lead_state=jsonb_set(jsonb_set(lead_state,'{status}',to_jsonb($4::text)),'{qualification,priority}',to_jsonb($5::text)) WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,conv.candidate_id,event==='resume'?'active':event==='stop'?'stopped':'handoff',event==='resume'?'qualifying':'review']);
   await tx.query("UPDATE sdr.jobs SET state='stale',error_code='HUMAN_CONTROL_CHANGED' WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3 AND state IN ('pending','working','running','ready')",[...s,conv.candidate_id]);
   if(event!=='resume') await this.briefTx(tx,scope,conv,event==='stop'?'Interrupção solicitada pelo testador.':'Transferência para atendimento humano.');
 }
 async briefTx(tx:Queryable,scope:Scope,conv:ConversationRow,reason:string,versionId?:string):Promise<void> {
   const s=[scope.tenantId,scope.brandId];
   const lead=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,conv.candidate_id])).rows[0];
   const state=LeadStateSchema.parse(lead.lead_state);
   const data={summary:reason,priority:'review',gaps:state.qualification.missingFields,objections:[],suggestedQuestions:[],facts:state.facts,generation:'deterministic',pendingModelBriefing:true};
   const lab=(await tx.query<{version_id:string}>('SELECT version_id FROM sdr.lab_sessions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,conv.id])).rows[0];
   const active=versionId??lab?.version_id??(await tx.query<{version_id:string}>('SELECT version_id FROM sdr.active_versions WHERE tenant_id=$1 AND brand_id=$2',s)).rows[0]?.version_id??null;
   await tx.query('INSERT INTO sdr.briefings(id,tenant_id,brand_id,conversation_id,version_id,data,context_version,assignment_status) VALUES($3,$1,$2,$4,$5,$6,$7,$8)',[...s,conv.phone_number_id+':'+randomUUID(),conv.id,active,JSON.stringify(data),lead.revision,lab?'not_applicable':'pending']);
 }
 async claim(channel:Channel):Promise<JobRow|undefined> {
   return scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId,channel.phoneNumberId];
     const expired=(await tx.query<JobRow>("UPDATE sdr.jobs SET state='handoff',error_code='PROCESSING_TIMEOUT',completed_at=COALESCE(completed_at,now()) WHERE tenant_id=$1 AND brand_id=$2 AND split_part(id,':',1)=$3 AND state IN ('pending','working','running','ready') AND deadline<now() RETURNING *",s)).rows;
     for(const job of expired) await this.controlTx(tx,channel,job.conversation_id,'handoff',job.id+':timeout');
     // A committed reservation precedes every lab POST. The scope lock serializes this
     // observation with dispatch preparation, including an ambiguous COMMIT outcome.
     const unreserved=channel.kind==='laboratory'?`AND NOT EXISTS (SELECT 1 FROM sdr.events e WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.type='lab_model_budget_reserved' AND e.detail->>'jobId'=j.id)`:'';
     return (await tx.query<JobRow>(`UPDATE sdr.jobs SET state='working',attempts=attempts+1,lease_until=now()+interval '15 seconds' WHERE id=(SELECT j.id FROM sdr.jobs j WHERE tenant_id=$1 AND brand_id=$2 AND split_part(id,':',1)=$3 AND (state='pending' OR (state='working' AND lease_until<now())) AND available_at<=now() AND deadline>now() ${unreserved} ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,s)).rows[0];
   });
 }
 async authorize(id:string,executionId:string,fingerprint:string):Promise<TurnView> {
   const channel=await this.scopeForJob(id);
   return scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId];
     const job=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,id])).rows[0];
     if(!job) throw new ServiceError('JOB_NOT_FOUND',404);
     const conv=(await tx.query<ConversationRow>('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,job.conversation_id])).rows[0];
     const lead=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[...s,job.candidate_id])).rows[0];
     const authorizedTester=(await tx.query('SELECT contact_id FROM sdr.testers WHERE tenant_id=$1 AND brand_id=$2 AND contact_id=$3 AND enabled',[...s,lead.authorized_contact_id])).rows.length>0;
     const currentVersion=(await tx.query<{version_id:string}>('SELECT version_id FROM sdr.active_versions WHERE tenant_id=$1 AND brand_id=$2',s)).rows[0]?.version_id;
     const valid=authorizedTester&&currentVersion===job.version_id&&job.state==='ready'&&conv.state==='automatic'&&lead.revision===job.context_version&&conv.epoch===job.epoch&&conv.execution_id===executionId&&conv.control_fingerprint===fingerprint&&job.deadline>new Date()&&!!conv.last_inbound_at&&Date.now()-conv.last_inbound_at.getTime()<86400000;
     if(!valid) return {...this.view(job),reply:[],authorized:false,state:conv.state==='human'?'handoff':job.state==='ready'?'stale':this.view(job).state};
     await tx.query("INSERT INTO sdr.deliveries(job_id,tenant_id,brand_id,conversation_id,text_hash) VALUES($3,$1,$2,$4,$5)",[...s,id,conv.id,digest(job.result!.bubbles.join('\n\n'))]);
     await tx.query("UPDATE sdr.jobs SET state='dispatching' WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,id]);
     return {...this.view(job),authorized:true};
   });
 }
 async dispatched(id:string):Promise<void> {
   const channel=await this.scopeForJob(id);
   await scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId,id];
     await tx.query("UPDATE sdr.jobs SET state='dispatched' WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND state='dispatching'",s);
     await tx.query("UPDATE sdr.deliveries SET state='unknown',updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND job_id=$3 AND state='dispatching'",s);
   });
 }
 /** Fase 2: after Kapso Messages API send, bind WAMID immediately and mark job sent. */
 /** An API-sent WAMID is an agent message from the start; history replay then cannot infer a human takeover from it. */
 async recordAgentMessage(id:string,messageId:string,text:string):Promise<void> {
   const channel=await this.scopeForJob(id);
   await scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId];
     const job=(await tx.query<Pick<JobRow,'conversation_id'|'candidate_id'>>('SELECT conversation_id,candidate_id FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,id])).rows[0];
     if(!job) return;
     await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'agent','text',$6,now()) ON CONFLICT DO NOTHING",[...s,messageId,job.conversation_id,job.candidate_id,text]);
   });
 }
 async confirmApiSend(id:string,messageId:string):Promise<TurnView> {
   const channel=await this.scopeForJob(id);
   return scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId,id];
     const job=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',s)).rows[0];
     if(!job) throw new ServiceError('JOB_NOT_FOUND',404);
     if(!['dispatching','dispatched'].includes(job.state)) return this.view(job);
     await tx.query("UPDATE sdr.deliveries SET message_id=$4,state='sent',updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND job_id=$3 AND state IN ('dispatching','unknown')", [...s,messageId]);
     await tx.query("UPDATE sdr.jobs SET state='sent',completed_at=COALESCE(completed_at,now()) WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND state IN ('dispatching','dispatched')",s);
     const updated=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',s)).rows[0];
     return {...this.view(updated),authorized:true,reply:[]};
   });
 }
 async failApiSend(id:string,errorCode='DELIVERY_FAILED'):Promise<TurnView> {
   const channel=await this.scopeForJob(id);
   return scoped(this.db,channel,async tx=>{
     const s=[channel.tenantId,channel.brandId,id];
     const job=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',s)).rows[0];
     if(!job) throw new ServiceError('JOB_NOT_FOUND',404);
     await tx.query("UPDATE sdr.deliveries SET state='failed',updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND job_id=$3 AND state IN ('dispatching','unknown')",s);
     await tx.query("UPDATE sdr.jobs SET state='handoff',error_code=$4,completed_at=COALESCE(completed_at,now()) WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND state IN ('dispatching','dispatched','ready')",[...s,errorCode]);
     const conv=(await tx.query<ConversationRow>('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[channel.tenantId,channel.brandId,job.conversation_id])).rows[0];
     if(conv) await this.controlTx(tx,channel,conv.id,'handoff',id+':delivery-failed');
     const updated=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',s)).rows[0];
     return {...this.view(updated),authorized:false,reply:[],errorCode};
   });
 }
 async recipientHint(id:string):Promise<{phoneNumberId:string;contactId:string;authorizedContactId:string}> {
   const channel=await this.scopeForJob(id);
   return scoped(this.db,channel,async tx=>{
     const job=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[channel.tenantId,channel.brandId,id])).rows[0];
     if(!job) throw new ServiceError('JOB_NOT_FOUND',404);
     const lead=(await tx.query<CandidateRow>('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[channel.tenantId,channel.brandId,job.candidate_id])).rows[0];
     return {phoneNumberId:channel.phoneNumberId,contactId:lead.contact_id,authorizedContactId:lead.authorized_contact_id};
   });
 }
}
