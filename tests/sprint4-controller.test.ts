import test from 'node:test';
import assert from 'node:assert/strict';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { Sprint4Controller } from '../evaluations/sprint4-controller.js';
import type { AdmissionEvidence, CampaignJournal, ControllerState, Receipt } from '../evaluations/sprint4-controller.spec.js';

const planned=new Sprint4CampaignPlanner().execute({runId:'controller-fixture',actorUserId:'fixture-admin',target:{versionId:'fixture-version',contentHash:'a'.repeat(64),model:'gpt-5.4-2026-03-05'}});
assert.ok(planned.success);const plan=planned.data;
const turns=plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns));
function fixture(){
 let state:ControllerState|null=null,inspections=0;
 const journal:CampaignJournal={async read(){return structuredClone(state);},async compareAndSwap(_run,revision,next){if((state?.revision??null)!==revision)return false;state=structuredClone(next);return true;}};
 const evidence:AdmissionEvidence={turnId:turns[0].id,actorUserId:plan.request.actorUserId,target:plan.request.target,evidenceRef:'private-admission-1',
  observedAtMs:1000,validUntilMs:2000,adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,
  tenantId:'cognita-homologacao',brandId:'sapore',executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,
  sessionId:'fixture-session-1',sessionOwned:true,sessionReady:true,sessionFresh:true,requestId:'11111111-1111-4111-8111-111111111111',
  budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1_000_000,accountedMicroUsd:400_000,maxReservationMicroUsd:60000,remainingCampaignReviewed:true},
  daily:{actorUserId:plan.request.actorUserId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}};
 const port={nowMs:()=>1100,async inspect(){inspections++;return structuredClone(evidence);}};
 return {journal,evidence,port,get state(){return state;},get inspections(){return inspections;},controller:new Sprint4Controller(journal,port)};
}
function receipt(f:ReturnType<typeof fixture>,kind:Receipt['kind']='terminal'):Receipt{
 const intent=f.state!.entries.at(-1)!;
 return {receiptId:`receipt-${intent.turnId}-${kind}`,turnId:intent.turnId,requestId:intent.admission.requestId,sessionId:intent.admission.sessionId,target:plan.request.target,
  observedAtMs:1500,kind,jobId:`job:${intent.turnId}`,jobDeadlineAtMs:61000,
  preparation:kind==='accepted'?null:{attempt:1,inputTokenBound:16000,reservedMicroUsd:58000,reservationId:`reserve:${intent.turnId}`},
  evidenceRef:'private-audit-ref',jobState:kind==='terminal'?'completed':kind==='accepted'?'pending':'working',guardCodes:[],criticalCodes:[],
  objectiveAudit:kind==='terminal'?'passed':'pending',ledger:{reservationId:kind==='accepted'?null:`reserve:${intent.turnId}`,state:kind==='terminal'?'settled':kind==='accepted'?'not-reserved':'reserved',costMicroUsd:kind==='terminal'?10000:null},
  responseArtifactRef:kind==='terminal'?'private-response-ref':null,rawArtifactRef:null};
}

test('a settled terminal observation awaiting review stays resumable without dispatching or erasing its history',async()=>{
 const f=fixture();await f.controller.execute({action:'next',plan});
 const observed={...receipt(f),receiptId:'terminal-awaiting-review',objectiveAudit:'pending' as const};
 const recorded=await f.controller.execute({action:'record',plan,receipt:observed});assert.ok(recorded.success);
 assert.deepEqual(recorded.data,{kind:'recorded',turnId:turns[0].id,duplicate:false});
 const resumed=new Sprint4Controller(f.journal,f.port);
 const waiting=await resumed.execute({action:'next',plan});assert.ok(waiting.success);
 assert.deepEqual(waiting.data,{kind:'awaiting-receipt',turnId:turns[0].id});
 assert.equal(f.inspections,1);assert.equal(f.state!.entries.length,1);
 const audited={...observed,receiptId:'terminal-final-review',objectiveAudit:'passed' as const,observedAtMs:1700};
 const confirmed=await resumed.execute({action:'record',plan,receipt:audited});assert.ok(confirmed.success);
 assert.equal(confirmed.data.kind,'recorded');
 f.evidence.turnId=turns[1].id;f.evidence.sessionFresh=false;f.evidence.requestId='22222222-2222-4222-8222-222222222222';
 const next=await resumed.execute({action:'next',plan});assert.ok(next.success);assert.equal(next.data.kind,'dispatch-once');
 assert.deepEqual(f.state!.entries[0].receipts,[observed,audited]);
});

