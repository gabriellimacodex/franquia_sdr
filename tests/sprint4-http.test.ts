import test from 'node:test';
import assert from 'node:assert/strict';
import { Sprint4Http } from '../evaluations/sprint4-http.js';
import { HttpResultSchema } from '../evaluations/sprint4-http.spec.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { Sprint4Controller } from '../evaluations/sprint4-controller.js';
import type { AdmissionEvidence, CampaignJournal, ControllerState } from '../evaluations/sprint4-controller.spec.js';
import type { ConversationReviewRecord } from '../src/conversation-review.spec.js';

const credential={actorUserId:'http-fixture-admin',accessToken:'synthetic-session-token'};
const identity={userId:credential.actorUserId,tenantId:'cognita-homologacao',brandId:'sapore',role:'admin'};
const planned=new Sprint4CampaignPlanner().execute({runId:'http-fixture',actorUserId:credential.actorUserId,target:{versionId:'http-fixture-v2',contentHash:'a'.repeat(64),model:'gpt-5.4-2026-03-05'}});
assert.ok(planned.success);const plan=planned.data,turn=plan.phases[0].executions[0].turns[0];
function campaign(){
 let state:ControllerState|null=null;
 const evidence:AdmissionEvidence={turnId:turn.id,actorUserId:credential.actorUserId,target:plan.request.target,evidenceRef:'synthetic-readiness',observedAtMs:1000,validUntilMs:2000,
  adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,tenantId:'cognita-homologacao',brandId:'sapore',executionMode:'laboratory',
  channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,sessionId:'11111111-1111-4111-8111-111111111111',sessionOwned:true,sessionReady:true,sessionFresh:true,
  requestId:'22222222-2222-4222-8222-222222222222',budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000,accountedMicroUsd:0,maxReservationMicroUsd:60000,remainingCampaignReviewed:true},
  daily:{actorUserId:credential.actorUserId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}};
 const journal:CampaignJournal={async read(){return structuredClone(state);},async compareAndSwap(_run,revision,next){if((state?.revision??null)!==revision)return false;state=structuredClone(next);return true;}};
 const controller=new Sprint4Controller(journal,{nowMs:()=>1100,async inspect(){return evidence;}});
 const session={id:evidence.sessionId,candidateId:'33333333-3333-4333-8333-333333333333',label:'Synthetic',scenario:'free',versionId:plan.request.target.versionId,state:'automatic'};
 const detail={session,messages:[{id:session.id+':'+evidence.requestId,actor:'candidate',text:turn.input,createdAt:'1970-01-01T00:00:01.200Z'}],
  job:{id:'fixture-job',state:'pending',errorCode:null,deadline:'1970-01-01T00:01:01.000Z'}};
 return {controller,journal,evidence,detail,get state(){return state;}};
}
test('identity uses the fixed API and server-authenticated admin, with no redirects or credential persistence',async()=>{
 let calls=0;
 const transport:typeof fetch=async(url,init)=>{
  calls++;assert.equal(url,'https://sdr-api.cognitaai.com.br/v1/me');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
  const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),'Bearer '+credential.accessToken);
  assert.equal(headers.get('x-tenant-id'),identity.tenantId);assert.equal(headers.get('x-brand-id'),identity.brandId);
  assert.ok(init?.signal);return Response.json(identity);
 };
 const client=new Sprint4Http(credential,transport),result=await client.execute({action:'identity'});
 assert.deepEqual(result,{success:true,data:{kind:'identity',identity}});assert.equal(calls,1);
 assert.equal(HttpResultSchema.safeParse(result).success,true);
 assert.equal(JSON.stringify(client).includes(credential.accessToken),false);
});

test('invalid or missing credentials fail closed before network and never expose the supplied secret',async()=>{
 for(const accessToken of ['', 'with whitespace', 'line\r\nbreak', 'x'.repeat(8193)]){
  let calls=0;const client=new Sprint4Http({...credential,accessToken},async()=>{calls++;return Response.json(identity);});
  const result=await client.execute({action:'identity'});assert.deepEqual(result,{success:false,error:{code:'INVALID_CREDENTIAL',requestAttempted:false,requiresAudit:false}});
  assert.equal(calls,0);if(accessToken)assert.equal(JSON.stringify(result).includes(accessToken),false);
 }
});

