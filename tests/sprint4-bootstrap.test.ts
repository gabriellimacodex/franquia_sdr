import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sprint4Bootstrap } from '../evaluations/sprint4-bootstrap.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { BootstrapResultSchema, BootstrapStorageInputSchema, type BootstrapRecord, type BootstrapStorageSpec } from '../evaluations/sprint4-bootstrap.spec.js';
import type { Sprint4HttpSpec } from '../evaluations/sprint4-http.spec.js';

const planned=new Sprint4CampaignPlanner().execute({runId:'bootstrap-fixture',actorUserId:'synthetic-admin',target:{versionId:'synthetic-v2',contentHash:'a'.repeat(64),model:'gpt-5.4-2026-03-05'}});
assert.ok(planned.success);const plan=planned.data,executionId=plan.phases[0].executions[0].id;
const requestId='11111111-1111-4111-8111-111111111111';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(){
 let record:BootstrapRecord|null=null,posts=0;const actions:string[]=[];
 const storage:BootstrapStorageSpec={async execute(raw){
  const input=BootstrapStorageInputSchema.parse(raw);actions.push(input.action);
  if(input.action==='read')return {success:true,data:{kind:'read',record:structuredClone(record)}};
  if(input.action==='claim-once'){
   if(record)return {success:true,data:{kind:'claimed',claimed:false}};
   record={intent:input.intent,observation:null};return {success:true,data:{kind:'claimed',claimed:true}};
  }
  if(input.action==='record-session-once'){
   assert.ok(record);record.observation=input.observation;return {success:true,data:{kind:'recorded',duplicate:false}};
  }
  return {success:true,data:{kind:'closed'}};
 }};
 const http:Sprint4HttpSpec={async execute(raw){
  const input=raw as {action:string;label:string;scenario:'free'};actions.push(input.action);
  if(input.action==='identity')return {success:true,data:{kind:'identity',identity:{userId:plan.request.actorUserId,tenantId:'cognita-homologacao',brandId:'sapore',role:'admin'}}};
  assert.equal(input.action,'create-session');posts++;assert.ok(record,'durable intent must exist before POST');
  return {success:true,data:{kind:'session-created',session:{id:'22222222-2222-4222-8222-222222222222',candidateId:'33333333-3333-4333-8333-333333333333',label:input.label,scenario:input.scenario,versionId:plan.request.target.versionId,state:'automatic'}}};
 }};
 return {storage,http,actions,get record(){return record;},set record(value:BootstrapRecord|null){record=value;},get posts(){return posts;}};
}

test('creates only after a durable exact canonical intent and preserves the confirmed session without marking it ready',async()=>{
 const f=fixture(),bootstrap=new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId});
 const result=await bootstrap.execute({action:'ensure-session',plan,executionId});
 assert.ok(result.success);assert.equal(result.data.kind,'session-recorded');assert.equal(BootstrapResultSchema.safeParse(result).success,true);
 assert.deepEqual(f.actions,['read','identity','claim-once','create-session','record-session-once']);assert.equal(f.posts,1);
 assert.ok(f.record?.observation);assert.equal(f.record.intent.planHash,hash(plan));assert.equal(f.record.intent.executionId,executionId);
 assert.equal(f.record.intent.mode,'evaluation');assert.equal(f.record.intent.actorUserId,plan.request.actorUserId);
 assert.equal(f.record.observation.intentHash,hash(f.record.intent));assert.equal(f.record.observation.source,'http');
 assert.equal('readyToExecute' in result.data,false);assert.equal('receipt' in result.data,false);
});

test('reopening a confirmed session returns the exact record with no authentication, UUID generation or POST',async()=>{
 const f=fixture();await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 const before=structuredClone(f.record);f.actions.length=0;
 const result=await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>2000,requestId:()=>{throw new Error('must not generate');}}).execute({action:'ensure-session',plan,executionId});
 assert.deepEqual(result,{success:true,data:{kind:'session-recorded',executionId,record:before}});
 assert.deepEqual(f.actions,['read']);assert.equal(f.posts,1);assert.deepEqual(f.record,before);
});

