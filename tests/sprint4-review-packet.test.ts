import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sprint4ReviewPacket } from '../evaluations/sprint4-review-packet.js';
import { EvidenceStorageInputSchema, TerminalArtifactSchema, terminalEvidenceHash, type EvidenceStorageSpec, type TerminalArtifact } from '../evaluations/sprint4-evidence.spec.js';
import { evidenceFixture } from './sprint4-evidence-fixture.js';
import { LeadFactSchema } from '../src/domain.js';

function fixture(){
 const f=evidenceFixture(),artifacts=[TerminalArtifactSchema.parse(f.artifact)],reads:string[]=[];
 const storage:EvidenceStorageSpec={async execute(raw){
  const command=EvidenceStorageInputSchema.parse(raw);assert.equal(command.action,'read');if(command.action!=='read')throw new Error('Read only');
  reads.push(command.turnId);const artifact=artifacts.find(a=>a.payload.observation.binding.turnId===command.turnId)??null;
  return {success:true,data:{kind:'read',artifact:structuredClone(artifact)}};
 }};
 return {...f,artifacts,reads,packet:new Sprint4ReviewPacket(storage)};
}

test('review packet loads immutable evidence and leaves every approval and human score pending',async()=>{
 const f=fixture(),result=await f.packet.execute({plan:f.plan,turnId:f.turn.id});assert.ok(result.success,JSON.stringify(result));
 assert.equal(result.data.kind,'sprint4-review-packet-v1');assert.equal(result.data.objectiveAudit,'pending');assert.equal(result.data.readyForReceipt,false);
 assert.deepEqual(result.data.humanReview,{status:'pending',evaluatorId:null,scores:null,reviewedAt:null});
 assert.equal(result.data.allTurnsArchived,false);assert.equal(result.data.throughTurn,1);assert.equal(result.data.caseId,'C01');
 assert.deepEqual(result.data.artifacts,f.artifacts);assert.deepEqual(result.data.checks.map(c=>c.id),['O1','O2','O3','O4','O5','O6','O7','O8']);
 for(const id of ['O2','O8'])assert.equal(result.data.checks.find(c=>c.id===id)?.status,'pending-human');
 assert.deepEqual(f.reads,[f.turn.id]);
});

function second(f:ReturnType<typeof fixture>):TerminalArtifact{
 const artifact=structuredClone(f.artifacts[0]),o=artifact.payload.observation,a=artifact.payload.admission,t=f.plan.phases[0].executions[0].turns[1];
 o.binding.turnId=t.id;a.turnId=t.id;o.binding.requestId='22222222-2222-4222-8222-222222222222';a.requestId=o.binding.requestId;
 o.binding.jobId='synthetic-job-2';o.job.id=o.binding.jobId;o.guard.detail.jobId=o.binding.jobId;o.ledger.detail.jobId=o.binding.jobId;
 o.input.id=o.binding.sessionId+':'+o.binding.requestId;o.input.text=t.input;o.job.trigger_message_id=o.input.id;
 o.response[0].id=o.binding.jobId+':reply:0';o.ledger.id='lab-budget:'+createHash('sha256').update('sprint3-continuous-20260910:'+o.binding.jobId+':1').digest('hex');o.preparation.reservationId=o.ledger.id;
 a.sessionFresh=false;a.observedAtMs=3100;a.validUntilMs=4000;
 o.job.created_at=o.input.created_at=new Date(3500).toISOString();o.ledger.created_at=new Date(3600).toISOString();
 o.job.completed_at=o.guard.created_at=o.response[0].created_at=new Date(4500).toISOString();o.observedAt=new Date(5000).toISOString();
 o.job.context_version=o.memory.revision=2;
 return rehash(artifact);
}
function rehash(artifact:TerminalArtifact):TerminalArtifact{
 artifact.sha256=terminalEvidenceHash(artifact.payload);artifact.ref='terminal-sha256:'+artifact.sha256;return TerminalArtifactSchema.parse(artifact);
}

test('T2 review loads the archived T1 first and never presents a missing predecessor as a complete conversation',async()=>{
 const f=fixture(),t2=second(f);f.artifacts.push(t2);
 const result=await f.packet.execute({plan:f.plan,turnId:t2.payload.observation.binding.turnId});assert.ok(result.success,JSON.stringify(result));
 assert.deepEqual(result.data.artifacts,f.artifacts);assert.equal(result.data.allTurnsArchived,true);assert.equal(result.data.throughTurn,2);
 assert.deepEqual(f.reads,f.artifacts.map(a=>a.payload.observation.binding.turnId));
 f.artifacts.shift();
 assert.deepEqual(await f.packet.execute({plan:f.plan,turnId:t2.payload.observation.binding.turnId}),{success:false,error:{code:'MISSING_ARTIFACT'}});
});