test('redirected, oversized or malformed identity responses are rejected and failures are sanitized',async()=>{
 const redirected=Response.json(identity);Object.defineProperty(redirected,'redirected',{value:true});
 for(const response of [redirected,Response.json({...identity,padding:'x'.repeat(1024*1024)}),new Response('not json')]){
  let calls=0;const result=await new Sprint4Http(credential,async()=>{calls++;return response;}).execute({action:'identity'});
  assert.equal(result.success,false);if(!result.success)assert.equal(result.error.code,'INVALID_RESPONSE');assert.equal(calls,1);
 }
 const result=await new Sprint4Http(credential,async()=>{throw new Error(credential.accessToken);}).execute({action:'identity'});
 assert.equal(result.success,false);assert.equal(JSON.stringify(result).includes(credential.accessToken),false);
});

test('the response body shares a finite timeout and cancellation even after successful response headers',{timeout:500},async()=>{
 let cancelled=false;const started=Date.now();
 const result=await new Sprint4Http(credential,async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),{timeoutMs:20}).execute({action:'identity'});
 assert.equal(result.success,false);if(!result.success)assert.equal(result.error.code,'TRANSPORT_FAILED');
 assert.equal(cancelled,true);assert.ok(Date.now()-started<1000);
});

test('advance dispatches only the durable controller action once and never invents an execution or ledger receipt from HTTP',async()=>{
 const f=campaign();let posts=0;
 const transport:typeof fetch=async(url,init)=>{
  if(url==='https://sdr-api.cognitaai.com.br/v1/me')return Response.json(identity);
  posts++;assert.equal(init?.method,'POST');assert.equal(url,'https://sdr-api.cognitaai.com.br/v1/lab/sessions/'+f.evidence.sessionId+'/messages');
  assert.equal(f.state?.entries.length,1,'durable intent before network');
  assert.deepEqual(JSON.parse(String(init?.body)),{requestId:f.evidence.requestId,text:turn.input,campaignAdmission:{runId:plan.request.runId,turnId:turn.id,target:plan.request.target,maxReservationMicroUsd:60000,submitBeforeMs:2000}});
  return Response.json({jobId:f.detail.job.id,detail:f.detail});
 };
 const client=new Sprint4Http(credential,transport,{controller:f.controller,nowMs:()=>1100});
 const first=await client.execute({action:'advance',plan});assert.ok(first.success);assert.equal(first.data.kind,'submission-confirmed');
 assert.equal(HttpResultSchema.safeParse(first).success,true);assert.equal('ledger' in first.data,false);assert.equal(f.state?.entries[0].receipts.length,0);
 const resumed=await client.execute({action:'advance',plan});assert.ok(resumed.success);
 assert.deepEqual(resumed.data,{kind:'controller',state:{kind:'awaiting-receipt',turnId:turn.id}});assert.equal(posts,1);
});

test('send confirmation must bind the exact session, version, canonical message and latest job, or require audit without replay',async()=>{
 const mutations:Array<(value:ReturnType<typeof campaign>['detail'])=>void>=[
  value=>{value.session.id='44444444-4444-4444-8444-444444444444';},value=>{value.session.versionId='another-version';},
  value=>{value.messages[0].text='changed text';},value=>{value.messages[0].actor='agent';},value=>{value.messages[0].id='another-message';},
  value=>{value.messages.push({...value.messages[0]});},value=>{value.job.id='another-job';},
 ];
 for(const mutate of mutations){
  const f=campaign(),response=structuredClone(f.detail);mutate(response);let posts=0;
  const client=new Sprint4Http(credential,async(_url,init)=>{if(init?.method==='GET')return Response.json(identity);posts++;return Response.json({jobId:'fixture-job',detail:response});},{controller:f.controller,nowMs:()=>1100});
  const result=await client.execute({action:'advance',plan});assert.deepEqual(result,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}});
  const next=await client.execute({action:'advance',plan});assert.ok(next.success);assert.equal(next.data.kind,'controller');assert.equal(posts,1);assert.equal(f.state?.entries[0].receipts.length,0);
 }
});

