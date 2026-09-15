import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SPRINT4_CASES, type CampaignPlan } from '../evaluations/sprint4-campaign.spec.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';

const input={runId:'sprint4-example',actorUserId:'admin-example',target:{versionId:'draft-example',contentHash:'a'.repeat(64),model:'gpt-5.4-2026-03-05'}};
const planner=new Sprint4CampaignPlanner();
const matrix=()=>SPRINT4_CASES.map(item=>({...item,inputs:[...item.inputs]}));

test('the typed campaign preserves all thirty approved cases and their exact thirty-three inputs',async()=>{
 const document=await readFile(new URL('../docs/sprints/SPRINT-04-META-PLANO-AVALIACAO.md',import.meta.url),'utf8');
 const expected=document.split('\n').flatMap(line=>{
  const match=line.match(/^\| (C\d{2}) — (.+), [12] turnos? \| (.*?) \|/u);
  return match?[{caseId:match[1],title:match[2],inputs:match[3].replace(/^\*\*T1:\*\* /,'').split('<br>**T2:** ')}]:[];
 });
 assert.equal(expected.length,30,'the approved document must contain the full matrix');
 assert.deepEqual(SPRINT4_CASES,expected);
 assert.equal(SPRINT4_CASES.reduce((count,item)=>count+item.inputs.length,0),33);
 assert.deepEqual(SPRINT4_CASES.filter(item=>item.inputs.length===2).map(item=>item.caseId),['C01','C02','C03']);
});

test('each two-turn case requires a fresh session and an audited terminal first turn before its dependent turn',()=>{
 const result=planner.execute(input);assert.ok(result.success);
 const executions=result.data.phases.flatMap(phase=>phase.executions);
 for(const execution of executions){
  assert.equal(execution.requiresFreshSession,true);
  assert.equal(execution.turns[0].afterAuditedTerminalTurnId,null);
  if(execution.turns.length===2)assert.equal(execution.turns[1].afterAuditedTerminalTurnId,execution.turns[0].id);
 }
 const altered=structuredClone(result.data);altered.phases[0].executions[0].turns[1].afterAuditedTerminalTurnId=null;
 assert.equal(planner.validate(altered).success,false);
});

test('snapshot evidence cannot switch actor, reset the gate, expand the cap or authorize an exhausted campaign',()=>{
 const budgetSnapshot={gateId:'sprint3-continuous-20260910',limitMicroUsd:1_000_000,accountedMicroUsd:1_000_000,observedAt:'2026-09-11T22:23:21Z'};
 const dailySnapshot={actorUserId:input.actorUserId,usedMessages:100,observedAt:'2026-09-11T22:41:00Z'};
 assert.equal(planner.execute({...input,dailySnapshot:{...dailySnapshot,actorUserId:'another-user'}}).success,false);
 for(const invalid of [
  {budgetSnapshot:{...budgetSnapshot,gateId:'new-gate'}},{budgetSnapshot:{...budgetSnapshot,limitMicroUsd:2_000_000}},
  {budgetSnapshot:{...budgetSnapshot,accountedMicroUsd:-1}},{budgetSnapshot:{...budgetSnapshot,observedAt:'yesterday'}},
  {dailySnapshot:{...dailySnapshot,usedMessages:101}},{nextReservationMicroUsd:0},{nextReservationMicroUsd:1.5},
  {runId:'invalid/run'}, {cases:[]}, {extra:'unknown-input'},
 ])assert.equal(planner.execute({...input,...invalid}).success,false);
 const exhausted=planner.execute({...input,budgetSnapshot,dailySnapshot,nextReservationMicroUsd:1});assert.ok(exhausted.success);
 assert.equal(exhausted.data.checks.budget.availableMicroUsd,0);assert.equal(exhausted.data.checks.budget.nextReservationCovered,false);
 assert.equal(exhausted.data.checks.daily.availableMessages,0);assert.equal(exhausted.data.checks.daily.nextRepetitionFitsWindow,false);
 assert.equal(exhausted.data.readyToExecute,false);
 const exact=planner.execute({...input,budgetSnapshot:{...budgetSnapshot,accountedMicroUsd:999_999},nextReservationMicroUsd:1,
  dailySnapshot:{...dailySnapshot,usedMessages:28}});assert.ok(exact.success);
 assert.equal(exact.data.checks.budget.nextReservationCovered,true);assert.equal(exact.data.checks.daily.campaignFitsWindow,true);
 assert.equal(exact.data.checks.daily.controlsNeedAdditionalCapacity,true);assert.equal(exact.data.readyToExecute,false);
});

test('budget and rolling daily checks remain provisional, use the existing gate and never infer an extra-spend minimum',()=>{
 const result=planner.execute({...input,
  budgetSnapshot:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1_000_000,accountedMicroUsd:359_814,observedAt:'2026-09-11T22:23:21Z'},
  nextReservationMicroUsd:67_348,
  dailySnapshot:{actorUserId:input.actorUserId,usedMessages:54,observedAt:'2026-09-11T22:41:00Z'},
 });assert.ok(result.success);
 const checks=result.data.checks;
 assert.equal(checks.pinsVerified,false);
 assert.deepEqual(checks.budget,{gateId:'sprint3-continuous-20260910',limitMicroUsd:1_000_000,availableMicroUsd:640_186,nextReservationCovered:true,
  campaignCostMicroUsd:null,minimumAdditionalSpendMicroUsd:null,requiresLiveRecheck:true});
 assert.deepEqual(checks.daily,{actorUserId:input.actorUserId,limitMessages:100,rollingWindowHours:24,availableMessages:46,nextRepetitionMessages:33,
  plannedContextualMessages:72,nextRepetitionFitsWindow:true,campaignFitsWindow:false,controlsNeedAdditionalCapacity:true,requiresLiveRecheck:true});
 assert.equal(result.data.readyToExecute,false);
 assert.ok(result.data.pendingGates.includes('budget-ledger-and-payload-reservation'));
 assert.ok(result.data.pendingGates.includes('actor-100-messages-rolling-24h'));
 assert.deepEqual(planner.validate(result.data),result);
 const missing=planner.execute(input);assert.ok(missing.success);
 assert.equal(missing.data.checks.budget.availableMicroUsd,null);assert.equal(missing.data.checks.budget.nextReservationCovered,null);
 assert.equal(missing.data.checks.daily.availableMessages,null);assert.equal(missing.data.checks.daily.campaignFitsWindow,null);
});

