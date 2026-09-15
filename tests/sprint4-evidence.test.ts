import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStorageInputSchema, TerminalArtifactSchema, type EvidenceStorageSpec, type TerminalArtifact } from '../evaluations/sprint4-evidence.spec.js';
import { Sprint4EvidenceCapture } from '../evaluations/sprint4-evidence.js';
import { evidenceFixture, evidenceHash } from './sprint4-evidence-fixture.js';

test('terminal artifact keeps the observed response separate from an explicitly unavailable raw callback',()=>{
 const f=evidenceFixture();
 const artifact=TerminalArtifactSchema.parse(f.artifact);
 assert.deepEqual(artifact,f.artifact);
 assert.equal(artifact.payload.observation.objectiveAudit,'pending');
 assert.equal(artifact.payload.observation.humanReview,'pending');
 assert.deepEqual(artifact.payload.rawArtifact,{status:'unavailable',reason:'not-retained-by-runtime'});
 assert.equal(TerminalArtifactSchema.safeParse({...f.artifact,payload:{...f.payload,rawArtifact:f.observation.job.result}}).success,false);
});

function captureFixture(){
 const f=evidenceFixture(),events:string[]=[];let saved:TerminalArtifact|null=null;
 const storage:EvidenceStorageSpec={async execute(raw){
  const command=EvidenceStorageInputSchema.parse(raw);events.push(command.action);
  if(command.action==='read')return {success:true,data:{kind:'read',artifact:saved?structuredClone(saved):null}};
  if(command.action==='close')return {success:true,data:{kind:'closed'}};
  saved=structuredClone(command.artifact);return {success:true,data:{kind:'archived',duplicate:false}};
 }};
 const journal={async read(){events.push('journal');return structuredClone(f.state);}};
 const audit={async execute(){events.push('audit');return {success:true as const,data:structuredClone(f.observation)};}};
 const collector=new Sprint4EvidenceCapture({journal,audit,storage});
 return {...f,events,storage,journal,audit,collector,getSaved:()=>saved};
}

test('capture confirms an immutable archive before handing the response to review, without a controller receipt',async()=>{
 const f=captureFixture(),result=await f.collector.execute({plan:f.plan,turnId:f.turn.id});
 assert.ok(result.success,JSON.stringify(result));
 assert.equal(result.data.kind,'awaiting-review');assert.equal(result.data.source,'captured');
 assert.deepEqual(result.data.artifact,f.artifact);assert.deepEqual(f.getSaved(),f.artifact);
 assert.deepEqual(f.events,['journal','read','audit','archive-once','read']);
 assert.equal('receipt' in result.data,false);assert.equal(f.state.entries[0].receipts.length,0);
});

test('resume reads the archived turn without reauditing a database whose memory may have advanced',async()=>{
 const f=captureFixture();assert.ok((await f.collector.execute({plan:f.plan,turnId:f.turn.id})).success);
 f.events.length=0;f.audit.execute=async()=>{throw new Error('MEMORY_ADVANCED/private text');};
 const result=await new Sprint4EvidenceCapture({journal:f.journal,audit:f.audit,storage:f.storage}).execute({plan:f.plan,turnId:f.turn.id});
 assert.ok(result.success,JSON.stringify(result));assert.equal(result.data.source,'archive');assert.deepEqual(result.data.artifact,f.artifact);
 assert.deepEqual(f.events,['journal','read']);
});

test('resume rejects a different plan, recorded admission, run or canonical input even with a valid new digest',async()=>{
 for(const variant of ['plan','admission','hash','run','input']){
  const f=captureFixture();assert.ok((await f.collector.execute({plan:f.plan,turnId:f.turn.id})).success);f.events.length=0;
  const saved=f.getSaved()!;
  if(variant==='plan')f.state.plan.request.actorUserId='other-admin';
  if(variant==='admission')f.state.entries[0].admission.evidenceRef='different-check';
  if(variant==='hash')saved.payload.planHash='b'.repeat(64);
  if(variant==='run')saved.payload.observation.binding.runId='different-run';
  if(variant==='input')saved.payload.observation.input.text='changed case';
  saved.sha256=evidenceHash(saved.payload);saved.ref='terminal-sha256:'+saved.sha256;
  const result=await f.collector.execute({plan:f.plan,turnId:f.turn.id});
  assert.equal(result.success,false,variant);assert.equal(f.events.includes('audit'),false,variant);
  assert.equal(f.events.includes('archive-once'),false,variant);
 }
});