test('an expired action or mismatched controller dispatch is never posted, with its consumed intent left for audit',async()=>{
 for(const mismatch of ['expired','text','run','turn','target','submission-time','path']){
  const f=campaign();let posts=0;
  const controller={async execute(raw:unknown){const next=await f.controller.execute(raw);
   if(next.success&&next.data.kind==='dispatch-once'){
    if(mismatch==='text')next.data.input='not the selected case';if(mismatch==='run')next.data.campaignAdmission.runId='another-run';
    if(mismatch==='turn')next.data.campaignAdmission.turnId='another-turn';if(mismatch==='target')next.data.campaignAdmission.target.contentHash='b'.repeat(64);
    if(mismatch==='submission-time')next.data.campaignAdmission.submitBeforeMs=3000;if(mismatch==='path')next.data.sessionId='../versions/publish';
   }return next;}};
  const client=new Sprint4Http(credential,async(_url,init)=>{if(init?.method==='GET')return Response.json(identity);posts++;return Response.json({jobId:'fixture-job',detail:f.detail});},{controller,nowMs:()=>mismatch==='expired'?2000:1100});
  const result=await client.execute({action:'advance',plan});assert.deepEqual(result,{success:false,error:{code:'DISPATCH_INVALID',requestAttempted:false,requiresAudit:true}});
  assert.equal(posts,0);assert.equal(f.state?.entries.length,1);
 }
});

test('evaluation creation uses existing admin route and immutable pins, without publishing or generating a message',async()=>{
 const f=campaign();let posts=0;
 const client=new Sprint4Http(credential,async(url,init)=>{
  if(init?.method==='GET')return Response.json(identity);posts++;assert.equal(url,'https://sdr-api.cognitaai.com.br/v1/lab/evaluation-sessions');
  assert.deepEqual(JSON.parse(String(init?.body)),{requestId:f.evidence.requestId,label:'Synthetic',scenario:'free',versionId:plan.request.target.versionId,contentHash:plan.request.target.contentHash});
  return Response.json(f.detail.session);
 });
 const result=await client.execute({action:'create-session',mode:'evaluation',requestId:f.evidence.requestId,label:'Synthetic',scenario:'free',target:plan.request.target});
 assert.deepEqual(result,{success:true,data:{kind:'session-created',session:f.detail.session}});assert.equal(posts,1);
});

test('published creation uses normal session route, verifies returned version and never publishes or overrides active version',async()=>{
 const f=campaign();let posts=0;
 const client=new Sprint4Http(credential,async(url,init)=>{
  if(init?.method==='GET')return Response.json(identity);posts++;assert.equal(url,'https://sdr-api.cognitaai.com.br/v1/lab/sessions');
  assert.deepEqual(JSON.parse(String(init?.body)),{requestId:f.evidence.requestId,label:'Synthetic',scenario:'free'});
  return Response.json({...f.detail.session,versionId:'wrong-active-version'});
 });
 const result=await client.execute({action:'create-session',mode:'published',requestId:f.evidence.requestId,label:'Synthetic',scenario:'free',target:plan.request.target});
 assert.deepEqual(result,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}});assert.equal(posts,1);
});

test('detail reads only the specified owned session and target without dispatching or treating a terminal job as approval',async()=>{
 const f=campaign();let reads=0;
 const client=new Sprint4Http(credential,async(url,init)=>{assert.equal(init?.method,'GET');if(url==='https://sdr-api.cognitaai.com.br/v1/me')return Response.json(identity);
  reads++;assert.equal(url,'https://sdr-api.cognitaai.com.br/v1/lab/sessions/'+f.evidence.sessionId);return Response.json({...f.detail,job:{...f.detail.job,state:'completed'}});});
 const result=await client.execute({action:'detail',sessionId:f.evidence.sessionId,target:plan.request.target});assert.ok(result.success);assert.equal(result.data.kind,'detail');
 assert.equal('ledger' in result.data,false);assert.equal(reads,1);
});