test('review rejects artifacts from another plan, run, owner, input or session dependency',async()=>{
 for(const variant of ['hash','run','actor','input','session','request','revision','order']){
  const f=fixture(),t2=second(f),o=t2.payload.observation,a=t2.payload.admission;
  if(variant==='hash')t2.payload.planHash='b'.repeat(64);
  if(variant==='run')o.binding.runId='other-run';
  if(variant==='actor')o.binding.actorUserId=a.actorUserId='other-admin';
  if(variant==='input')o.input.text='not the fixed question';
  if(variant==='session'){
   o.binding.sessionId=a.sessionId=o.job.conversation_id=o.input.conversation_id=o.response[0].conversation_id=o.guard.conversation_id=o.ledger.conversation_id='other-session';
   o.input.id=o.job.trigger_message_id='other-session:'+o.binding.requestId;
  }
  if(variant==='request'){o.binding.requestId=a.requestId=f.artifacts[0].payload.observation.binding.requestId;o.input.id=o.job.trigger_message_id=o.binding.sessionId+':'+o.binding.requestId;}
  if(variant==='revision')o.memory.revision=o.job.context_version=1;
  if(variant==='order')a.observedAtMs=2000;
  f.artifacts.push(rehash(t2));
  assert.equal((await f.packet.execute({plan:f.plan,turnId:o.binding.turnId})).success,false,variant);
 }
});

test('late completion and rejected original model output remain findings even when the final response is safe',async()=>{
 const f=fixture();Object.assign(f.artifacts[0].payload.observation.guard.detail,{modelGuardPassed:false,originalGuardViolations:['unsupported_commercial_number'],replyRepair:'synthetic-repair'});
 f.artifacts[0]=rehash(f.artifacts[0]);const t2=second(f);t2.payload.observation.job.deadline=new Date(4000).toISOString();t2.payload.observation.jobDeadlineAtMs=4000;
 f.artifacts.push(rehash(t2));const result=await f.packet.execute({plan:f.plan,turnId:t2.payload.observation.binding.turnId});assert.ok(result.success);
 assert.equal(result.data.checks.find(c=>c.id==='O6')!.status,'findings');
 assert.ok(result.data.checks.find(c=>c.id==='O6')!.findings.includes('terminal-row-after-deadline'));
 const quality=result.data.checks.find(c=>c.id==='O8')!;assert.equal(quality.status,'findings');assert.ok(quality.findings.includes('unsupported_commercial_number'));
 assert.ok(quality.findings.includes('model-guard-rejected'));assert.equal(result.data.objectiveAudit,'pending');assert.equal(result.data.readyForReceipt,false);
 assert.deepEqual(result.data.artifacts,f.artifacts);
});

test('ledger arithmetic is checked against the archived usage without turning settled into approval',async()=>{
 for(const variant of ['valid','cost','reservation','unsettled','usage','ceiling']){
  const f=fixture(),o=f.artifacts[0].payload.observation;
  if(variant==='cost')o.ledger.detail.costMicroUsd=399;
  if(variant==='reservation')o.ledger.detail.reservedMicroUsd=o.preparation.reservedMicroUsd=50000;
  if(variant==='unsettled')o.ledger.detail.settled=false;
  if(variant==='usage')o.job.usage.total_tokens=999;
  if(variant==='ceiling')f.artifacts[0].payload.admission.budget.maxReservationMicroUsd=50000;
  f.artifacts[0]=rehash(f.artifacts[0]);const result=await f.packet.execute({plan:f.plan,turnId:f.turn.id});assert.ok(result.success,JSON.stringify(result));
  const cost=result.data.checks.find(c=>c.id==='O7')!;
  if(variant==='valid'){assert.ok(cost.verified.includes('reservation-and-settlement-arithmetic'));assert.equal(cost.status,'partial');}
  else {assert.equal(cost.status,'findings',variant);assert.ok(cost.findings.includes('ledger-arithmetic-or-bound-mismatch'));}
  assert.equal(result.data.readyForReceipt,false);assert.equal(result.data.humanReview.scores,null);
 }
});

