import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Database, Scope } from './database.js';
import { scoped } from './database.js';
import { ServiceError } from './security.js';
import { EvaluationSchema } from './contracts.js';
import { randomUUID } from 'node:crypto';
import { readValidationState } from './versioning.js';

export interface LabIdentity extends Scope {userId:string,role:string}
export async function authenticateLab(request:FastifyRequest,db:Database,config:Pick<Config,'SUPABASE_URL'|'SUPABASE_ANON_KEY'>,transport:typeof fetch=fetch):Promise<LabIdentity> {
 const authorization=request.headers.authorization;
 if(!authorization?.startsWith('Bearer ')) throw new ServiceError('AUTHENTICATION_REQUIRED',401);
 const response=await transport(config.SUPABASE_URL.replace(/\/$/,'')+'/auth/v1/user',{headers:{Authorization:authorization,apikey:config.SUPABASE_ANON_KEY},signal:AbortSignal.timeout(5000)});
 if(!response.ok) throw new ServiceError('SESSION_INVALID',401);
 const user=await response.json();
 if(typeof user.id!=='string') throw new ServiceError('SESSION_INVALID',401);
 const {rows}=await db.query<{tenant_id:string,brand_id:string,role:string}>('SELECT tenant_id,brand_id,role FROM sdr.memberships WHERE user_id=$1 AND active',[user.id]);
 const selected=rows.filter(r=>(!request.headers['x-brand-id']||request.headers['x-brand-id']===r.brand_id)&&(!request.headers['x-tenant-id']||request.headers['x-tenant-id']===r.tenant_id));
 if(selected.length!==1) throw new ServiceError(selected.length?'SELECT_AUTHORIZED_BRAND':'ACCESS_DENIED',403);
 return {userId:user.id,tenantId:selected[0].tenant_id,brandId:selected[0].brand_id,role:selected[0].role};
}