test('HTTP failures and lost send responses remain auditable and never trigger retries or a second controller dispatch',async()=>{
 for(const kind of ['http','connection','body']){
  const f=campaign();let posts=0;
  const client=new Sprint4Http(credential,async(_url,init)=>{
   if(init?.method==='GET')return Response.json(identity);posts++;
   if(kind==='http')return Response.json({error:{code:credential.accessToken}},{status:409});
   if(kind==='connection')throw new Error(credential.accessToken);
   return new Response('{truncated');
  },{controller:f.controller,nowMs:()=>1100});
  const failed=await client.execute({action:'advance',plan});
  assert.deepEqual(failed,{success:false,error:{code:kind==='http'?'HTTP_FAILED':kind==='connection'?'TRANSPORT_FAILED':'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}});
  const resumed=await client.execute({action:'advance',plan});assert.ok(resumed.success);assert.deepEqual(resumed.data,{kind:'controller',state:{kind:'awaiting-receipt',turnId:turn.id}});
  assert.equal(posts,1);assert.equal(f.state?.entries[0].receipts.length,0);assert.equal(JSON.stringify(failed).includes(credential.accessToken),false);
 }
});

test('untrusted inputs, revoked auth and wrong scope or role cannot consume a campaign intent or post anything',async()=>{
 for(const me of [null,{...identity,role:'tester'},{...identity,userId:'someone-else'},{...identity,brandId:'other'},{...identity,tenantId:'other'}]){
  const f=campaign();let posts=0;const client=new Sprint4Http(credential,async(_url,init)=>{if(init?.method==='POST')posts++;return Response.json(me);},{controller:f.controller});
  const result=await client.execute({action:'advance',plan});assert.deepEqual(result,{success:false,error:{code:'AUTH_FAILED',requestAttempted:false,requiresAudit:false}});
  assert.equal(f.state,null);assert.equal(posts,0);
 }
 let calls=0;const client=new Sprint4Http(credential,async()=>{calls++;return Response.json(identity);});
 for(const input of [{action:'send',text:'anything'},{action:'identity',url:'https://other.example'},
  {action:'create-session',mode:'evaluation',requestId:'bad',label:'Synthetic',scenario:'free',target:plan.request.target},
  {action:'detail',sessionId:'../versions/publish',target:plan.request.target}]){
  assert.deepEqual(await client.execute(input),{success:false,error:{code:'INVALID_INPUT',requestAttempted:false,requiresAudit:false}});
 }assert.equal(calls,0);
});

test('invalid final observation clock cannot manufacture a successful timestamp after the message was submitted',async()=>{
 const f=campaign();let ticks=0;
 const client=new Sprint4Http(credential,async(_url,init)=>Response.json(init?.method==='GET'?identity:{jobId:'fixture-job',detail:f.detail}),
  {controller:f.controller,nowMs:()=>++ticks===1?1100:NaN});
 const result=await client.execute({action:'advance',plan});assert.deepEqual(result,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}});
 assert.equal(f.state?.entries[0].receipts.length,0);
});

test('input accessors that throw are rejected as values without leaking exceptions or reaching the network',async()=>{
 let calls=0;const client=new Sprint4Http(credential,async()=>{calls++;return Response.json(identity);});
 const input=Object.defineProperty({},'action',{get(){throw new Error('private-input-value');}});
 assert.deepEqual(await client.execute(input),{success:false,error:{code:'INVALID_INPUT',requestAttempted:false,requiresAudit:false}});assert.equal(calls,0);
});

test('syntactically accepted dates with impossible offsets are rejected before returning detail or send confirmation',async()=>{
 for(const field of ['createdAt','deadline']){
  const f=campaign();if(field==='createdAt')f.detail.messages[0].createdAt='2026-09-14T01:00:00+99:99';else f.detail.job.deadline='2026-09-14T01:00:00+99:99';
  const client=new Sprint4Http(credential,async(url,init)=>Response.json(String(url).endsWith('/v1/me')?identity:init?.method==='POST'?{jobId:'fixture-job',detail:f.detail}:f.detail),{controller:f.controller,nowMs:()=>1100});
  const detail=await client.execute({action:'detail',sessionId:f.evidence.sessionId,target:plan.request.target});
  assert.deepEqual(detail,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:false,requiresAudit:false}});
  const sent=await client.execute({action:'advance',plan});assert.deepEqual(sent,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:true,requiresAudit:true}});
 }
});