test('an interrupted creation stays unresolved on resume, without another POST even if no session acknowledgement was saved',async()=>{
 const f=fixture(),lost:Sprint4HttpSpec={async execute(raw){if((raw as {action:string}).action==='identity')return f.http.execute(raw);await f.http.execute(raw);throw new Error('synthetic private failure');}};
 const first=await new Sprint4Bootstrap({storage:f.storage,http:lost,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 assert.equal(first.success,false);assert.equal(JSON.stringify(first).includes('synthetic private failure'),false);assert.equal(f.posts,1);assert.equal(f.record?.observation,null);
 f.actions.length=0;
 const resumed=await new Sprint4Bootstrap({storage:f.storage,http:f.http,requestId:()=>{throw new Error();}}).execute({action:'ensure-session',plan,executionId});
 assert.deepEqual(resumed,{success:true,data:{kind:'awaiting-reconciliation',executionId,requestId}});
 assert.deepEqual(f.actions,['read']);assert.equal(f.posts,1);
});

test('stored records cannot be reused under a different plan, actor, execution, target or tampered session evidence',async()=>{
 const f=fixture();await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 const original=structuredClone(f.record!);
 for(const mutate of [
  (r:BootstrapRecord)=>{r.intent.planHash='b'.repeat(64);},(r:BootstrapRecord)=>{r.intent.actorUserId='other-admin';},
  (r:BootstrapRecord)=>{r.intent.executionId=plan.phases[0].executions[1].id;},(r:BootstrapRecord)=>{r.intent.runId='other';},
  (r:BootstrapRecord)=>{r.intent.target.contentHash='c'.repeat(64);},(r:BootstrapRecord)=>{r.intent.mode='published';},
  (r:BootstrapRecord)=>{r.intent.label='changed';},(r:BootstrapRecord)=>{r.intent.scenario='human';},
  (r:BootstrapRecord)=>{r.observation!.intentHash='d'.repeat(64);},(r:BootstrapRecord)=>{r.observation!.observedAtMs=999;},
  (r:BootstrapRecord)=>{r.observation!.session.versionId='other';},(r:BootstrapRecord)=>{r.observation!.session.label='other';},
  (r:BootstrapRecord)=>{r.observation!.session.scenario='human';},
 ]){
  f.record=structuredClone(original);mutate(f.record!);f.actions.length=0;
  const result=await new Sprint4Bootstrap({storage:f.storage,http:f.http}).execute({action:'ensure-session',plan,executionId});
  assert.deepEqual(result,{success:false,error:{code:'STATE_MISMATCH',requiresReconciliation:true}});assert.deepEqual(f.actions,['read']);
 }
 assert.equal(f.posts,1);
});

test('an unconfirmed competing claim is reread and never POSTed using the losing request identifier',async()=>{
 const f=fixture(),seed=new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId});
 await seed.execute({action:'ensure-session',plan,executionId});const winner=structuredClone(f.record!);winner.observation=null;f.record=null;f.actions.length=0;
 const storage:BootstrapStorageSpec={async execute(raw){
  if((raw as {action:string}).action==='claim-once')f.record=winner;
  return f.storage.execute(raw);
 }};
 const result=await new Sprint4Bootstrap({storage,http:f.http,nowMs:()=>1001,requestId:()=> '44444444-4444-4444-8444-444444444444'}).execute({action:'ensure-session',plan,executionId});
 assert.deepEqual(result,{success:true,data:{kind:'awaiting-reconciliation',executionId,requestId}});
 assert.equal(f.posts,1);assert.deepEqual(f.actions,['read','identity','claim-once','read']);assert.deepEqual(f.record,winner);
});

test('reconcile is strictly read-only remotely and cannot create a missing local intent',async()=>{
 const f=fixture();let inspections=0;
 const result=await new Sprint4Bootstrap({storage:f.storage,http:f.http,reconciler:{async inspect(intent){inspections++;return {success:true,data:{kind:'not-found',intentHash:hash(intent),observedAtMs:1000}};}},nowMs:()=>1000,requestId:()=>requestId}).execute({action:'reconcile',plan,executionId});
 assert.deepEqual(result,{success:false,error:{code:'STATE_MISMATCH',requiresReconciliation:false}});
 assert.deepEqual(f.actions,['read']);assert.equal(f.posts,0);assert.equal(inspections,0);assert.equal(f.record,null);
});