test('an expected turn mismatch is blocked before admission inspection or durable dispatch intent',async()=>{
 const f=fixture();
 const result=await f.controller.execute({action:'next',plan,expectedTurnId:turns[1].id});
 assert.ok(!result.success);assert.equal(result.error.code,'GATE_BLOCKED');
 assert.equal(f.inspections,0);assert.equal(f.state,null);
 const permitted=await f.controller.execute({action:'next',plan,expectedTurnId:turns[0].id});
 assert.ok(permitted.success);assert.equal(permitted.data.kind,'dispatch-once');assert.equal(f.inspections,1);
});

test('first next durably records one intent before returning the exact first planned input',async()=>{
 const f=fixture(),result=await f.controller.execute({action:'next',plan});assert.ok(result.success);
 assert.equal(result.data.kind,'dispatch-once');if(result.data.kind!=='dispatch-once')return;
 assert.equal(result.data.turnId,turns[0].id);assert.equal(result.data.input,turns[0].input);
 assert.equal(result.data.requestId,f.evidence.requestId);assert.deepEqual(result.data.target,plan.request.target);
 assert.deepEqual(result.data.campaignAdmission,{runId:plan.request.runId,turnId:turns[0].id,target:plan.request.target,maxReservationMicroUsd:60000,submitBeforeMs:2000});
 assert.equal(f.state?.protocol,'sprint4-admission-v2');
 assert.equal(f.state?.revision,1);assert.equal(f.state?.entries.length,1);assert.deepEqual(f.state?.entries[0].receipts,[]);
 assert.equal(f.inspections,1);assert.equal(f.state?.plan.readyToExecute,false);
});

test('dispatch expires at the submission evidence deadline without inventing a future job deadline',async()=>{
 const f=fixture();f.evidence.validUntilMs=1500;
 const result=await f.controller.execute({action:'next',plan});assert.ok(result.success);assert.equal(result.data.kind,'dispatch-once');
 if(result.data.kind==='dispatch-once')assert.equal(result.data.validUntilMs,1500);
 assert.equal(f.state?.entries[0].admission.validUntilMs,1500,'preserve the original submission deadline');
 assert.equal('deadlineAtMs' in f.state!.entries[0].admission,false);
});

test('a resumed journal must remain a canonical prefix and cannot silently skip or relabel previous turns',async()=>{
 const f=fixture();await f.controller.execute({action:'next',plan});await f.controller.execute({action:'record',plan,receipt:receipt(f)});
 f.evidence.turnId=turns[1].id;f.evidence.sessionFresh=false;f.evidence.requestId='22222222-2222-4222-8222-222222222222';
 await f.controller.execute({action:'next',plan});await f.controller.execute({action:'record',plan,receipt:receipt(f)});
 f.state!.entries[0].turnId=turns[2].id;
 f.evidence.turnId=turns[2].id;f.evidence.sessionFresh=true;f.evidence.sessionId='fixture-session-2';f.evidence.requestId='33333333-3333-4333-8333-333333333333';
 const revision=f.state!.revision,inspections=f.inspections,result=await f.controller.execute({action:'next',plan});
 assert.equal(result.success,false);if(!result.success)assert.equal(result.error.code,'STATE_MISMATCH');
 assert.equal(f.inspections,inspections);assert.equal(f.state!.revision,revision);
});