function humanReview():ConversationReviewRecord {
 const f=campaign(),jobId=f.detail.job.id;
 return {id:'synthetic-review',kind:'sprint4-human-review-v1',rubric:'sprint4-conversation-v1',jobId,targetHash:'b'.repeat(64),
  idempotencyKey:'44444444-4444-4444-8444-444444444444',actorUserId:'synthetic-reviewer-not-admin',reviewedAt:'1970-01-01T00:00:02.000Z',
  scores:{intentContext:4,commercialFidelity:3,clarityNaturalness:2,nextStepUtility:1},notes:'Synthetic review; not a human acceptance.',
  target:{kind:'sprint4-conversation-target-v1',tenantId:identity.tenantId,brandId:identity.brandId,conversationId:f.evidence.sessionId,candidateId:f.detail.session.candidateId,selectedJobId:jobId,
   turns:[{jobId,versionId:plan.request.target.versionId,contentHash:plan.request.target.contentHash,model:plan.request.target.model,status:'completed',completedAt:'1970-01-01T00:00:01.500Z',
    triggerMessageId:f.detail.messages[0].id,responseMessageIds:[jobId+':reply:0'],sources:[],excludedSources:[],guardCodes:[],memoryBefore:{facts:[],relations:[]}}],
   messages:[{...f.detail.messages[0],type:'text',jobId},{id:jobId+':reply:0',actor:'agent',type:'text',text:'Synthetic response',createdAt:'1970-01-01T00:00:01.500Z',jobId}],
   limitations:['synthetic-http-fixture-not-execution-evidence']}};
}

test('review-history reads the existing authenticated route once and preserves reviewer authorship without creating a receipt',async()=>{
 const review=humanReview(),sessionId=review.target.conversationId,calls:string[]=[];
 const client=new Sprint4Http(credential,async(url,init)=>{
  calls.push(String(url));assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);assert.equal(init?.redirect,'error');
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+credential.accessToken);
  return Response.json(String(url).endsWith('/v1/me')?identity:{reviews:[review]});
 });
 const result=await client.execute({action:'review-history',sessionId});
 assert.deepEqual(result,{success:true,data:{kind:'review-history',sessionId,reviews:[review]}});
 assert.deepEqual(calls,['https://sdr-api.cognitaai.com.br/v1/me','https://sdr-api.cognitaai.com.br/v1/conversations/'+sessionId+'/reviews']);
 assert.equal(HttpResultSchema.safeParse(result).success,true);assert.equal(JSON.stringify(result).includes(credential.accessToken),false);
});

test('review-history rejects the entire response if any review belongs to another scope or session',async()=>{
 for(const field of ['tenantId','brandId','conversationId'] as const){
  const review=humanReview(),invalid=structuredClone(review),sessionId=review.target.conversationId;
  invalid.target[field]='other-scope-or-session';let calls=0;
  const result=await new Sprint4Http(credential,async url=>{calls++;return Response.json(String(url).endsWith('/v1/me')?identity:{reviews:[review,invalid]});})
   .execute({action:'review-history',sessionId});
  assert.deepEqual(result,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:false,requiresAudit:false}},field);
  assert.equal(calls,2);assert.equal(JSON.stringify(result).includes(invalid.notes),false);
 }
});

test('review-history reuses the strict record schema and bounded private response reader',async()=>{
 const review=humanReview(),sessionId=review.target.conversationId;
 const responses=[()=>Response.json(null),()=>Response.json({reviews:[{...review,privateContext:'not-public'}]}),
  ()=>Response.json({reviews:[{...review,scores:{...review.scores,intentContext:0}}]}),
  ()=>Response.json({reviews:[{...review,target:{...review.target,instructions:'not-public'}}]}),
  ()=>Response.json({reviews:[review],credential:credential.accessToken}),()=>new Response('{truncated'),
  ()=>Response.json({reviews:Array.from({length:1000},()=>review)})];
 for(const response of responses){
  let calls=0;const result=await new Sprint4Http(credential,async url=>{calls++;return String(url).endsWith('/v1/me')?Response.json(identity):response();})
   .execute({action:'review-history',sessionId});
  assert.deepEqual(result,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:false,requiresAudit:false}});
  assert.equal(calls,2);assert.equal(JSON.stringify(result).includes(credential.accessToken),false);assert.equal(JSON.stringify(result).includes(review.notes),false);
 }
});