test('a trusted readonly observation recovers a lost creation acknowledgement, including a now paused session',async()=>{
 const f=fixture();await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 const observation={...structuredClone(f.record!.observation!),source:'database-readonly' as const,evidenceRef:'synthetic-db-observation',observedAtMs:2000};
 observation.session.state='human';f.record!.observation=null;f.actions.length=0;let inspections=0;
 const bootstrap=new Sprint4Bootstrap({storage:f.storage,http:f.http,reconciler:{async inspect(intent){inspections++;assert.deepEqual(intent,f.record!.intent);return {success:true,data:{kind:'session-observed',observation}};}}});
 const result=await bootstrap.execute({action:'reconcile',plan,executionId});
 assert.ok(result.success);assert.equal(result.data.kind,'session-recorded');assert.deepEqual(f.record!.observation,observation);
 assert.deepEqual(f.actions,['read','record-session-once']);assert.equal(f.posts,1);assert.equal(inspections,1);
 assert.deepEqual(await bootstrap.execute({action:'reconcile',plan,executionId}),result);assert.equal(inspections,1);
});

test('a verified absent snapshot leaves the intent unresolved and cannot authorize another creation',async()=>{
 const f=fixture();await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 f.record!.observation=null;const before=structuredClone(f.record);f.actions.length=0;
 const bootstrap=new Sprint4Bootstrap({storage:f.storage,http:f.http,reconciler:{async inspect(intent){return {success:true,data:{kind:'not-found',intentHash:hash(intent),observedAtMs:2000}};}}});
 for(const action of ['reconcile','ensure-session'])assert.deepEqual(await bootstrap.execute({action,plan,executionId}),{success:true,data:{kind:'awaiting-reconciliation',executionId,requestId}});
 assert.deepEqual(f.actions,['read','read']);assert.equal(f.posts,1);assert.deepEqual(f.record,before);
});

