import { z } from 'zod';
import { HttpIdentitySchema, HttpInputSchema, HttpSendResponseSchema, HttpSessionSchema, HttpDetailSchema, HttpReviewHistorySchema, type HttpResult, type Sprint4HttpSpec } from './sprint4-http.spec.js';
import { ControllerResultSchema, type Sprint4ControllerSpec } from './sprint4-controller.spec.js';

const Credential=z.object({actorUserId:z.string().min(1).max(200),accessToken:z.string().min(1).max(8192).regex(/^[A-Za-z0-9._~-]+$/)}).strict();
const origin='https://sdr-api.cognitaai.com.br',maxResponseBytes=1024*1024;
type ResponseResult={ok:true;data:unknown}|{ok:false;code:'AUTH_FAILED'|'HTTP_FAILED'|'INVALID_RESPONSE'|'TRANSPORT_FAILED'};

/** Explicitly supplied laboratory user credential; never discover it from a browser or environment.
 * `advance` consumes the injected durable controller action internally; callers cannot supply a raw send DTO.
 * No retries or receipt synthesis. Creation requests/results still need caller-owned durable storage and
 * read-only reconciliation after ambiguity; creating a session is never permission for a model call.
 * Review history validates DTO/scope/session only; artifact integrity and criterion decisions belong to the review binder. */