test('review-history treats revoked access, rate limits and lost reads as sanitized failures without retries',async()=>{
 const sessionId=humanReview().target.conversationId;
 for(const status of [401,403,429,500,'lost'] as const){
  let calls=0;const result=await new Sprint4Http(credential,async(url,init)=>{
   calls++;assert.equal(init?.method,'GET');if(String(url).endsWith('/v1/me'))return Response.json(identity);
   if(status==='lost')throw new Error(credential.accessToken);return Response.json({error:credential.accessToken},{status});
  }).execute({action:'review-history',sessionId});
  assert.deepEqual(result,{success:false,error:{code:status==='lost'?'TRANSPORT_FAILED':[401,403].includes(status)?'AUTH_FAILED':'HTTP_FAILED',requestAttempted:false,requiresAudit:false}});
  assert.equal(calls,2);assert.equal(JSON.stringify(result).includes(credential.accessToken),false);
 }
});

test('review-history rejects impossible offsets in review, turn and message timestamps',async()=>{
 const mutations:Array<(review:ConversationReviewRecord)=>void>=[
  review=>{review.reviewedAt='2026-09-14T01:00:00+99:99';},
  review=>{review.target.turns[0].completedAt='2026-09-14T01:00:00+99:99';},
  review=>{review.target.messages[0].createdAt='2026-09-14T01:00:00+99:99';},
 ];
 for(const mutate of mutations){
  const review=humanReview();mutate(review);
  const result=await new Sprint4Http(credential,async url=>Response.json(String(url).endsWith('/v1/me')?identity:{reviews:[review]}))
   .execute({action:'review-history',sessionId:review.target.conversationId});
  assert.deepEqual(result,{success:false,error:{code:'INVALID_RESPONSE',requestAttempted:false,requiresAudit:false}});
 }
});

test('advance forwards the expected turn pin to controller.next before one matching dispatch',async()=>{
 const f=campaign(),commands:unknown[]=[];let posts=0;
 const controller={async execute(raw:unknown){commands.push(raw);return f.controller.execute(raw);}};
 const client=new Sprint4Http(credential,async(_url,init)=>{
  if(init?.method==='GET')return Response.json(identity);posts++;return Response.json({jobId:f.detail.job.id,detail:f.detail});
 },{controller,nowMs:()=>1100});
 const result=await client.execute({action:'advance',plan,expectedTurnId:turn.id});
 assert.ok(result.success);assert.equal(result.data.kind,'submission-confirmed');
 assert.deepEqual(commands,[{action:'next',plan,expectedTurnId:turn.id}]);assert.equal(posts,1);
});

test('advance rejects a different returned dispatch turn even if its input and admission agree with the plan',async()=>{
 const f=campaign(),other=plan.phases[0].executions[0].turns[1];let posts=0;
 const controller={async execute(raw:unknown){
  const result=await f.controller.execute(raw);
  if(result.success&&result.data.kind==='dispatch-once'){
   result.data.turnId=other.id;result.data.input=other.input;result.data.campaignAdmission.turnId=other.id;
  }return result;
 }};
 const client=new Sprint4Http(credential,async(_url,init)=>{
  if(init?.method==='GET')return Response.json(identity);posts++;return Response.json({jobId:f.detail.job.id,detail:f.detail});
 },{controller,nowMs:()=>1100});
 assert.deepEqual(await client.execute({action:'advance',plan,expectedTurnId:turn.id}),{success:false,error:{code:'DISPATCH_INVALID',requestAttempted:false,requiresAudit:true}});
 assert.equal(posts,0);assert.equal(f.state?.entries[0].turnId,turn.id);assert.equal(f.state?.entries[0].receipts.length,0);
});