test('saved plans validate only with canonical IDs, pinned target, pending results and consistent phase counts',()=>{
 const result=planner.execute(input);assert.ok(result.success);
 assert.deepEqual(planner.validate(JSON.parse(JSON.stringify(result.data))),result);
 const mutations=[
  (plan:typeof result.data)=>{plan.phases[0].executions[1].id=plan.phases[0].executions[0].id;},
  (plan:typeof result.data)=>{plan.phases[0].executions[0].turns[1].id=plan.phases[0].executions[0].turns[0].id;},
  (plan:typeof result.data)=>{plan.phases[0].executions[0].target.versionId='different-version';},
  (plan:typeof result.data)=>{plan.phases[0].executions[0].target.contentHash='b'.repeat(64);},
  (plan:typeof result.data)=>{plan.counts.totalPaidCalls=66;},
  (plan:typeof result.data)=>{plan.phases[0].executions.pop();},
  (plan:typeof result.data)=>{plan.phases[0].executions[0].turns[0].input='Unapproved input';},
  (plan:typeof result.data)=>{plan.phases[1].requiresPublishedVersion=false;},
 ];
 for(const mutate of mutations){const altered:CampaignPlan=structuredClone(result.data);mutate(altered);assert.equal(planner.validate(altered).success,false);}
 const invented=JSON.parse(JSON.stringify(result.data));invented.phases[0].executions[0].humanReview.scores={quality:5};
 assert.equal(planner.validate(invented).success,false);
 assert.equal(planner.execute({...input,target:{...input.target,model:'other-model'}}).success,false);
 assert.equal(planner.execute({...input,target:{...input.target,contentHash:'not-a-hash'}}).success,false);
 const deferred=planner.execute({...input,m6Policy:'defer'});assert.ok(deferred.success);
 assert.equal(deferred.data.counts.totalPaidCalls,66);assert.equal(deferred.data.phases[1].scheduled,false);
 assert.equal(deferred.data.phases[1].executions.length,0);assert.ok(deferred.data.pendingGates.includes('m6'));
 assert.deepEqual(planner.validate(deferred.data),deferred);
});

test('planning rejects duplicate, incomplete, reordered or rewritten approved cases instead of accepting hard-coded counts',()=>{
 const duplicate=matrix();duplicate[29]=duplicate[0];
 assert.deepEqual(planner.execute({...input,cases:duplicate}),{success:false,error:{code:'DUPLICATE_IDS',message:'Duplicate campaign case IDs'}});
 const rewritten=matrix();rewritten[0].inputs[1]='Quem decide?';
 for(const cases of [matrix().slice(0,29),matrix().reverse(),rewritten]){
  const result=planner.execute({...input,cases});assert.equal(result.success,false);
  if(!result.success)assert.equal(result.error.code,'MATRIX_MISMATCH');
 }
});

test('default planning creates sixty candidate executions and three separate published M6 sessions with seventy-two pending turns',()=>{
 const planner=new Sprint4CampaignPlanner(),result=planner.execute(input);assert.ok(result.success);
 const plan=result.data;
 assert.deepEqual(planner.execute(input),result,'identical input produces stable IDs without clocks or randomness');
 assert.deepEqual(plan.counts,{scenarioCount:30,repetitions:2,conversationExecutions:60,conversationPaidCalls:66,m6Executions:3,m6PaidCalls:6,totalPaidCalls:72,deterministicRequiredExecutions:60});
 const [conversation,m6]=plan.phases;
 assert.equal(conversation.id,'conversation-candidate');assert.equal(conversation.requiresPublishedVersion,false);
 assert.equal(m6.id,'m6-published');assert.equal(m6.requiresPublishedVersion,true);
 assert.equal(conversation.executions.length,60);assert.equal(m6.executions.length,3);
 assert.deepEqual(conversation.executions.slice(0,30).map(item=>item.caseId),SPRINT4_CASES.map(item=>item.caseId));
 assert.ok(conversation.executions.slice(0,30).every(item=>item.repetition==='R1'));
 assert.ok(conversation.executions.slice(30).every(item=>item.repetition==='R2'));
 const executions=plan.phases.flatMap(phase=>phase.executions),turns=executions.flatMap(item=>item.turns);
 assert.equal(new Set(executions.map(item=>item.sessionKey)).size,63);
 assert.equal(new Set(turns.map(item=>item.id)).size,72);
 for(const execution of executions){
  assert.deepEqual(execution.target,input.target);assert.equal(execution.sessionId,null);
  assert.deepEqual(execution.humanReview,{status:'pending',evaluatorId:null,scores:null,reviewedAt:null});
  for(const turn of execution.turns){assert.equal(turn.status,'pending');assert.equal(turn.result,null);assert.equal(turn.jobId,null);assert.equal(turn.elapsedMs,null);assert.equal(turn.usage,null);}
 }
 assert.equal(plan.readyToExecute,false);assert.ok(plan.pendingGates.includes('deterministic-30x2')&&plan.pendingGates.includes('human-average-at-least-4'));
});