export class Sprint4Http implements Sprint4HttpSpec {
 #credential; #transport; #timeoutMs; #controller; #nowMs;
 constructor(credential:{actorUserId:string;accessToken:string},transport:typeof fetch=fetch,options:{timeoutMs?:number;controller?:Sprint4ControllerSpec;nowMs?:()=>number}={}) {
  this.#credential={...credential};this.#transport=transport;this.#timeoutMs=options.timeoutMs??10000;
  this.#controller=options.controller;this.#nowMs=options.nowMs??Date.now;
 }
 async execute(raw:unknown):Promise<HttpResult>{
  let parsed:ReturnType<typeof HttpInputSchema.safeParse>;
  try{parsed=HttpInputSchema.safeParse(raw);}catch{return {success:false,error:{code:'INVALID_INPUT',requestAttempted:false,requiresAudit:false}};}
  if(!parsed.success)return {success:false,error:{code:'INVALID_INPUT',requestAttempted:false,requiresAudit:false}};
  if(!Credential.safeParse(this.#credential).success)return {success:false,error:{code:'INVALID_CREDENTIAL',requestAttempted:false,requiresAudit:false}};
  if(!Number.isInteger(this.#timeoutMs)||this.#timeoutMs<1||this.#timeoutMs>10000)return {success:false,error:{code:'INVALID_INPUT',requestAttempted:false,requiresAudit:false}};
  const result=await this.#request('/v1/me');
  if(!result.ok)return {success:false,error:{code:result.code,requestAttempted:false,requiresAudit:false}};
  const identity=HttpIdentitySchema.safeParse(result.data);
  if(!identity.success||identity.data.userId!==this.#credential.actorUserId)return {success:false,error:{code:'AUTH_FAILED',requestAttempted:false,requiresAudit:false}};
  if(parsed.data.action==='identity')return {success:true,data:{kind:'identity',identity:identity.data}};
  const input=parsed.data;
  if(input.action==='review-history'){
   const response=await this.#request('/v1/conversations/'+encodeURIComponent(input.sessionId)+'/reviews');
   if(!response.ok)return {success:false,error:{code:response.code,requestAttempted:false,requiresAudit:false}};
   const history=HttpReviewHistorySchema.safeParse(response.data);
   if(!history.success||history.data.reviews.some(review=>review.target.tenantId!==identity.data.tenantId||review.target.brandId!==identity.data.brandId||review.target.conversationId!==input.sessionId))
    return {success:false,error:{code:'INVALID_RESPONSE',requestAttempted:false,requiresAudit:false}};
   return {success:true,data:{kind:'review-history',sessionId:input.sessionId,reviews:history.data.reviews}};
  }
  if(input.action==='detail'){
   const response=await this.#request('/v1/lab/sessions/'+encodeURIComponent(input.sessionId));
   if(!response.ok)return {success:false,error:{code:response.code,requestAttempted:false,requiresAudit:false}};
   const detail=HttpDetailSchema.safeParse(response.data);
   if(!detail.success||detail.data.session.id!==input.sessionId||detail.data.session.versionId!==input.target.versionId)return {success:false,error:{code:'INVALID_RESPONSE',requestAttempted:false,requiresAudit:false}};
   return {success:true,data:{kind:'detail',detail:detail.data}};
  }
  if(input.action==='create-session'){
   const response=await this.#request(input.mode==='evaluation'?'/v1/lab/evaluation-sessions':'/v1/lab/sessions',{
    requestId:input.requestId,label:input.label,scenario:input.scenario,...(input.mode==='evaluation'?{versionId:input.target.versionId,contentHash:input.target.contentHash}:{})});
   if(!response.ok)return {success:false,error:{code:response.code,requestAttempted:true,requiresAudit:true}};
   const session=HttpSessionSchema.safeParse(response.data);
   if(!session.success||session.data.versionId!==input.target.versionId||session.data.label!==input.label||session.data.scenario!==input.scenario||session.data.state!=='automatic')return {success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}};
   return {success:true,data:{kind:'session-created',session:session.data}};
  }
  if(!this.#controller||input.plan.request.actorUserId!==identity.data.userId)return {success:false,error:{code:'CONTROLLER_FAILED',requestAttempted:false,requiresAudit:false}};
  let attempted=false;
  try{
   const next=ControllerResultSchema.safeParse(await this.#controller.execute({action:'next',plan:input.plan,...(input.expectedTurnId===undefined?{}:{expectedTurnId:input.expectedTurnId})}));
   if(!next.success||!next.data.success)return {success:false,error:{code:'CONTROLLER_FAILED',requestAttempted:false,requiresAudit:true}};
   const action=next.data.data;
   if(action.kind!=='dispatch-once')return {success:true,data:{kind:'controller',state:action}};
   const turn=input.plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns)).find(turn=>turn.id===action.turnId),now=this.#nowMs();
   if(!turn||input.expectedTurnId!==undefined&&action.turnId!==input.expectedTurnId||turn.input!==action.input||!z.string().uuid().safeParse(action.sessionId).success||!Number.isSafeInteger(now)||now<0||now>=action.validUntilMs||
    action.campaignAdmission.runId!==input.plan.request.runId||action.campaignAdmission.turnId!==action.turnId||action.campaignAdmission.submitBeforeMs!==action.validUntilMs||
    JSON.stringify(action.target)!==JSON.stringify(input.plan.request.target)||JSON.stringify(action.campaignAdmission.target)!==JSON.stringify(action.target)){
    return {success:false,error:{code:'DISPATCH_INVALID',requestAttempted:false,requiresAudit:true}};
   }
   attempted=true;
   const sent=await this.#request('/v1/lab/sessions/'+encodeURIComponent(action.sessionId)+'/messages',{
    requestId:action.requestId,text:action.input,campaignAdmission:action.campaignAdmission});
   if(!sent.ok)return {success:false,error:{code:sent.code,requestAttempted:true,requiresAudit:true}};
   const decoded=HttpSendResponseSchema.safeParse(sent.data);
   if(!decoded.success||!decoded.data.jobId)return {success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}};
   const detail=decoded.data.detail,messages=detail.messages.filter(message=>message.id===action.sessionId+':'+action.requestId);
   if(detail.session.id!==action.sessionId||detail.session.versionId!==action.target.versionId||detail.job?.id!==decoded.data.jobId||
    messages.length!==1||messages[0].actor!=='candidate'||messages[0].text!==action.input)return {success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}};
   const observedAtMs=this.#nowMs();
   if(!Number.isSafeInteger(observedAtMs)||observedAtMs<now)return {success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}};
   return {success:true,data:{kind:'submission-confirmed',turnId:action.turnId,requestId:action.requestId,sessionId:action.sessionId,
    jobId:decoded.data.jobId,detail:decoded.data.detail,observedAtMs,executionAudit:'pending'}};
  }catch{return {success:false,error:{code:'CONTROLLER_FAILED',requestAttempted:attempted,requiresAudit:true}};}
 }
 async #request(path:string,body?:unknown):Promise<ResponseResult>{
  const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<ResponseResult>(resolve=>{timer=setTimeout(()=>{
   abort.abort();if(reader)void reader.cancel().catch(()=>{});resolve({ok:false,code:'TRANSPORT_FAILED'});
  },this.#timeoutMs);});
  const read=async():Promise<ResponseResult>=>{
   let response:Response;
   try{response=await this.#transport(origin+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:abort.signal,
    headers:{Authorization:'Bearer '+this.#credential.accessToken,'X-Tenant-Id':'cognita-homologacao','X-Brand-Id':'sapore','Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
   }catch{return {ok:false,code:'TRANSPORT_FAILED'};}
   if(abort.signal.aborted){void response.body?.cancel().catch(()=>{});return {ok:false,code:'TRANSPORT_FAILED'};}
   if(response.redirected||(response.url!==''&&response.url!==origin+path)){void response.body?.cancel().catch(()=>{});return {ok:false,code:'INVALID_RESPONSE'};}
   if(!response.ok){void response.body?.cancel().catch(()=>{});return {ok:false,code:[401,403].includes(response.status)?'AUTH_FAILED':'HTTP_FAILED'};}
   try{
    reader=response.body?.getReader();if(!reader)return {ok:false,code:'INVALID_RESPONSE'};
    let size=0;const chunks:Uint8Array[]=[];
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
     if(size>maxResponseBytes){void reader.cancel().catch(()=>{});return {ok:false,code:'INVALID_RESPONSE'};}chunks.push(value);}
    return {ok:true,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
   }catch{return {ok:false,code:abort.signal.aborted?'TRANSPORT_FAILED':'INVALID_RESPONSE'};}
   finally{reader?.releaseLock();}
  };
  try{return await Promise.race([read(),timeout]);}catch{return {ok:false,code:'TRANSPORT_FAILED'};}finally{clearTimeout(timer);}
 }
}
