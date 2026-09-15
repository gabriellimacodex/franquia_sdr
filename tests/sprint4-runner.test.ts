import test from 'node:test';
import assert from 'node:assert/strict';
import { Sprint4Runner } from '../evaluations/sprint4-runner.js';
import { evidenceFixture } from './sprint4-evidence-fixture.js';
import type { CampaignJournal, ControllerState, Receipt } from '../evaluations/sprint4-controller.spec.js';
import type { RunnerDependencies } from '../evaluations/sprint4-runner.spec.js';
import { BootstrapIntentSchema } from '../evaluations/sprint4-bootstrap.spec.js';
import { TerminalArtifactSchema, terminalEvidenceHash } from '../evaluations/sprint4-evidence.spec.js';

function fixture(){
 const f=evidenceFixture();let state:ControllerState|null=null,effects=0;
 const forbidden=async()=>{effects++;throw new Error('unexpected side effect');};
 const journal:CampaignJournal={async read(){return structuredClone(state);},async compareAndSwap(_run,revision,next){if(revision!==(state?.revision??null))return false;state=structuredClone(next);return true;}};
 const deps:RunnerDependencies={journal,bootstrap:{execute:forbidden},http:{execute:forbidden},controller:{execute:forbidden},capture:{execute:forbidden},review:{execute:forbidden}};
 return {...f,deps,get effects(){return effects;},get state(){return state;},set state(value:ControllerState|null){state=value;}};
}
function terminalReceipt(f:ReturnType<typeof fixture>):Receipt {
 const o=f.observation;
 return {receiptId:'unverified-string',turnId:f.turn.id,requestId:o.binding.requestId,sessionId:o.binding.sessionId,target:f.plan.request.target,
  observedAtMs:4000,kind:'terminal',jobId:o.job.id,jobDeadlineAtMs:o.jobDeadlineAtMs,preparation:o.preparation,evidenceRef:'criteria-sha256:'+'b'.repeat(64),
  jobState:'completed',guardCodes:[],criticalCodes:[],objectiveAudit:'passed',
  ledger:{reservationId:o.ledger.id,state:'settled',costMicroUsd:o.ledger.detail.costMicroUsd},responseArtifactRef:f.artifact.ref,rawArtifactRef:null};
}

test('observing a campaign without an intent is read-only and does not create or send',async()=>{
 const f=fixture();
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'observe',plan:f.plan}),{success:true,data:{kind:'idle'}});
 assert.equal(f.effects,0);assert.equal(f.state,null);
});

test('advance with an unresolved durable intent never reopens bootstrap or resends after restart',async()=>{
 const f=fixture();f.state=evidenceFixture().state;
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),{success:true,data:{kind:'awaiting-receipt',turnId:f.turn.id}});
 assert.equal(f.effects,0);assert.equal(f.state.entries.length,1);
});

test('a persisted failed receipt remains halted even if a later receipt claims success',async()=>{
 const f=fixture();f.state=evidenceFixture().state;
 f.state.entries[0].receipts.push({...terminalReceipt(f),receiptId:'failed-original',objectiveAudit:'failed'},terminalReceipt(f));
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),{success:true,data:{kind:'halted',turnId:f.turn.id,reason:'failed'}});
 assert.equal(f.effects,0);assert.equal(f.state.entries[0].receipts.length,2);
});

test('ambiguous session creation is reported without attempting a message or retrying the POST',async()=>{
 const f=fixture();let calls=0;
 const outcome={success:false as const,error:{code:'CREATION_UNCONFIRMED' as const,requiresReconciliation:true}};
 f.deps.bootstrap={async execute(){calls++;return outcome;}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),{success:true,data:{kind:'bootstrap-observed',outcome}});
 assert.equal(calls,1);assert.equal(f.effects,0);
});

test('an existing ambiguous bootstrap is reconciled read-only rather than attempting creation again',async()=>{
 const f=fixture(),actions:string[]=[],executionId=f.plan.phases[0].executions[0].id;
 const outcome={success:false as const,error:{code:'RECONCILIATION_UNCONFIRMED' as const,requiresReconciliation:true}};
 f.deps.bootstrap={async execute(input){const action=(input as {action:string}).action;actions.push(action);
  if(action==='ensure-session')return {success:true,data:{kind:'awaiting-reconciliation',executionId,requestId:'11111111-1111-4111-8111-111111111111'}};
  assert.deepEqual(input,{action:'reconcile',plan:f.plan,executionId});return outcome;}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),{success:true,data:{kind:'bootstrap-observed',outcome}});
 assert.deepEqual(actions,['ensure-session','reconcile']);assert.equal(f.effects,0);
});