test('capture rejects journal entries outside the canonical owner, target and ordered prefix before any observation',async()=>{
 for(const variant of ['actor','target','duplicate','wrong-first']){
  const f=captureFixture();
  if(variant==='actor'){f.state.entries[0].admission.actorUserId='other';f.observation.binding.actorUserId='other';}
  if(variant==='target'){f.state.entries[0].admission.target.contentHash='b'.repeat(64);f.observation.binding.target.contentHash='b'.repeat(64);}
  if(variant==='duplicate')f.state.entries.push(structuredClone(f.state.entries[0]));
  if(variant==='wrong-first'){const id=f.plan.phases[0].executions[1].turns[0].id;f.state.entries[0].turnId=id;f.state.entries[0].admission.turnId=id;}
  assert.equal((await f.collector.execute({plan:f.plan,turnId:f.turn.id})).success,false,variant);
  assert.deepEqual(f.events,['journal'],variant);
 }
});

test('artifact digest and reference must bind exactly the parsed payload',()=>{
 const f=evidenceFixture();
 for(const artifact of [{...f.artifact,sha256:'b'.repeat(64)},{...f.artifact,ref:'terminal-sha256:'+'b'.repeat(64)},
  {...f.artifact,payload:{...f.payload,planHash:'b'.repeat(64)}}])assert.equal(TerminalArtifactSchema.safeParse(artifact).success,false);
});

test('rehashing cannot substitute another admission, session, actor or request inside an artifact',()=>{
 const f=evidenceFixture();
 for(const mutate of [(p:typeof f.payload)=>p.admission.actorUserId='other',(p:typeof f.payload)=>p.observation.binding.target.contentHash='b'.repeat(64),
  (p:typeof f.payload)=>p.observation.binding.sessionId='other',(p:typeof f.payload)=>p.observation.binding.requestId='22222222-2222-4222-8222-222222222222',
  (p:typeof f.payload)=>p.observation.binding.turnId='other',(p:typeof f.payload)=>p.observation.job.id='other',(p:typeof f.payload)=>p.observation.memory.lead.leadId='other']){
  const payload=structuredClone(f.payload);mutate(payload);const sha256=evidenceHash(payload);
  assert.equal(TerminalArtifactSchema.safeParse({ref:'terminal-sha256:'+sha256,sha256,payload}).success,false);
 }
});

test('archive validates message, preparation and ledger identities and observation chronology',()=>{
 const f=evidenceFixture();
 for(const mutate of [(p:typeof f.payload)=>p.observation.response[0].candidate_id='other',
  (p:typeof f.payload)=>p.observation.input.id='other',
  (p:typeof f.payload)=>p.observation.response[0].text='not the persisted result',
  (p:typeof f.payload)=>p.observation.ledger.detail.jobId='other',
  (p:typeof f.payload)=>p.observation.preparation.reservationId='other',
  (p:typeof f.payload)=>p.observation.memory.revision=2,
  (p:typeof f.payload)=>p.observation.observedAt=new Date(500).toISOString(),
  (p:typeof f.payload)=>p.observation.jobDeadlineAtMs=70000]){
  const payload=structuredClone(f.payload);mutate(payload);const sha256=evidenceHash(payload);
  assert.equal(TerminalArtifactSchema.safeParse({ref:'terminal-sha256:'+sha256,sha256,payload}).success,false);
 }
});

test('lost archive acknowledgment resumes from the durable observation without collecting a replacement',async()=>{
 const f=captureFixture(),original=f.storage.execute.bind(f.storage);let lose=true;
 f.storage.execute=async raw=>{const result=await original(raw);if(EvidenceStorageInputSchema.parse(raw).action==='archive-once'&&lose){lose=false;throw new Error('private ACK failure');}return result;};
 const first=await f.collector.execute({plan:f.plan,turnId:f.turn.id});assert.equal(first.success,false);assert.ok(f.getSaved());assert.doesNotMatch(JSON.stringify(first),/private/);
 f.events.length=0;f.audit.execute=async()=>{throw new Error('should not query');};
 const retry=await f.collector.execute({plan:f.plan,turnId:f.turn.id});assert.ok(retry.success);assert.equal(retry.data.source,'archive');
 assert.deepEqual(retry.data.artifact,f.artifact);assert.deepEqual(f.events,['journal','read']);
});