test('terminal audit cannot hide missing jobs, excess cost or reuse a prior turn job and reservation',async()=>{
 for(const kind of ['missing-job','excess-cost']){
  const f=fixture();await f.controller.execute({action:'next',plan});const value=receipt(f);
  if(kind==='missing-job')value.jobId=null;else value.ledger.costMicroUsd=58001;
  const result=await f.controller.execute({action:'record',plan,receipt:value});assert.ok(result.success);
  assert.deepEqual(result.data,{kind:'halted',turnId:turns[0].id,reason:kind==='missing-job'?'ambiguous':'critical'});
 }
 const f=fixture();await f.controller.execute({action:'next',plan});const first=receipt(f);await f.controller.execute({action:'record',plan,receipt:first});
 f.evidence.turnId=turns[1].id;f.evidence.sessionFresh=false;f.evidence.requestId='22222222-2222-4222-8222-222222222222';await f.controller.execute({action:'next',plan});
 const second=receipt(f);
 assert.equal((await f.controller.execute({action:'record',plan,receipt:{...second,jobId:first.jobId}})).success,false);
 assert.equal((await f.controller.execute({action:'record',plan,receipt:{...second,ledger:{...second.ledger,reservationId:first.ledger.reservationId}}})).success,false);
 assert.equal(f.state?.entries[1].receipts.length,0);
});

test('lost commit acknowledgment or expired preflight cannot cause an automatic resend after restart',async()=>{
 const lost=fixture();let commits=0;
 const flaky:CampaignJournal={read:lost.journal.read,async compareAndSwap(run,revision,next){commits++;await lost.journal.compareAndSwap(run,revision,next);throw new Error('simulated lost acknowledgment');}};
 const failed=await new Sprint4Controller(flaky,lost.port).execute({action:'next',plan});assert.equal(failed.success,false);assert.equal(commits,1);
 const recovered=await new Sprint4Controller(lost.journal,lost.port).execute({action:'next',plan});assert.ok(recovered.success);assert.equal(recovered.data.kind,'awaiting-receipt');
 const slow=fixture();let clockCalls=0;
 const port={...slow.port,nowMs:()=>++clockCalls===1?1100:2100};
 const expired=await new Sprint4Controller(slow.journal,port).execute({action:'next',plan});assert.equal(expired.success,false);
 assert.equal(slow.state?.entries.length,1,'persisted intent remains conservatively consumed even if the send action was never issued');
 const resumed=await new Sprint4Controller(slow.journal,slow.port).execute({action:'next',plan});assert.ok(resumed.success);assert.equal(resumed.data.kind,'awaiting-receipt');
});

test('a later turn cannot reuse a request ID or claim a previous case session as fresh',async()=>{
 const f=fixture();await f.controller.execute({action:'next',plan});await f.controller.execute({action:'record',plan,receipt:receipt(f)});
 f.evidence.turnId=turns[1].id;f.evidence.sessionFresh=false;
 assert.equal((await f.controller.execute({action:'next',plan})).success,false);assert.equal(f.state?.entries.length,1);
 f.evidence.requestId='22222222-2222-4222-8222-222222222222';
 assert.equal((await f.controller.execute({action:'next',plan})).success,true);
 await f.controller.execute({action:'record',plan,receipt:receipt(f)});
 f.evidence.turnId=turns[2].id;f.evidence.sessionFresh=true;f.evidence.requestId='33333333-3333-4333-8333-333333333333';
 assert.equal((await f.controller.execute({action:'next',plan})).success,false);assert.equal(f.state?.entries.length,2);
 f.evidence.sessionId='fixture-session-2';const next=await f.controller.execute({action:'next',plan});assert.ok(next.success);assert.equal(next.data.kind,'dispatch-once');
});