test('a stored noncanonical prefix is rejected before bootstrap, HTTP or evidence reads',async()=>{
 const f=fixture();f.state=evidenceFixture().state;f.state.entries[0].turnId=f.plan.phases[0].executions[1].turns[0].id;
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),{success:false,error:{code:'STATE_MISMATCH'}});
 assert.equal(f.effects,0);
});

test('observe archives the terminal first and waits for explicit review selection without sending or producing a receipt',async()=>{
 const f=fixture();f.state=evidenceFixture().state;let captures=0;
 f.deps.capture={async execute(input){assert.deepEqual(input,{plan:f.plan,turnId:f.turn.id});captures++;
  return {success:true,data:{kind:'awaiting-review',source:'captured',artifact:TerminalArtifactSchema.parse(f.artifact)}};}};
 const output=await new Sprint4Runner(f.deps).execute({action:'observe',plan:f.plan});
 assert.deepEqual(output,{success:true,data:{kind:'awaiting-review',turnId:f.turn.id,artifactRef:f.artifact.ref,gaps:['review-selection-required']}});
 assert.equal(captures,1);assert.equal(f.effects,0);assert.equal(f.state.entries[0].receipts.length,0);
});

test('captured evidence from a different plan is rejected before review selection',async()=>{
 const f=fixture();f.state=evidenceFixture().state;
 const payload={...f.payload,planHash:'b'.repeat(64)},sha256=terminalEvidenceHash(payload);
 f.deps.capture={async execute(){return {success:true,data:{kind:'awaiting-review',source:'archive',artifact:TerminalArtifactSchema.parse({ref:'terminal-sha256:'+sha256,sha256,payload})}};}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'observe',plan:f.plan}),{success:false,error:{code:'STATE_MISMATCH'}});
 assert.equal(f.effects,0);
});

test('a still-running job remains awaiting-job and observation does not trigger another submission',async()=>{
 const f=fixture();f.state=evidenceFixture().state;
 f.deps.capture={async execute(){return {success:false,error:{code:'AUDIT_FAILED',auditCode:'NOT_TERMINAL'}};}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'observe',plan:f.plan}),{success:true,data:{kind:'awaiting-job',turnId:f.turn.id}});
 assert.equal(f.effects,0);assert.equal(f.state.entries[0].receipts.length,0);
});

test('explicit review selection is resolved against the archived turn but missing criteria do not create a receipt',async()=>{
 const f=fixture();f.state=evidenceFixture().state;const selection={reviewId:'synthetic-review',criteriaArtifactRef:'criteria-sha256:'+'a'.repeat(64)};
 f.deps.capture={async execute(){return {success:true,data:{kind:'awaiting-review',source:'archive',artifact:TerminalArtifactSchema.parse(f.artifact)}};}};
 f.deps.review={async execute(input){assert.deepEqual(input,{plan:f.plan,turnId:f.turn.id,...selection});return {success:true,data:{kind:'awaiting-review',turnId:f.turn.id,gaps:['human-intent-review']}};}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'observe',plan:f.plan,review:selection}),
  {success:true,data:{kind:'awaiting-review',turnId:f.turn.id,artifactRef:f.artifact.ref,gaps:['human-intent-review']}});
 assert.equal(f.effects,0);assert.equal(f.state.entries[0].receipts.length,0);
});

test('a passed string in the journal cannot advance when its referenced evidence cannot be reread',async()=>{
 const f=fixture();f.state=evidenceFixture().state;const receipt=terminalReceipt(f);
 f.state.entries[0].receipts.push(receipt);let verifications=0;
 f.deps.review={async execute(input){assert.deepEqual(input,{plan:f.plan,turnId:f.turn.id,receipt});verifications++;
  return {success:true,data:{kind:'awaiting-review',turnId:f.turn.id,gaps:['criteria-artifact-missing']}};}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),
  {success:true,data:{kind:'awaiting-review',turnId:f.turn.id,artifactRef:f.artifact.ref,gaps:['criteria-artifact-missing']}});
 assert.equal(verifications,1);assert.equal(f.effects,0);assert.equal(f.state.entries.length,1);
});