export class Lab {
 constructor(private db:Database) {}
 async list(scope:Scope,kind?:'whatsapp'|'laboratory') {
  return scoped(this.db,scope,async tx=>({conversations:(await tx.query(`SELECT c.id,c.candidate_id AS "candidateId",p.label AS "contactLabel",b.name AS "brandName",c.state,c.updated_at AS "updatedAt",p.lead_state->'qualification'->>'priority' AS priority,p.lead_state->'qualification'->'missingFields' AS "missingFields",a.version_id AS "versionId",ch.kind,ch.phone_number_id AS "phoneNumberId",last.text AS "lastText",last.actor AS "lastActor" FROM sdr.conversations c JOIN sdr.candidates p ON (p.tenant_id,p.brand_id,p.id)=(c.tenant_id,c.brand_id,c.candidate_id) JOIN sdr.brands b ON (b.tenant_id,b.id)=(c.tenant_id,c.brand_id) JOIN sdr.channels ch ON ch.phone_number_id=c.phone_number_id LEFT JOIN sdr.active_versions a ON (a.tenant_id,a.brand_id)=(c.tenant_id,c.brand_id) LEFT JOIN LATERAL (SELECT text, actor FROM sdr.messages m WHERE m.tenant_id=c.tenant_id AND m.brand_id=c.brand_id AND m.conversation_id=c.id ORDER BY provider_timestamp DESC LIMIT 1) last ON true WHERE c.tenant_id=$1 AND c.brand_id=$2 AND ($3::text IS NULL OR ch.kind=$3) ORDER BY c.updated_at DESC LIMIT 100`,[scope.tenantId,scope.brandId,kind??null])).rows}));
 }
 async detail(scope:Scope,id:string) {
  return scoped(this.db,scope,async tx=>{
   const s=[scope.tenantId,scope.brandId,id];
   const conversation=(await tx.query<{id:string,candidateId:string,contactLabel:string}>(`SELECT c.id,c.candidate_id AS "candidateId",p.label AS "contactLabel",b.name AS "brandName",p.lead_state->'qualification'->>'priority' AS priority,p.lead_state->'qualification'->'missingFields' AS "missingFields",a.version_id AS "versionId",c.state,c.updated_at AS "updatedAt" FROM sdr.conversations c JOIN sdr.candidates p ON (p.tenant_id,p.brand_id,p.id)=(c.tenant_id,c.brand_id,c.candidate_id) JOIN sdr.brands b ON (b.tenant_id,b.id)=(c.tenant_id,c.brand_id) LEFT JOIN sdr.active_versions a ON (a.tenant_id,a.brand_id)=(c.tenant_id,c.brand_id) WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.id=$3`,s)).rows[0];
   if(!conversation) throw new ServiceError('CONVERSATION_NOT_FOUND',404);
   const messages=(await tx.query(`SELECT id,actor,CASE WHEN actor='candidate' THEN 'inbound' ELSE 'outbound' END AS direction,type,text,provider_timestamp AS "createdAt",transcript_origin AS "transcriptOrigin" FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 ORDER BY provider_timestamp LIMIT 500`,s)).rows;
   const facts=(await tx.query<{data:Record<string,unknown>}>(`SELECT data FROM sdr.facts WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3`,[scope.tenantId,scope.brandId,conversation.candidateId])).rows.map(r=>({...r.data,sourceMessageId:(r.data.evidence as {messageId:string})?.messageId}));
   const relations=(await tx.query<{data:Record<string,unknown>}>(`SELECT data FROM sdr.relations WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3`,[scope.tenantId,scope.brandId,conversation.candidateId])).rows.map(r=>({...r.data,label:r.data.name??'Não informado',sourceMessageId:(r.data.evidence as {messageId:string})?.messageId}));
   const jobs=(await tx.query<{versionId:string,correlationId:string,status:string,attempts:number,errorCode:string|null,retrievalMode:string|null,latencyMs:number|null,usage:Record<string,unknown>,context?:{sources?:{id:string,title:string,content:string}[],excludedSources?:{id:string,title:string,reason:string}[]}}>(`SELECT j.id,j.id AS "correlationId",j.state AS status,j.created_at AS "createdAt",j.version_id AS "versionId",v.model,j.attempts,j.error_code AS "errorCode",j.usage,j.context->>'retrieval' AS "retrievalMode",(extract(epoch from(j.completed_at-j.created_at))*1000)::double precision AS "latencyMs",j.context FROM sdr.jobs j JOIN sdr.versions v ON (v.tenant_id,v.brand_id,v.id)=(j.tenant_id,j.brand_id,j.version_id) WHERE j.tenant_id=$1 AND j.brand_id=$2 AND j.conversation_id=$3 ORDER BY j.created_at DESC LIMIT 100`,s)).rows;
   const events=(await tx.query(`SELECT id,type,CASE WHEN type='sprint4_human_review_recorded' THEN 'Avaliação humana registrada. Consulte a aba Avaliar para ver as notas e o conteúdo avaliado.' ELSE detail::text END AS description,created_at AS "createdAt" FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT 100`,s)).rows;
   const brief=(await tx.query<{id:string,data:Record<string,unknown>,createdAt:string,versionId:string}>(`SELECT id,data,created_at AS "createdAt",version_id AS "versionId" FROM sdr.briefings WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT 1`,s)).rows[0];
   const latest=jobs.find(j=>j.context),context=latest?.context;
   return {observability:{tenantId:scope.tenantId,brandId:scope.brandId},conversation,messages,facts,relations,events,jobs:jobs.map(({context,...job})=>job),briefing:brief?{...brief.data,id:brief.id,createdAt:brief.createdAt,versionId:brief.versionId}:null,sources:[...(context?.sources??[]).map(x=>({id:x.id,title:x.title,excerpt:x.content,version:latest?.versionId??'',status:'included'})),...(context?.excludedSources??[]).map(x=>({...x,excerpt:'',version:latest?.versionId??'',status:'excluded'}))]};
  });
 }
 async versions(scope:Scope) {
  return scoped(this.db,scope,async tx=>{
   const rows=(await tx.query<{id:string,label:string,model:string,createdAt:Date,contentHash:string,active:boolean|null}>(`SELECT v.id,v.label,v.model,v.created_at AS "createdAt",v.content_hash AS "contentHash",(a.version_id=v.id) AS active FROM sdr.versions v LEFT JOIN sdr.active_versions a ON (a.tenant_id,a.brand_id)=(v.tenant_id,v.brand_id) WHERE v.tenant_id=$1 AND v.brand_id=$2 ORDER BY v.created_at DESC`,[scope.tenantId,scope.brandId])).rows;
   const versions=[];
   for(const version of rows) {
    const validation=await readValidationState(tx,scope,version.contentHash,version.model);
    versions.push({...version,testStatus:validation.ready?'passed':validation.validationIds.length?'failed':'untested'});
   }
   return {versions};
  });
 }
 async evaluate(identity:LabIdentity,conversationId:string,raw:unknown) {
  const data=EvaluationSchema.parse(raw);
  return scoped(this.db,identity,async tx=>{
   const s=[identity.tenantId,identity.brandId];
   const job=(await tx.query('SELECT id FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND id=$4 AND completed_at IS NOT NULL',[...s,conversationId,data.jobId])).rows[0];
   if(!job) throw new ServiceError('EVALUATION_TARGET_NOT_FOUND',404);
   const id=randomUUID();
   await tx.query('INSERT INTO sdr.evaluations(id,tenant_id,brand_id,conversation_id,job_id,user_id,clarity,relevance,naturalness,briefing_utility,notes) VALUES($3,$1,$2,$4,$5,$6,$7,$8,$9,$10,$11)',[...s,id,conversationId,data.jobId,identity.userId,data.clarity,data.relevance,data.naturalness,data.briefingUtility,data.notes]);
   return {id};
  });
 }
}