test('missing or malformed evidence, failed dependencies and unconfirmed writes never yield an artifact approval',async()=>{
 for(const variant of ['invalid-input','invalid-plan','missing-intent','read-failure','audit-failure','ack-only','wrong-confirmation','malformed-archive']){
  const f=captureFixture();let input:unknown={plan:f.plan,turnId:f.turn.id};
  if(variant==='invalid-input')input=null;
  if(variant==='invalid-plan')f.plan.phases[0].executions[0].turns[0].input='tampered';
  if(variant==='missing-intent')f.state.entries=[];
  if(variant==='read-failure')f.storage.execute=async()=>({success:false,error:{code:'STORAGE_FAILURE'}});
  if(variant==='audit-failure')f.audit.execute=async()=>{throw new Error('private audit failure');};
  if(variant==='ack-only')f.storage.execute=async raw=>EvidenceStorageInputSchema.parse(raw).action==='read'?{success:true,data:{kind:'read',artifact:null}}:{success:true,data:{kind:'archived',duplicate:false}};
  if(variant==='wrong-confirmation'){
   const original=f.storage.execute.bind(f.storage);f.storage.execute=async raw=>{const r=await original(raw);if(EvidenceStorageInputSchema.parse(raw).action==='archive-once')f.getSaved()!.payload.observation.input.text='mutated';return r;};
  }
  if(variant==='malformed-archive')f.storage.execute=async()=>({success:true,data:{kind:'read',artifact:{...f.artifact,sha256:'b'.repeat(64)} as TerminalArtifact}});
  const result=await f.collector.execute(input);assert.equal(result.success,false,variant);assert.doesNotMatch(JSON.stringify(result),/private|tampered|mutated/);
  assert.equal(f.state.entries.flatMap(e=>e.receipts).length,0);
  if(['read-failure','malformed-archive'].includes(variant))assert.equal(f.events.includes('audit'),false);
 }
});

test('a failed terminal audit keeps its safe reason and does not create an artifact or receipt',async()=>{
 const f=captureFixture();
 const collector=new Sprint4EvidenceCapture({journal:f.journal,storage:f.storage,audit:{async execute(){return {success:false,error:{code:'MEMORY_ADVANCED'}};}}});
 const result=await collector.execute({plan:f.plan,turnId:f.turn.id});
 assert.deepEqual(result,{success:false,error:{code:'AUDIT_FAILED',auditCode:'MEMORY_ADVANCED'}});
 assert.equal(f.getSaved(),null);assert.deepEqual(f.events,['journal','read']);
});

test('a coherently observed late completion is archived as pending evidence rather than discarded',async()=>{
 const f=captureFixture();f.observation.job.deadline=new Date(2000).toISOString();f.observation.jobDeadlineAtMs=2000;
 const result=await f.collector.execute({plan:f.plan,turnId:f.turn.id});
 assert.ok(result.success,JSON.stringify(result));assert.equal(result.data.kind,'awaiting-review');
 assert.equal(result.data.artifact.payload.observation.jobDeadlineAtMs,2000);
 assert.equal(result.data.artifact.payload.observation.objectiveAudit,'pending');
});

test('artifact chronology rejects reversed SQL instants inside one millisecond',()=>{
 for(const mutate of [(o:ReturnType<typeof evidenceFixture>['observation'])=>{
  o.observedAt='1970-01-01T00:00:02.500100Z';o.job.completed_at='1970-01-01T00:00:02.500900Z';
 },(o:ReturnType<typeof evidenceFixture>['observation'])=>{
  o.job.created_at='1970-01-01T00:00:01.500900Z';o.job.completed_at='1970-01-01T00:00:01.500100Z';
 },(o:ReturnType<typeof evidenceFixture>['observation'])=>{o.response[0].created_at='1970-01-01T00:00:03.000001Z';}]){
  const f=evidenceFixture();mutate(f.payload.observation);const sha256=evidenceHash(f.payload);
  assert.equal(TerminalArtifactSchema.safeParse({ref:'terminal-sha256:'+sha256,sha256,payload:f.payload}).success,false);
 }
 const f=evidenceFixture();f.payload.observation.observedAt='1969-12-31T21:00:02.500000-03:00';
 const sha256=evidenceHash(f.payload);
 assert.equal(TerminalArtifactSchema.safeParse({ref:'terminal-sha256:'+sha256,sha256,payload:f.payload}).success,true);
});