test('advance prepares the exact execution then delegates the one dispatch to HTTP without consuming controller.next first',async()=>{
 const f=fixture(),calls:string[]=[],execution=f.plan.phases[0].executions[0];
 const intent=BootstrapIntentSchema.parse({kind:'sprint4-session-intent-v1',runId:f.plan.request.runId,executionId:execution.id,
  planHash:terminalEvidenceHash(f.plan),actorUserId:f.plan.request.actorUserId,target:f.plan.request.target,requestId:'22222222-2222-4222-8222-222222222222',
  mode:'evaluation',label:'Synthetic session',scenario:'free',createdAtMs:1000});
 const session={id:'11111111-1111-4111-8111-111111111111',candidateId:'33333333-3333-4333-8333-333333333333',label:intent.label,scenario:'free' as const,versionId:f.plan.request.target.versionId,state:'automatic'};
 f.deps.bootstrap={async execute(input){assert.deepEqual(input,{action:'ensure-session',plan:f.plan,executionId:execution.id});calls.push('bootstrap');
  return {success:true,data:{kind:'session-recorded',executionId:execution.id,record:{intent,observation:{kind:'sprint4-session-observation-v1',intentHash:terminalEvidenceHash(intent),source:'http',evidenceRef:'fixture',observedAtMs:1000,session}}}};}};
 const outcome={success:true as const,data:{kind:'submission-confirmed' as const,turnId:f.turn.id,requestId:intent.requestId,sessionId:session.id,jobId:'synthetic-job',
  detail:{session,messages:[],job:null},observedAtMs:1500,executionAudit:'pending' as const}};
 f.deps.http={async execute(input){assert.deepEqual(input,{action:'advance',plan:f.plan,expectedTurnId:f.turn.id});calls.push('http');return outcome;}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),{success:true,data:{kind:'advance-observed',outcome}});
 assert.deepEqual(calls,['bootstrap','http']);assert.equal(f.effects,0);
});

test('a recorded bootstrap with mismatched plan, actor, execution, mode or observation cannot reach HTTP',async()=>{
 for(const field of ['planHash','actorUserId','executionId','mode','intentHash','versionId','time','label','scenario']){
  const f=fixture(),execution=f.plan.phases[0].executions[0];
  const intent=BootstrapIntentSchema.parse({kind:'sprint4-session-intent-v1',runId:f.plan.request.runId,executionId:execution.id,
   planHash:terminalEvidenceHash(f.plan),actorUserId:f.plan.request.actorUserId,target:f.plan.request.target,
   requestId:'22222222-2222-4222-8222-222222222222',mode:'evaluation',label:'Synthetic session',scenario:'free',createdAtMs:1000});
  if(field==='planHash')intent.planHash='b'.repeat(64);
  if(field==='actorUserId')intent.actorUserId='different-actor';
  if(field==='executionId')intent.executionId='different-execution';
  if(field==='mode')intent.mode='published';
  const observation={kind:'sprint4-session-observation-v1' as const,intentHash:terminalEvidenceHash(intent),source:'http' as const,evidenceRef:'fixture',observedAtMs:1000,
   session:{id:'11111111-1111-4111-8111-111111111111',candidateId:'33333333-3333-4333-8333-333333333333',label:intent.label,scenario:'free' as const,versionId:f.plan.request.target.versionId,state:'automatic'}};
  if(field==='intentHash')observation.intentHash='c'.repeat(64);
  if(field==='versionId')observation.session.versionId='different-version';
  if(field==='time')observation.observedAtMs=999;
  if(field==='label')observation.session.label='Different session';
  if(field==='scenario')intent.scenario='investment';
  f.deps.bootstrap={async execute(){return {success:true,data:{kind:'session-recorded',executionId:execution.id,record:{intent,observation}}};}};
  assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'advance',plan:f.plan}),{success:false,error:{code:'STATE_MISMATCH'}},field);
  assert.equal(f.effects,0,field);
 }
});

test('a reviewed receipt with a different reservation is rejected before durable recording',async()=>{
 const f=fixture();f.state=evidenceFixture().state;
 const receipt={...terminalReceipt(f),objectiveAudit:'failed' as const,criticalCodes:['O2:failed'],
  preparation:{...f.observation.preparation!,reservationId:'different-reservation'},
  ledger:{...terminalReceipt(f).ledger,reservationId:'different-reservation'}};
 f.deps.capture={async execute(){return {success:true,data:{kind:'awaiting-review',source:'archive',artifact:TerminalArtifactSchema.parse(f.artifact)}};}};
 f.deps.review={async execute(){return {success:true,data:{kind:'halted',turnId:f.turn.id,findings:['O2:failed'],receipt}};}};
 assert.deepEqual(await new Sprint4Runner(f.deps).execute({action:'observe',plan:f.plan,
  review:{reviewId:'synthetic-review',criteriaArtifactRef:'criteria-sha256:'+'a'.repeat(64)}}),{success:false,error:{code:'STATE_MISMATCH'}});
 assert.equal(f.effects,0);assert.equal(f.state.entries[0].receipts.length,0);
});