test('mismatched creation responses and backward clocks never become confirmed local records',async()=>{
 for(const issue of ['version','label','scenario','clock']){
  const f=fixture();let clock=1000;
  const http:Sprint4HttpSpec={async execute(raw){const result=await f.http.execute(raw);if(result.success&&result.data.kind==='session-created'){
   if(issue==='version')result.data.session.versionId='other';if(issue==='label')result.data.session.label='other';if(issue==='scenario')result.data.session.scenario='human';if(issue==='clock')clock=999;
  }return result;}};
  const result=await new Sprint4Bootstrap({storage:f.storage,http,nowMs:()=>clock,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
  assert.deepEqual(result,{success:false,error:{code:'CREATION_UNCONFIRMED',requiresReconciliation:true}});assert.equal(f.record!.observation,null);assert.equal(f.posts,1);
  assert.equal(f.actions.includes('record-session-once'),false);
 }
});

test('invalid inputs and altered canonical plans fail before any dependency or creation',async()=>{
 const f=fixture(),bootstrap=new Sprint4Bootstrap({storage:f.storage,http:f.http});
 const altered=structuredClone(plan);altered.phases[0].executions[0].turns[0].input='changed scenario';
 for(const raw of [null,{}, {action:'ensure-session',plan,executionId,unexpected:true},{action:'ensure-session',plan:altered,executionId},{action:'ensure-session',plan,executionId:'unknown'}]){
  const result=await bootstrap.execute(raw);assert.equal(result.success,false);assert.equal(BootstrapResultSchema.safeParse(result).success,true);
 }
 assert.deepEqual(f.actions,[]);assert.equal(f.record,null);
});

test('an authenticated different admin or failed storage cannot authorize a creation',async()=>{
 for(const issue of ['identity','read','claim']){
  const f=fixture();
  const storage:BootstrapStorageSpec={async execute(raw){if((raw as {action:string}).action===(issue==='read'?'read':issue==='claim'?'claim-once':'none'))return {success:false,error:{code:'STORAGE_FAILURE'}};return f.storage.execute(raw);}};
  const http:Sprint4HttpSpec={async execute(raw){const result=await f.http.execute(raw);if(issue==='identity'&&result.success&&result.data.kind==='identity')result.data.identity.userId='different-admin';return result;}};
  const result=await new Sprint4Bootstrap({storage,http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
  assert.equal(result.success,false);assert.equal(f.posts,0);assert.equal(f.record,null);
 }
});

test('lost local acknowledgements preserve committed intents or observations and never cause a second POST',async()=>{
 for(const lostAction of ['claim-once','record-session-once']){
  const f=fixture(),storage:BootstrapStorageSpec={async execute(raw){const result=await f.storage.execute(raw);if((raw as {action:string}).action===lostAction)throw new Error('synthetic-private-storage');return result;}};
  const result=await new Sprint4Bootstrap({storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
  assert.deepEqual(result,{success:false,error:{code:'DEPENDENCY_FAILED',requiresReconciliation:true}});assert.ok(f.record);
  f.actions.length=0;
  const next=await new Sprint4Bootstrap({storage:f.storage,http:f.http}).execute({action:'ensure-session',plan,executionId});
  assert.ok(next.success);assert.equal(next.data.kind,lostAction==='claim-once'?'awaiting-reconciliation':'session-recorded');
  assert.equal(f.posts,lostAction==='claim-once'?0:1);assert.deepEqual(f.actions,['read']);
 }
});

test('invalid, failed, wrong-source or mismatched reconciliation cannot save evidence or resend',async()=>{
 const f=fixture();await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 const observation=structuredClone(f.record!.observation!);f.record!.observation=null;const before=structuredClone(f.record);f.actions.length=0;
 for(const value of [null,{success:false,error:{code:'READ_FAILED'}},
  {success:true,data:{kind:'session-observed',observation}},
  {success:true,data:{kind:'session-observed',observation:{...observation,source:'database-readonly',intentHash:'f'.repeat(64)}}},
  {success:true,data:{kind:'not-found',intentHash:'f'.repeat(64),observedAtMs:2000}},
  {success:true,data:{kind:'not-found',intentHash:hash(f.record!.intent),observedAtMs:999}},
 ]){
  const bootstrap=new Sprint4Bootstrap({storage:f.storage,http:f.http,reconciler:{async inspect(){return value as never;}}});
  const result=await bootstrap.execute({action:'reconcile',plan,executionId});assert.equal(result.success,false);assert.equal(BootstrapResultSchema.safeParse(result).success,true);
 }
 assert.deepEqual(f.record,before);assert.equal(f.posts,1);assert.deepEqual(f.actions,Array(6).fill('read'));
});

test('the successful recorded-session contract requires a confirmed observation, not only an intent',async()=>{
 const f=fixture();await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 assert.equal(BootstrapResultSchema.safeParse({success:true,data:{kind:'session-recorded',executionId,record:{...f.record!,observation:null}}}).success,false);
});

test('a conflicting concurrent claim only adopts a matching stored winner, never the losing UUID',async()=>{
 const f=fixture();await new Sprint4Bootstrap({storage:f.storage,http:f.http,nowMs:()=>1000,requestId:()=>requestId}).execute({action:'ensure-session',plan,executionId});
 const winner=structuredClone(f.record!);winner.observation=null;f.record=null;
 const storage:BootstrapStorageSpec={async execute(raw){if((raw as {action:string}).action==='claim-once'){f.record=winner;return {success:false,error:{code:'STATE_CONFLICT'}};}return f.storage.execute(raw);}};
 const result=await new Sprint4Bootstrap({storage,http:f.http,nowMs:()=>2000,requestId:()=> '44444444-4444-4444-8444-444444444444'}).execute({action:'ensure-session',plan,executionId});
 assert.deepEqual(result,{success:true,data:{kind:'awaiting-reconciliation',executionId,requestId}});assert.equal(f.posts,1);
});

test('unreadable storage cannot be reported as proof that no earlier creation needs reconciliation',async()=>{
 const f=fixture(),storage:BootstrapStorageSpec={async execute(){return {success:false,error:{code:'CORRUPT_STATE'}};}};
 const result=await new Sprint4Bootstrap({storage,http:f.http}).execute({action:'ensure-session',plan,executionId});
 assert.deepEqual(result,{success:false,error:{code:'STORAGE_FAILED',requiresReconciliation:true}});assert.equal(f.posts,0);
});
