import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scoped, type Database, type Queryable } from './database.js';
import type { LabIdentity } from './lab.js';
import { createLeadState, detectControlIntent } from './domain.js';
import { Store } from './store.js';
import { attempt, ServiceError } from './security.js';
import { SnapshotSchema } from './engine.js';
import { snapshotHash } from './versioning.js';
import { CampaignAdmissionRequestSchema, CampaignAdmissionSchema, CampaignAdmissionMarkerSchema } from './campaign-admission.spec.js';

const CreateInput=z.object({requestId:z.string().uuid(),label:z.string().trim().min(1).max(80),scenario:z.enum(['free','investment','correction','human'])}).strict();
const EvaluationInput=CreateInput.extend({versionId:z.string().min(1).max(200),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const MessageInput=z.object({requestId:z.string().uuid(),text:z.string().trim().min(1).max(4000),campaignAdmission:CampaignAdmissionRequestSchema.optional()}).strict();
const Session=z.object({id:z.string(),candidateId:z.string(),label:z.string(),scenario:z.string(),versionId:z.string(),state:z.string()});
const columns=`l.id,l.candidate_id AS "candidateId",l.label,l.scenario,l.version_id AS "versionId",c.state`;
const initialGreeting='Olá! Sou o assistente virtual de expansão da Sapore Açaí. Em qual cidade você pensa em abrir a operação?';
export class LabSessions {
 constructor(private db:Database) {}
 private async owned(tx:Queryable,user:LabIdentity,id:string,requireEvaluationAdmin=false) {
  const row=(await tx.query<{evaluation_allowed:boolean}>(`SELECT ${columns},
   CASE WHEN $5::boolean THEN
    NOT EXISTS(SELECT 1 FROM sdr.events e WHERE e.tenant_id=l.tenant_id AND e.brand_id=l.brand_id AND e.conversation_id=l.id AND e.type='lab_evaluation_session_created')
    OR EXISTS(SELECT 1 FROM sdr.memberships m WHERE m.tenant_id=l.tenant_id AND m.brand_id=l.brand_id AND m.user_id=l.owner_user_id AND m.active AND m.role='admin')
   ELSE true END AS evaluation_allowed
   FROM sdr.lab_sessions l JOIN sdr.conversations c USING(tenant_id,brand_id,id) WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.owner_user_id=$3 AND l.id=$4`,[user.tenantId,user.brandId,user.userId,id,requireEvaluationAdmin])).rows[0];
  if(!row) throw new ServiceError('SESSION_NOT_FOUND',404);
  if(!row.evaluation_allowed)throw new ServiceError('FORBIDDEN',403);
  return Session.parse(row);
 }
 create(user:LabIdentity,raw:unknown) {return this.createSession(user,raw,false);}
 createEvaluation(user:LabIdentity,raw:unknown) {return this.createSession(user,raw,true);}
 private createSession(user:LabIdentity,raw:unknown,evaluation:boolean) {return attempt(async()=>{
  const selected=evaluation?EvaluationInput.safeParse(raw):null;
  const input=selected??CreateInput.safeParse(raw);if(!input.success)throw new ServiceError('INVALID_CONTRACT');
  const data=input.data;
  return scoped(this.db,user,async tx=>{
   const s=[user.tenantId,user.brandId];
   let pinnedVersion:string|undefined;
   if(selected?.success){
    const target=selected.data;
    // Authenticate again under the same scope lock: a caller-supplied role is not authority.
    const membership=(await tx.query<{role:string}>('SELECT role FROM sdr.memberships WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3 AND active',[...s,user.userId])).rows[0];
    if(membership?.role!=='admin')throw new ServiceError('FORBIDDEN',403);
    const draft=(await tx.query<{snapshot:unknown,draft_snapshot:unknown}>(`SELECT v.snapshot,d.snapshot AS draft_snapshot
     FROM sdr.drafts d JOIN sdr.versions v ON (v.tenant_id,v.brand_id,v.id,v.content_hash)=(d.tenant_id,d.brand_id,d.version_id,d.content_hash)
     WHERE d.tenant_id=$1 AND d.brand_id=$2 AND d.version_id=$3 AND d.content_hash=$4`,[...s,target.versionId,target.contentHash])).rows[0];
    if(!draft)throw new ServiceError('EVALUATION_DRAFT_MISMATCH',409);
    for(const rawSnapshot of [draft.snapshot,draft.draft_snapshot]){
     const parsed=SnapshotSchema.safeParse(rawSnapshot);
     if(!parsed.success||parsed.data.tenant.tenantId!==user.tenantId||parsed.data.tenant.brandId!==user.brandId||snapshotHash(parsed.data)!==target.contentHash)throw new ServiceError('INVALID_DRAFT',409);
    }
    pinnedVersion=target.versionId;
   }
   const prior=(await tx.query<{id:string,label:string,scenario:string,version_id:string,evaluation_session:boolean}>(`SELECT l.id,l.label,l.scenario,l.version_id,
    EXISTS(SELECT 1 FROM sdr.events e WHERE e.tenant_id=l.tenant_id AND e.brand_id=l.brand_id AND e.conversation_id=l.id AND e.type='lab_evaluation_session_created') AS evaluation_session
    FROM sdr.lab_sessions l WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.owner_user_id=$3 AND l.request_id=$4`,[...s,user.userId,data.requestId])).rows[0];
   if(prior){if(prior.label!==data.label||prior.scenario!==data.scenario||prior.evaluation_session!==evaluation||(pinnedVersion!==undefined&&prior.version_id!==pinnedVersion))throw new ServiceError('REQUEST_CONFLICT');return this.owned(tx,user,prior.id);}
   const version=pinnedVersion?{version_id:pinnedVersion}:(await tx.query<{version_id:string}>('SELECT version_id FROM sdr.active_versions WHERE tenant_id=$1 AND brand_id=$2',s)).rows[0];
   const channel=(await tx.query<{phone_number_id:string}>("SELECT phone_number_id FROM sdr.channels WHERE tenant_id=$1 AND brand_id=$2 AND kind='laboratory'",s)).rows[0];
   if(!version||!channel)throw new ServiceError('LAB_NOT_CONFIGURED');
   const id=randomUUID(),candidate=randomUUID();
   await tx.query('INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state) VALUES($3,$1,$2,$4,$5,$6,$7)',[...s,candidate,'lab:'+candidate,user.userId,data.label,JSON.stringify(createLeadState(user.tenantId,user.brandId,candidate))]);
   await tx.query('INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) VALUES($3,$1,$2,$4,$5)',[...s,id,candidate,channel.phone_number_id]);
   await tx.query('INSERT INTO sdr.lab_sessions(tenant_id,brand_id,id,owner_user_id,request_id,candidate_id,label,scenario,version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...s,id,user.userId,data.requestId,candidate,data.label,data.scenario,version.version_id]);
   if(selected?.success)await tx.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($3,$1,$2,$4,'lab_evaluation_session_created',$5)",[...s,'lab-evaluation:'+id,id,JSON.stringify({ownerUserId:user.userId,requestId:data.requestId,versionId:pinnedVersion,contentHash:selected.data.contentHash})]);
   return this.owned(tx,user,id);
  });
 });}
 list(user:LabIdentity){return attempt(()=>scoped(this.db,user,async tx=>({sessions:(await tx.query(`SELECT ${columns} FROM sdr.lab_sessions l JOIN sdr.conversations c USING(tenant_id,brand_id,id) WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.owner_user_id=$3 ORDER BY l.created_at DESC LIMIT 100`,[user.tenantId,user.brandId,user.userId])).rows.map(row=>Session.parse(row))})));}
 detail(user:LabIdentity,id:string){return attempt(()=>scoped(this.db,user,tx=>this.detailTx(tx,user,id)));}
 private async detailTx(tx:Queryable,user:LabIdentity,id:string) {
  // One owned snapshot keeps polling short without relaxing the brand lock or exposing job context.
  const row=(await tx.query<{messages:Record<string,unknown>[],job:Record<string,unknown>|null}>(`SELECT ${columns},
   COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m."createdAt",m.id) FROM
    (SELECT id,actor,text,created_at AS "createdAt" FROM sdr.messages
     WHERE tenant_id=l.tenant_id AND brand_id=l.brand_id AND conversation_id=l.id) m),'[]'::jsonb) AS messages,
   (SELECT to_jsonb(j) FROM (SELECT id,state,error_code AS "errorCode",deadline FROM sdr.jobs
    WHERE tenant_id=l.tenant_id AND brand_id=l.brand_id AND conversation_id=l.id ORDER BY created_at DESC LIMIT 1) j) AS job
   FROM sdr.lab_sessions l JOIN sdr.conversations c USING(tenant_id,brand_id,id)
   WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.owner_user_id=$3 AND l.id=$4`,[user.tenantId,user.brandId,user.userId,id])).rows[0];
  if(!row)throw new ServiceError('SESSION_NOT_FOUND',404);
  return {session:Session.parse(row),messages:row.messages,job:row.job};
 }
 send(user:LabIdentity,id:string,raw:unknown){return attempt(async()=>{
  const parsed=MessageInput.safeParse(raw);if(!parsed.success)throw new ServiceError('INVALID_CONTRACT');
  const input=parsed.data;
  return scoped(this.db,user,async tx=>{
   const session=await this.owned(tx,user,id,true),s=[user.tenantId,user.brandId];
   if(input.campaignAdmission){
    const admin=(await tx.query("SELECT user_id FROM sdr.memberships WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3 AND role='admin' AND active",[...s,user.userId])).rows[0];
    if(!admin)throw new ServiceError('FORBIDDEN',403);
   }
   const snapshot=async(jobId:string|null)=>({jobId,detail:await this.detailTx(tx,user,id)});
   const messageId=id+':'+input.requestId;
   const old=(await tx.query<{text:string}>('SELECT text FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...s,messageId])).rows[0];
   if(old){
    if(old.text!==input.text)throw new ServiceError('REQUEST_CONFLICT');
    const job=(await tx.query<{id:string,context_version:number,epoch:number,context:{campaignAdmission?:unknown}|null,admissions:{id:string,detail:unknown}[]}>(`SELECT j.id,j.context_version,j.epoch,j.context,
     COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'detail',e.detail)) FROM sdr.events e WHERE e.tenant_id=j.tenant_id AND e.brand_id=j.brand_id
      AND e.type='lab_campaign_admitted' AND (e.id='lab-campaign:'||j.id OR e.detail->>'jobId'=j.id)),'[]'::jsonb) AS admissions
     FROM sdr.jobs j WHERE j.tenant_id=$1 AND j.brand_id=$2 AND j.trigger_message_id=$3`,[...s,messageId])).rows[0];
    if(input.campaignAdmission||job?.context?.campaignAdmission!==undefined||(job?.admissions.length??0)>0){
     // A control has no paid job; its existing idempotent replay remains free.
     if(!job&&detectControlIntent(input.text))return snapshot(null);
     const event=job?.admissions[0],admission=CampaignAdmissionSchema.safeParse(event?.detail),marker=CampaignAdmissionMarkerSchema.safeParse(job?.context?.campaignAdmission);
     if(!input.campaignAdmission||!job||job.admissions.length!==1||!admission.success||!marker.success||event.id!=='lab-campaign:'+job.id||marker.data.id!==event.id||
      marker.data.contentHash!==createHash('sha256').update(JSON.stringify(admission.data)).digest('hex'))throw new ServiceError('REQUEST_CONFLICT');
     const a=admission.data,{runId,turnId,target,maxReservationMicroUsd,submitBeforeMs}=a;
     if(a.tenantId!==user.tenantId||a.brandId!==user.brandId||a.actorUserId!==user.userId||a.sessionId!==id||a.requestId!==input.requestId||a.jobId!==job.id||
      a.candidateId!==session.candidateId||a.contextVersion!==job.context_version||a.epoch!==job.epoch||a.target.versionId!==session.versionId||
      JSON.stringify({runId,turnId,target,maxReservationMicroUsd,submitBeforeMs})!==JSON.stringify(input.campaignAdmission))throw new ServiceError('REQUEST_CONFLICT');
    }
    return snapshot(job?.id??null);
   }
   if(input.campaignAdmission){
    const target=input.campaignAdmission.target;
    const version=(await tx.query<{snapshot:unknown,content_hash:string,model:string,kind:string,checked_at:Date,duplicate_turn:boolean}>(`SELECT v.snapshot,v.content_hash,v.model,ch.kind,clock_timestamp() AS checked_at,
     EXISTS(SELECT 1 FROM sdr.events e WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.type='lab_campaign_admitted'
      AND e.detail->>'runId'=$5 AND e.detail->>'turnId'=$6) AS duplicate_turn
     FROM sdr.versions v JOIN sdr.conversations c ON c.tenant_id=v.tenant_id AND c.brand_id=v.brand_id AND c.id=$4
     JOIN sdr.channels ch ON ch.phone_number_id=c.phone_number_id AND ch.tenant_id=c.tenant_id AND ch.brand_id=c.brand_id
     WHERE v.tenant_id=$1 AND v.brand_id=$2 AND v.id=$3`,[...s,session.versionId,id,input.campaignAdmission.runId,input.campaignAdmission.turnId])).rows[0];
    const parsed=SnapshotSchema.safeParse(version?.snapshot);
    if(user.tenantId!=='cognita-homologacao'||user.brandId!=='sapore'||!version||version.kind!=='laboratory'||session.versionId!==target.versionId||
     version.content_hash!==target.contentHash||version.model!==target.model||!parsed.success||parsed.data.model!==target.model||
     parsed.data.tenant.tenantId!==user.tenantId||parsed.data.tenant.brandId!==user.brandId||snapshotHash(parsed.data)!==target.contentHash)throw new ServiceError('CAMPAIGN_ADMISSION_INVALID',409);
    if(input.campaignAdmission.submitBeforeMs<=version.checked_at.getTime())throw new ServiceError('CAMPAIGN_ADMISSION_EXPIRED',409);
    if(version.duplicate_turn)throw new ServiceError('REQUEST_CONFLICT');
   }
   if(session.state!=='automatic')throw new ServiceError('SESSION_PAUSED');
   const count=(await tx.query<{count:string,no_history:boolean}>("SELECT count(*),NOT EXISTS(SELECT 1 FROM sdr.messages history WHERE history.tenant_id=$1 AND history.brand_id=$2 AND (history.candidate_id=$4 OR history.conversation_id=$5)) AS no_history FROM sdr.messages m JOIN sdr.lab_sessions l ON(l.tenant_id,l.brand_id,l.id)=(m.tenant_id,m.brand_id,m.conversation_id) WHERE m.tenant_id=$1 AND m.brand_id=$2 AND l.owner_user_id=$3 AND m.actor='candidate' AND m.created_at>now()-interval '24 hours'",[...s,user.userId,session.candidateId,id])).rows[0];
   if(Number(count.count)>=100)throw new ServiceError('DAILY_TEST_LIMIT');
   await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'candidate','text',$6,now())",[...s,messageId,id,session.candidateId,input.text]);
   const lead=(await tx.query<{revision:number,pristine:boolean}>("UPDATE sdr.candidates SET revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 RETURNING revision,(lead_state->'facts'='[]'::jsonb AND lead_state->'relations'='[]'::jsonb AND lead_state->'referral'='null'::jsonb AND lead_state->>'status'='active') AS pristine",[...s,session.candidateId])).rows[0];
   const conv=(await tx.query<{epoch:number,phone_number_id:string,channel_kind:string}>('UPDATE sdr.conversations SET updated_at=now(),last_inbound_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 RETURNING epoch,phone_number_id,(SELECT kind FROM sdr.channels ch WHERE ch.phone_number_id=sdr.conversations.phone_number_id) AS channel_kind',[...s,id])).rows[0];
   await tx.query("UPDATE sdr.jobs SET state='stale',error_code='CONTEXT_CHANGED',completed_at=COALESCE(completed_at,now()) WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND state IN('pending','working','running','ready')",[...s,id]);
   const control=detectControlIntent(input.text);
   if(control){await new Store(this.db).controlTx(tx,user,id,control==='stop'?'stop':'handoff',messageId);return snapshot(null);}
   const jobId=conv.phone_number_id+':'+randomUUID();
   const greeting=user.tenantId==='cognita-homologacao'&&user.brandId==='sapore'&&conv.channel_kind==='laboratory'&&count.no_history&&lead.revision===1&&lead.pristine&&/^(?:oi|olá)[.!?\s]*$/iu.test(input.text.normalize('NFC'));
   const result=greeting?{bubbles:[initialGreeting],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}:null;
   const admission=input.campaignAdmission?CampaignAdmissionSchema.parse({...input.campaignAdmission,kind:'campaign-admission-v1',tenantId:user.tenantId,brandId:user.brandId,
    actorUserId:user.userId,sessionId:id,requestId:input.requestId,jobId,candidateId:session.candidateId,contextVersion:lead.revision,epoch:conv.epoch,gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000}):null;
   const marker=admission?{id:'lab-campaign:'+jobId,contentHash:createHash('sha256').update(JSON.stringify(admission)).digest('hex')}:null;
   const context=greeting||marker?{...(greeting?{origin:'deterministic_greeting'}:{}),...(marker?{campaignAdmission:marker}:{})}:null;
   // Clicking Send already commits the laboratory message; only WhatsApp needs burst debounce.
   await tx.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,available_at,state,result,context,completed_at) VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,now(),$10,$11,$12,CASE WHEN $10='completed' THEN clock_timestamp() ELSE NULL END)",[...s,jobId,id,session.candidateId,messageId,lead.revision,conv.epoch,session.versionId,greeting?'completed':'pending',result?JSON.stringify(result):null,context?JSON.stringify(context):null]);
   if(admission){
    const saved=await tx.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail,created_at) SELECT $3,$1,$2,$4,'lab_campaign_admitted',$5,stamp.at FROM (SELECT clock_timestamp() AS at) stamp WHERE stamp.at<to_timestamp($6::double precision/1000) RETURNING id",[...s,marker!.id,id,JSON.stringify(admission),admission.submitBeforeMs]);
    if(saved.rows.length!==1)throw new ServiceError('CAMPAIGN_ADMISSION_EXPIRED',409);
   }
   if(greeting)await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp,created_at) VALUES($3,$1,$2,$4,$5,'agent','text',$6,clock_timestamp(),clock_timestamp())",[...s,jobId+':greeting',id,session.candidateId,initialGreeting]);
   return snapshot(jobId);
  });
 });}
}