test('all sixty-six candidate turns precede separately published M6 and finishing sequence leaves acceptance pending',async()=>{
 const f=fixture();let published=false;
 const port={nowMs:f.port.nowMs,async inspect(request:{turnId:string;expectedSessionId:string|null}){
  const index=turns.findIndex(turn=>turn.id===request.turnId);
  return {...f.evidence,turnId:request.turnId,published,sessionFresh:request.expectedSessionId===null,
   sessionId:request.expectedSessionId??`session-${index}`,requestId:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`};
 }};
 const controller=new Sprint4Controller(f.journal,port);
 for(let index=0;index<turns.length;index++){
  if(index===66){const blocked=await controller.execute({action:'next',plan});assert.equal(blocked.success,false);assert.equal(f.state?.entries.length,66);published=true;}
  const next=await controller.execute({action:'next',plan});assert.ok(next.success);assert.equal(next.data.kind,'dispatch-once');
  if(next.data.kind==='dispatch-once')assert.equal(next.data.turnId,turns[index].id);
  const recorded=await controller.execute({action:'record',plan,receipt:receipt(f)});assert.ok(recorded.success);assert.equal(recorded.data.kind,'recorded');
 }
 const end=await controller.execute({action:'next',plan});assert.ok(end.success);
 assert.deepEqual(end.data,{kind:'sequence-recorded',turnsRecorded:72,acceptance:'pending'});
 assert.equal(new Set(f.state!.entries.map(entry=>entry.admission.sessionId)).size,63);
 assert.equal(f.state!.plan.pendingGates.includes('human-average-at-least-4'),true);
});

test('receipt replay is idempotent and conflicting IDs, job identity or intent pins cannot overwrite evidence',async()=>{
 const f=fixture();await f.controller.execute({action:'next',plan});const accepted=receipt(f,'accepted');
 await f.controller.execute({action:'record',plan,receipt:accepted});const revision=f.state!.revision;
 const replay=await f.controller.execute({action:'record',plan,receipt:accepted});assert.ok(replay.success);
 assert.deepEqual(replay.data,{kind:'recorded',turnId:turns[0].id,duplicate:true});assert.equal(f.state?.revision,revision);
 const mutations:Array<(value:Receipt)=>void>=[
  value=>{value.evidenceRef='different-evidence';},value=>{value.turnId=turns[1].id;},value=>{value.sessionId='other-session';},
  value=>{value.requestId='22222222-2222-4222-8222-222222222222';},value=>{value.target={...value.target,versionId:'other-version'};},
 ];
 for(const mutate of mutations){const altered=structuredClone(accepted);mutate(altered);assert.equal((await f.controller.execute({action:'record',plan,receipt:altered})).success,false);}
 const differentJob={...receipt(f),jobId:'another-job'};assert.equal((await f.controller.execute({action:'record',plan,receipt:differentJob})).success,false);
 assert.equal(f.state?.revision,revision);assert.equal(f.state?.entries[0].receipts.length,1);
});

test('critical, failed and ambiguous outcomes halt immediately and a late success never erases a timeout',async()=>{
 const variants:Array<{change:(value:Receipt)=>void;reason:string}>=[
  {change:value=>{value.criticalCodes=['ISOLATION_VIOLATION'];},reason:'critical'},
  {change:value=>{value.kind='ambiguous';value.jobState='unknown';value.jobId=null;},reason:'ambiguous'},
  {change:value=>{value.ledger.state='reserved';value.ledger.costMicroUsd=null;},reason:'ambiguous'},
  {change:value=>{value.jobState='failed';value.objectiveAudit='failed';},reason:'failed'},
  {change:value=>{value.guardCodes=['POLICY_GUARD'];},reason:'failed'},
 ];
 for(const variant of variants){
  const f=fixture();await f.controller.execute({action:'next',plan});const bad=receipt(f);variant.change(bad);
  const recorded=await f.controller.execute({action:'record',plan,receipt:bad});assert.ok(recorded.success);
  assert.deepEqual(recorded.data,{kind:'halted',turnId:turns[0].id,reason:variant.reason});
  const late={...receipt(f),receiptId:'late-terminal-audit'};await f.controller.execute({action:'record',plan,receipt:late});
  const resumed=await new Sprint4Controller(f.journal,f.port).execute({action:'next',plan});assert.ok(resumed.success);
  assert.deepEqual(resumed.data,{kind:'halted',turnId:turns[0].id,reason:variant.reason});
  assert.equal(f.state?.entries.length,1);assert.equal(f.state?.entries[0].receipts.length,2);assert.equal(f.inspections,1);
 }
});

test('an accepted job is not completion; only a matching terminal audited receipt advances T2 in the same session',async()=>{
 const f=fixture();await f.controller.execute({action:'next',plan});
 const accepted=await f.controller.execute({action:'record',plan,receipt:receipt(f,'accepted')});assert.ok(accepted.success);assert.equal(accepted.data.kind,'recorded');
 const pending=await f.controller.execute({action:'next',plan});assert.ok(pending.success);assert.equal(pending.data.kind,'awaiting-receipt');
 const terminal=await f.controller.execute({action:'record',plan,receipt:receipt(f)});assert.ok(terminal.success);assert.equal(terminal.data.kind,'recorded');
 f.evidence.turnId=turns[1].id;f.evidence.sessionFresh=false;f.evidence.requestId='22222222-2222-4222-8222-222222222222';
 const next=await f.controller.execute({action:'next',plan});assert.ok(next.success);assert.equal(next.data.kind,'dispatch-once');
 if(next.data.kind==='dispatch-once'){assert.equal(next.data.turnId,turns[1].id);assert.equal(next.data.sessionId,'fixture-session-1');}
 assert.equal(f.state?.entries.length,2);assert.equal(f.state?.entries[0].receipts.length,2);
 assert.equal(f.state?.entries[0].receipts[1].rawArtifactRef,null);assert.equal(f.state?.plan.phases[0].executions[0].humanReview.scores,null);
});

test('each dispatch requires fresh injected authority, exact pins, safe scope, an affordable ceiling and daily capacity',async()=>{
 const mutations:Array<(evidence:AdmissionEvidence)=>void>=[
  evidence=>{evidence.adminActive=false;},evidence=>{evidence.actorUserId='other-actor';},evidence=>{evidence.target={...evidence.target,contentHash:'b'.repeat(64)};},
  evidence=>{evidence.turnId=turns[1].id;},evidence=>{evidence.validUntilMs=1099;},evidence=>{evidence.observedAtMs=1101;},
  evidence=>{evidence.routeValidated=false;},evidence=>{evidence.healthy=false;},evidence=>{evidence.noUnexpectedJobs=false;},
  evidence=>{evidence.sessionOwned=false;},evidence=>{evidence.sessionReady=false;},evidence=>{evidence.sessionFresh=false;},
  evidence=>{evidence.budget.accountedMicroUsd=950_000;},evidence=>{evidence.budget.maxReservationMicroUsd=1;},evidence=>{evidence.budget.remainingCampaignReviewed=false;},
  evidence=>{evidence.daily.usedMessages=100;},evidence=>{evidence.daily.actorUserId='other-actor';},evidence=>{evidence.daily.stageAndControlsReviewed=false;},
 ];
 for(const mutate of mutations){const f=fixture();mutate(f.evidence);const result=await f.controller.execute({action:'next',plan});
  assert.equal(result.success,false);if(!result.success)assert.equal(result.error.code,'GATE_BLOCKED');assert.equal(f.state,null);}
 const unsafe=fixture();const port={...unsafe.port,async inspect(){return {...unsafe.evidence,channelEnabled:true};}};
 assert.equal((await new Sprint4Controller(unsafe.journal,port).execute({action:'next',plan})).success,false);assert.equal(unsafe.state,null);
});

test('concurrent controllers and resumed processes never issue a second dispatch while the intent is unresolved',async()=>{
 const f=fixture(),other=new Sprint4Controller(f.journal,f.port);
 const results=await Promise.all([f.controller.execute({action:'next',plan}),other.execute({action:'next',plan})]);
 assert.equal(results.filter(result=>result.success&&result.data.kind==='dispatch-once').length,1);
 const resumed=await new Sprint4Controller(f.journal,f.port).execute({action:'next',plan});
 assert.ok(resumed.success);assert.deepEqual(resumed.data,{kind:'awaiting-receipt',turnId:turns[0].id});
 assert.equal(f.state?.entries.length,1);
});

test('a terminal receipt cannot claim success without a measured preparation, real deadline and matching reservation formula',async()=>{
 const variants:Array<(value:Receipt)=>void>=[value=>{value.preparation=null;},value=>{value.jobDeadlineAtMs=null;},
  value=>{value.preparation!.inputTokenBound=16001;},value=>{value.preparation!.reservationId='different-reservation';}];
 for(const mutate of variants){
  const f=fixture();await f.controller.execute({action:'next',plan});const terminal=receipt(f);mutate(terminal);
  const result=await f.controller.execute({action:'record',plan,receipt:terminal});assert.ok(result.success);
  assert.deepEqual(result.data,{kind:'halted',turnId:turns[0].id,reason:'ambiguous'});
  assert.equal(f.state!.entries[0].receipts.length,1,'retain the incomplete evidence instead of inventing missing measurements');
  const resumed=await f.controller.execute({action:'next',plan});assert.ok(resumed.success);assert.equal(resumed.data.kind,'halted');
 }
});

test('a measured preparation fixes attempt, reservation and job deadline while a later audit may outlive submission validity',async()=>{
 const f=fixture();await f.controller.execute({action:'next',plan});
 await f.controller.execute({action:'record',plan,receipt:receipt(f,'accepted')});
 const prepared=receipt(f,'prepared');prepared.preparation!.attempt=2;prepared.observedAtMs=2500;
 const recorded=await f.controller.execute({action:'record',plan,receipt:prepared});assert.ok(recorded.success);assert.equal(recorded.data.kind,'recorded');
 const revision=f.state!.revision;
 const variants:Array<(value:Receipt)=>void>=[value=>{value.jobDeadlineAtMs=62000;},value=>{value.preparation!.attempt=3;},
  value=>{value.preparation!.inputTokenBound=16002;value.preparation!.reservedMicroUsd=58005;},
  value=>{value.preparation!.reservationId='other-reservation';value.ledger.reservationId='other-reservation';}];
 for(const mutate of variants){
  const terminal=receipt(f);terminal.preparation=structuredClone(prepared.preparation);terminal.observedAtMs=3500;mutate(terminal);
  const result=await f.controller.execute({action:'record',plan,receipt:terminal});assert.equal(result.success,false);
  if(!result.success)assert.equal(result.error.code,'RECEIPT_MISMATCH');assert.equal(f.state!.revision,revision);
 }
 const terminal=receipt(f);terminal.preparation=structuredClone(prepared.preparation);terminal.observedAtMs=3500;
 const result=await f.controller.execute({action:'record',plan,receipt:terminal});assert.ok(result.success);assert.equal(result.data.kind,'recorded');
 assert.equal(f.state!.entries[0].admission.validUntilMs,2000);assert.equal(f.state!.entries[0].receipts.length,3);
 assert.equal(f.state!.entries[0].receipts[0].preparation,null,'never retrofit preparation into the accepted observation');
});

test('preparation evidence cannot silently omit a reservation or exceed the admitted ceiling',async()=>{
 const variants:Array<{mutate:(value:Receipt)=>void;reason:string}>=[
  {mutate:value=>{value.preparation=null;},reason:'ambiguous'},
  {mutate:value=>{value.jobDeadlineAtMs=null;},reason:'ambiguous'},
  {mutate:value=>{value.jobId=null;},reason:'ambiguous'},
  {mutate:value=>{value.ledger.state='not-reserved';},reason:'ambiguous'},
  {mutate:value=>{value.preparation!.inputTokenBound=16801;value.preparation!.reservedMicroUsd=60003;},reason:'critical'},
 ];
 for(const {mutate,reason} of variants){
  const f=fixture();await f.controller.execute({action:'next',plan});const prepared=receipt(f,'prepared');mutate(prepared);
  const result=await f.controller.execute({action:'record',plan,receipt:prepared});assert.ok(result.success);
  assert.deepEqual(result.data,{kind:'halted',turnId:turns[0].id,reason});
  assert.equal(f.state!.entries[0].receipts.length,1);
 }
});

test('an accepted observation with missing job identity or contradictory ledger is halted, never treated as a clean queued job',async()=>{
 const variants:Array<(value:Receipt)=>void>=[value=>{value.jobId=null;},value=>{value.jobDeadlineAtMs=null;},
  value=>{value.ledger.state='unknown';},value=>{value.ledger.costMicroUsd=1;},value=>{value.ledger.reservationId='unexplained';}];
 for(const mutate of variants){
  const f=fixture();await f.controller.execute({action:'next',plan});const accepted=receipt(f,'accepted');mutate(accepted);
  const result=await f.controller.execute({action:'record',plan,receipt:accepted});assert.ok(result.success);
  assert.deepEqual(result.data,{kind:'halted',turnId:turns[0].id,reason:'ambiguous'});
 }
});

test('resumption rejects stored admission identity changes and conflicting measured receipt identities before further inspection',async()=>{
 const variants:Array<(state:ControllerState)=>void>=[
  state=>{state.entries[0].admission.actorUserId='other-admin';},
  state=>{state.entries[0].admission.target.contentHash='b'.repeat(64);},
  state=>{state.entries[0].receipts[1].jobDeadlineAtMs=62000;},
  state=>{state.entries[0].receipts[1].preparation!.attempt=2;},
 ];
 for(const mutate of variants){
  const f=fixture();await f.controller.execute({action:'next',plan});
  await f.controller.execute({action:'record',plan,receipt:receipt(f,'prepared')});await f.controller.execute({action:'record',plan,receipt:receipt(f)});
  mutate(f.state!);const before=JSON.stringify(f.state),inspections=f.inspections;
  const result=await f.controller.execute({action:'next',plan});assert.equal(result.success,false);
  if(!result.success)assert.equal(result.error.code,'STATE_MISMATCH');
  assert.equal(f.inspections,inspections);assert.equal(JSON.stringify(f.state),before);
 }
});

test('resumption rechecks cross-turn request, job and reservation uniqueness and the exact T2 session dependency',async()=>{
 const variants:Array<(state:ControllerState)=>void>=[
  state=>{const [a,b]=state.entries;b.admission.requestId=a.admission.requestId;b.receipts[0].requestId=a.admission.requestId;},
  state=>{const [a,b]=state.entries;b.receipts[0].jobId=a.receipts[0].jobId;},
  state=>{const [a,b]=state.entries;b.receipts[0].ledger.reservationId=a.receipts[0].ledger.reservationId;b.receipts[0].preparation!.reservationId=a.receipts[0].preparation!.reservationId;},
  state=>{const b=state.entries[1];b.admission.sessionId='another-session';b.receipts[0].sessionId='another-session';},
 ];
 for(const mutate of variants){
  const f=fixture();await f.controller.execute({action:'next',plan});await f.controller.execute({action:'record',plan,receipt:receipt(f)});
  f.evidence.turnId=turns[1].id;f.evidence.sessionFresh=false;f.evidence.requestId='22222222-2222-4222-8222-222222222222';
  assert.equal((await f.controller.execute({action:'next',plan})).success,true);await f.controller.execute({action:'record',plan,receipt:receipt(f)});
  f.evidence.turnId=turns[2].id;f.evidence.sessionFresh=true;f.evidence.sessionId='fresh-session';f.evidence.requestId='33333333-3333-4333-8333-333333333333';
  mutate(f.state!);const before=JSON.stringify(f.state),inspections=f.inspections;
  const result=await f.controller.execute({action:'next',plan});assert.equal(result.success,false);
  if(!result.success)assert.equal(result.error.code,'STATE_MISMATCH');
  assert.equal(f.inspections,inspections);assert.equal(JSON.stringify(f.state),before);
 }
});

test('a claimed job deadline cannot predate admission, while auditing after the real deadline remains valid',async()=>{
 const f=fixture();await f.controller.execute({action:'next',plan});const impossible=receipt(f);impossible.jobDeadlineAtMs=1000;
 const failed=await f.controller.execute({action:'record',plan,receipt:impossible});assert.ok(failed.success);
 assert.deepEqual(failed.data,{kind:'halted',turnId:turns[0].id,reason:'ambiguous'});
 const valid=fixture();await valid.controller.execute({action:'next',plan});const late=receipt(valid);late.observedAtMs=70000;
 const result=await valid.controller.execute({action:'record',plan,receipt:late});assert.ok(result.success);assert.equal(result.data.kind,'recorded');
});

test('a nonterminal receipt carrying a failure or terminal job state halts instead of waiting indefinitely',async()=>{
 for(const kind of ['accepted','prepared'] as const)for(const jobState of ['failed','handoff','stale','cancelled','completed','unknown'] as const){
  const f=fixture();await f.controller.execute({action:'next',plan});const value=receipt(f,kind);value.jobState=jobState;
  const result=await f.controller.execute({action:'record',plan,receipt:value});assert.ok(result.success);
  assert.deepEqual(result.data,{kind:'halted',turnId:turns[0].id,reason:['completed','unknown'].includes(jobState)?'ambiguous':'failed'});
 }
 const f=fixture();await f.controller.execute({action:'next',plan});const prepared=receipt(f,'prepared');prepared.objectiveAudit='failed';
 const result=await f.controller.execute({action:'record',plan,receipt:prepared});assert.ok(result.success);
 assert.deepEqual(result.data,{kind:'halted',turnId:turns[0].id,reason:'failed'});
});