test('memory review compares archived T1 with T2 and verifies citations without treating them as semantic proof',async()=>{
 for(const variant of ['valid','quote','other-message','confirmed','removed','duplicate']){
  const f=fixture(),first=f.artifacts[0].payload.observation;
  const fact=LeadFactSchema.parse({id:'fact-city',field:'city',value:{kind:'text',text:'Vila Aurora'},evidence:{messageId:first.input.id,quote:'Vila Aurora'},
   attribution:'candidate',capitalOrigin:null,relationId:null,replacesFactId:null,status:'declared',confirmedBy:null,createdAt:new Date(2500).toISOString(),origin:'candidate_message'});
  first.memory.facts=[fact];first.memory.lead.facts=[fact];f.artifacts[0]=rehash(f.artifacts[0]);const t2=second(f),o=t2.payload.observation;
  if(variant==='quote')o.memory.facts[0].evidence.quote='missing quote';
  if(variant==='other-message')o.memory.facts[0].evidence.messageId='outside-session';
  if(variant==='confirmed'){o.memory.facts[0].status='confirmed';o.memory.facts[0].confirmedBy='unverified-human';}
  if(variant==='removed')o.memory.facts=[];
  if(variant==='duplicate')o.memory.facts.push(structuredClone(o.memory.facts[0]));
  o.memory.lead.facts=structuredClone(o.memory.facts);f.artifacts.push(rehash(t2));
  const result=await f.packet.execute({plan:f.plan,turnId:o.binding.turnId});assert.ok(result.success,JSON.stringify(result));
  const citations=result.data.checks.find(c=>c.id==='O3')!,memory=result.data.checks.find(c=>c.id==='O5')!;
  if(variant==='valid'){assert.ok(citations.verified.includes('canonical-citations-in-archived-inputs'));assert.ok(memory.verified.includes('prior-fact-and-relation-dtos-retained'));}
  else if(variant==='removed')assert.ok(memory.findings.includes('prior-memory-dto-changed-or-missing'));
  else assert.equal(citations.status,'findings',variant);
  assert.equal(result.data.readyForReceipt,false);assert.ok(citations.pending.includes('semantic-attribution-and-extraction-review'));
 }
});

test('findings identify the exact turn and archived digest instead of attributing T1 failure to T2',async()=>{
 const f=fixture(),t2=second(f);Object.assign(f.artifacts[0].payload.observation.guard.detail,{modelGuardPassed:false,originalGuardViolations:['unsupported_commercial_number']});
 f.artifacts[0]=rehash(f.artifacts[0]);f.artifacts.push(t2);
 const result=await f.packet.execute({plan:f.plan,turnId:t2.payload.observation.binding.turnId});assert.ok(result.success);
 assert.deepEqual(result.data.findingsByTurn,[
  {criterion:'O8',code:'model-guard-rejected',turnId:f.turn.id,artifactRef:f.artifacts[0].ref},
  {criterion:'O8',code:'unsupported_commercial_number',turnId:f.turn.id,artifactRef:f.artifacts[0].ref},
 ]);
});

test('deadline review preserves SQL sub-millisecond precision and compares timezone-equivalent instants',async()=>{
 for(const [completed,late] of [['1970-01-01T00:00:02.500900Z',true],['1970-01-01T03:00:02.500900+03:00',true],
  ['1969-12-31T21:00:02.500100-03:00',false],['1970-01-01T00:00:02.500099Z',false]] as const){
  const f=fixture(),o=f.artifacts[0].payload.observation;
  o.job.deadline='1970-01-01T00:00:02.500100Z';o.jobDeadlineAtMs=2500;o.job.completed_at=completed;
  f.artifacts[0]=rehash(f.artifacts[0]);
  const result=await f.packet.execute({plan:f.plan,turnId:f.turn.id});assert.ok(result.success,JSON.stringify(result));
  const operation=result.data.checks.find(c=>c.id==='O6')!;
  assert.equal(operation.findings.includes('terminal-row-after-deadline'),late,completed);
  assert.equal(operation.verified.includes('terminal-row-within-deadline-not-render-time'),!late,completed);
 }
});

test('T2 admission cannot precede the archived T1 observation by a fraction of a millisecond',async()=>{
 for(const [observedAt,accepted] of [['1970-01-01T00:00:03.000001Z',false],['1969-12-31T21:00:03.000000-03:00',true]] as const){
  const f=fixture();f.artifacts[0].payload.observation.observedAt=observedAt;f.artifacts[0]=rehash(f.artifacts[0]);
  const t2=second(f);t2.payload.admission.observedAtMs=3000;f.artifacts.push(rehash(t2));
  const result=await f.packet.execute({plan:f.plan,turnId:t2.payload.observation.binding.turnId});
  assert.equal(result.success,accepted,observedAt);
  if(!accepted)assert.deepEqual(result,{success:false,error:{code:'EVIDENCE_MISMATCH'}});
 }
});
