import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Database } from './database.js';
import { scoped } from './database.js';
import { Store, type ConversationRow, type ControlEvidence } from './store.js';
import { Engine } from './engine.js';
import { Kapso, type NativeState } from './kapso.js';
import { ControlSchema, TurnInputSchema } from './contracts.js';
import { ServiceError, tokenMatches, verifySignature } from './security.js';
import { Lab, authenticateLab } from './lab.js';
import { ingestWebhook } from './webhooks.js';
import { Briefings } from './briefings.js';
import { Versioning } from './versioning.js';
import { LabSessions } from './lab-sessions.js';
import type { Result } from './security.js';
import { ConversationReview } from './conversation-review.js';
import type { ConversationReviewResult } from './conversation-review.spec.js';

const json=(request:FastifyRequest)=>{try{return JSON.parse((request.body as Buffer).toString('utf8'));}catch{throw new ServiceError('INVALID_JSON');}};
export async function createServer(db:Database,config:Config,options:{transport?:typeof fetch,native?:(id:string)=>Promise<NativeState>,logging?:boolean}={}) {
 const app=Fastify({bodyLimit:512*1024,logger:options.logging?{level:'info',redact:['req.headers.authorization','req.headers.x-api-key','req.headers.x-webhook-signature','req.body','res.body']}:false,disableRequestLogging:true});
 app.removeContentTypeParser('application/json');
 app.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
 await app.register(cors,{origin:config.LAB_ORIGIN,methods:['GET','POST'],allowedHeaders:['Authorization','Content-Type','X-Tenant-Id','X-Brand-Id']});
 await app.register(rateLimit,{max:180,timeWindow:'1 minute'});
 const store=new Store(db),engine=new Engine(store,config,options.transport),kapso=new Kapso(config,options.transport),lab=new Lab(db),briefings=new Briefings(store,config,options.transport);
 const native=options.native??((id:string)=>kapso.native(id));
 const versions=new Versioning(db),sessions=new LabSessions(db);
 const conversationReviews=new ConversationReview(db);
 const unwrap=<T>(result:Result<T>)=>{if(!result.ok)throw new ServiceError(result.error.code,result.error.code==='FORBIDDEN'?403:409);return result.value;};
 app.setErrorHandler((error,_req,reply)=>{
  const code=error instanceof ServiceError?error.code:error instanceof z.ZodError?'INVALID_CONTRACT':'INTERNAL_ERROR';
  const status=error instanceof ServiceError?error.statusCode:error instanceof z.ZodError?400:(error as {statusCode?:number}).statusCode===429?429:500;
  app.log.warn({code,status},'request_failed'); void reply.status(status).send({error:{code}});
 });
 app.addHook('onRequest',async request=>{
  if(request.method==='OPTIONS') return;
  if(config.EXECUTION_MODE==='laboratory'&&(request.url.startsWith('/webhooks/kapso')||(request.url.startsWith('/internal/')&&!request.url.startsWith('/internal/n8n/'))))throw new ServiceError('CHANNEL_DISABLED',403);
  if(request.url.startsWith('/internal/n8n/')) {if(!tokenMatches(request.headers.authorization,config.N8N_CALLBACK_TOKEN)) throw new ServiceError('UNAUTHORIZED',401);}
  else if(request.url.startsWith('/internal/')) {if(!tokenMatches(request.headers.authorization,config.KAPSO_FUNCTION_TOKEN)) throw new ServiceError('UNAUTHORIZED',401);}
 });
 app.get('/health',async()=>({status:'ok',environment:'homologation',outboundEnabled:config.CHANNEL_ENABLED==='true'&&config.NATIVE_CONTROL_VERIFIED==='true'}));
 app.get('/ready',async()=>{await db.query('SELECT 1');return {status:'ready'};});
 app.post('/webhooks/kapso',async(request,reply)=>{
  if(!verifySignature(request.body as Buffer,request.headers['x-webhook-signature'],config.KAPSO_WEBHOOK_SECRET)) throw new ServiceError('INVALID_SIGNATURE',401);
  await ingestWebhook(store,json(request),String(request.headers['x-idempotency-key']??''),request.body as Buffer,{
   eventType:String(request.headers['x-webhook-event']??''),expectedWorkflowId:config.KAPSO_WORKFLOW_ID,
   resolveContact:async identity=>{const {data}=await kapso.request('/platform/v1/whatsapp/contacts/'+encodeURIComponent(identity));return {id:data.id,phone:data.wa_id};},
   verifyNativeSend:async input=>{
    const phone=(input.payload as {phone_number_id?:string}).phone_number_id;
    return !!phone&&kapso.proveOutbound({conversationId:input.conversationId,executionId:input.executionId,messageId:input.messageId,phoneNumberId:phone});
   },
  });
  return reply.send({received:true});
 });
 app.post('/internal/turns',async request=>{
  const input=TurnInputSchema.parse(json(request));
  // Even allowlisted requests cannot silently replace the channel's native owner.
  if(!input.executionId) throw new ServiceError('NATIVE_EXECUTION_REQUIRED');
  const state=await native(input.executionId);
  if(state.conversationId!==input.conversationId) throw new ServiceError('NATIVE_SCOPE_MISMATCH',409);
  if(state.status!=='running') return {id:'',state:'handoff',reply:[],contextVersion:0};
  if(state.controlFingerprint!==input.controlFingerprint) throw new ServiceError('NATIVE_CONTEXT_CHANGED',409);
  return store.startTurn(input);
 });
 app.get<{Params:{id:string}}>('/internal/turns/:id',async request=>store.view((await store.getJob(request.params.id)).job));
 app.get<{Params:{id:string},Querystring:{phoneNumberId:string}}>('/internal/conversations/:id/state',async request=>{
  const channel=await store.channel(request.query.phoneNumberId);
  return scoped(db,channel,async tx=>{
   const c=(await tx.query<ConversationRow>('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[channel.tenantId,channel.brandId,request.params.id])).rows[0];
   return {state:c?.state??'new',nativeExecutionId:c?.execution_id??null,nativeControlFingerprint:c?.control_fingerprint??null};
  });
 });
 app.post<{Params:{id:string}}>('/internal/conversations/:id/control',async request=>{
  const input=ControlSchema.parse(json(request));const channel=await store.channel(input.phoneNumberId);
  let evidence:ControlEvidence|undefined;
  let eventId=input.eventId??input.controlFingerprint??input.event;
  if(input.event==='resume') {
   if(!input.executionId) throw new ServiceError('NATIVE_EXECUTION_REQUIRED');
   const state=await native(input.executionId);
   if(state.conversationId!==request.params.id||state.status!=='running'||state.controlFingerprint!==input.controlFingerprint||!state.controlEvent?.humanResume) throw new ServiceError('RESUME_NOT_CONFIRMED',409);
   eventId=state.controlEvent.id;
   evidence={providerSource:'native_execution',providerOccurredAt:state.controlEvent.occurredAt};
  }
  await store.control(channel,request.params.id,input.event,eventId,input.executionId,input.controlFingerprint,evidence);
  return {recorded:true};
 });
 app.post<{Params:{id:string}}>('/internal/turns/:id/authorize-send',async request=>{
  const input=z.object({executionId:z.string(),controlFingerprint:z.string(),contextVersion:z.number().optional()}).parse(json(request));
  const {channel,job}=await store.getJob(request.params.id);
  // sdr_runtime cannot write channels.enabled; outbound follows env gates + responsible operator.
  if(config.CHANNEL_ENABLED!=='true'||config.NATIVE_CONTROL_VERIFIED!=='true'||!channel.responsibleUserId) return {authorized:false,state:'handoff',reply:[],errorCode:'RELEASE_GATE_CLOSED'};
  const state=await native(input.executionId);
  if(state.status!=='running'||state.conversationId!==job.conversation_id||state.controlFingerprint!==input.controlFingerprint) {
   await store.control(channel,job.conversation_id,'handoff','send-guard:'+state.controlFingerprint,input.executionId,state.controlFingerprint);
   return {authorized:false,state:'handoff',reply:[]};
  }
  return store.authorize(job.id,input.executionId,input.controlFingerprint);
 });
 /** Fase 2: authorize + send via Kapso Messages API, then wait (Kapso must not Send Text again). */
 app.post<{Params:{id:string}}>('/internal/turns/:id/deliver',async request=>{
  const input=z.object({executionId:z.string(),controlFingerprint:z.string(),contextVersion:z.number().optional()}).parse(json(request));
  const {channel,job}=await store.getJob(request.params.id);
  if(config.CHANNEL_ENABLED!=='true'||config.NATIVE_CONTROL_VERIFIED!=='true'||!channel.responsibleUserId) return {authorized:false,state:'handoff',reply:[],errorCode:'RELEASE_GATE_CLOSED'};
  if(job.state==='sent') return {...store.view(job),authorized:true,reply:[]};
  const state=await native(input.executionId);
  if(state.status!=='running'||state.conversationId!==job.conversation_id||state.controlFingerprint!==input.controlFingerprint) {
   await store.control(channel,job.conversation_id,'handoff','deliver-guard:'+state.controlFingerprint,input.executionId,state.controlFingerprint);
   return {authorized:false,state:'handoff',reply:[]};
  }
  const authorization=await store.authorize(job.id,input.executionId,input.controlFingerprint);
  if(!authorization.authorized) return authorization;
  const reply=authorization.reply;
  if(!Array.isArray(reply)||reply.length<1||reply.length>2||reply.some(part=>typeof part!=='string'||!part.trim())||reply.join('\n\n').length>4000) {
   await store.failApiSend(job.id,'INVALID_AUTHORIZED_REPLY');
   return {authorized:false,state:'handoff',reply:[],errorCode:'INVALID_AUTHORIZED_REPLY'};
  }
  try {
   const hint=await store.recipientHint(job.id);
   const to=/^\d{10,20}$/.test(hint.authorizedContactId)?hint.authorizedContactId:await kapso.resolveWaId(hint.contactId);
   const wamid=await kapso.sendText({phoneNumberId:hint.phoneNumberId,to,text:reply.join('\n\n')});
   return store.confirmApiSend(job.id,wamid);
  } catch {
   return store.failApiSend(job.id,'DELIVERY_FAILED');
  }
 });
 app.post<{Params:{id:string}}>('/internal/turns/:id/dispatched',async request=>{await store.dispatched(request.params.id);return {recorded:true,status:'awaiting_provider_receipt'};});
 app.post<{Params:{id:string}}>('/internal/n8n/jobs/:id/complete',async request=>{
  const body=json(request);if(body.jobId!==request.params.id) throw new ServiceError('JOB_MISMATCH',409); return engine.complete(body);
 });
 app.post<{Params:{id:string}}>('/internal/n8n/briefings/:id/complete',async request=>{
  const body=json(request);if(body.jobId!==request.params.id)throw new ServiceError('JOB_MISMATCH',409);return briefings.complete(body);
 });
 const identity=(request:FastifyRequest)=>authenticateLab(request,db,config,options.transport);
 const labResult=<T>(result:Result<T>)=>{if(!result.ok)throw new ServiceError(result.error.code,result.error.code==='FORBIDDEN'?403:result.error.code==='SESSION_NOT_FOUND'?404:result.error.code==='INVALID_CONTRACT'?400:409);return result.value;};
 app.get('/v1/me',async request=>identity(request));
 app.post('/v1/lab/sessions',async request=>labResult(await sessions.create(await identity(request),json(request))));
 app.post('/v1/lab/evaluation-sessions',async request=>{
  if(config.EXECUTION_MODE!=='laboratory')throw new ServiceError('EVALUATION_LAB_ONLY',403);
  return labResult(await sessions.createEvaluation(await identity(request),json(request)));
 });
 app.get('/v1/lab/sessions',async request=>labResult(await sessions.list(await identity(request))));
 app.get<{Params:{id:string}}>('/v1/lab/sessions/:id',async request=>labResult(await sessions.detail(await identity(request),request.params.id)));
 app.post<{Params:{id:string}}>('/v1/lab/sessions/:id/messages',async request=>labResult(await sessions.send(await identity(request),request.params.id,json(request))));
 const reviewer=async(request:FastifyRequest)=>{const user=await identity(request);if(!['admin','reviewer'].includes(user.role))throw new ServiceError('FORBIDDEN',403);return user;};
 const reviewResult=(result:ConversationReviewResult)=>{
  if(result.success)return result.data;
  const code=result.error.code;throw new ServiceError(code,code==='FORBIDDEN'?403:code==='INVALID_INPUT'?400:code==='TARGET_NOT_FOUND'?404:code==='READ_FAILED'?500:409);
 };
 app.get<{Params:{id:string,jobId:string}}>('/v1/conversations/:id/review-target/:jobId',async request=>reviewResult(await conversationReviews.execute(await reviewer(request),{action:'target',conversationId:request.params.id,jobId:request.params.jobId})));
 app.get<{Params:{id:string}}>('/v1/conversations/:id/reviews',async request=>reviewResult(await conversationReviews.execute(await reviewer(request),{action:'history',conversationId:request.params.id})));
 app.post<{Params:{id:string}}>('/v1/conversations/:id/reviews',async request=>reviewResult(await conversationReviews.execute(await reviewer(request),{action:'record',conversationId:request.params.id,submission:json(request)})));
 app.get('/v1/conversations',async request=>{
  const kind=z.object({kind:z.enum(['whatsapp','laboratory']).optional()}).parse(request.query).kind;
  return lab.list(await reviewer(request),kind);
 });
 app.get<{Params:{id:string}}>('/v1/conversations/:id',async request=>lab.detail(await reviewer(request),request.params.id));
 app.get('/v1/versions',async request=>lab.versions(await reviewer(request)));
 app.get('/v1/versions/draft',async request=>{const user=await identity(request);return {draft:unwrap(await versions.getDraft(user,user.userId))};});
 app.post('/v1/versions/draft',async request=>{const user=await identity(request);return {draft:unwrap(await versions.saveDraft(user,json(request),user.userId))};});
 app.post<{Params:{id:string}}>('/v1/versions/:id/restore',async request=>{const user=await identity(request);return {draft:unwrap(await versions.restoreDraft(user,request.params.id,user.userId))};});
 app.post('/v1/versions/publish',async request=>{const user=await identity(request);const {approvedHash}=z.object({approvedHash:z.string().length(64)}).strict().parse(json(request));return unwrap(await versions.publish(user,user.userId,approvedHash));});
 app.get<{Params:{hash:string}}>('/v1/versions/validation/:hash',async request=>{const user=await identity(request);return unwrap(await versions.validationState(user,request.params.hash,user.userId));});
 app.post<{Params:{id:string}}>('/v1/conversations/:id/evaluations',async request=>lab.evaluate(await reviewer(request),request.params.id,json(request)));
 return app;
}
