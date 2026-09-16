import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';
import { seedPilot } from '../src/seed.js';
import { Store, type JobRow } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Engine } from '../src/engine.js';
import { reserveLabBudget } from '../src/lab-budget.js';
import { DispatchFailure } from '../src/dispatch-failure.js';
import { TurnInputSchema } from '../src/contracts.js';
import { DispatchFailureResultSchema } from '../src/dispatch-failure.spec.js';

async function fixture() {
 const db=await testDatabase(),store=new Store(db),sessions=new LabSessions(db);
 await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic recovery'}]});
 const actor={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 const created=await sessions.create(actor,{requestId:randomUUID(),label:'Synthetic ACK recovery',scenario:'free'});
 assert.ok(created.ok);
 const sent=await sessions.send(actor,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia em uma cidade fictícia.'});
 assert.ok(sent.ok);assert.ok(sent.value.jobId);
 await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[sent.value.jobId]);
 const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
 return {db,store,sessions,actor,channel,job};
}

function completion(job:JobRow) {
 return {jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,
  model:'gpt-5.4-2026-03-05',usage:{input_tokens:100,output_tokens:10,total_tokens:110},
  result:{bubbles:['Em qual cidade você pretende abrir a operação?'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}};
}

test('lost ACK and expired lease never reclaim a reserved lab job; original callback still settles once',async()=>{
 const {db,store,channel,job}=await fixture();
 try {
  let calls=0;
  const engine=new Engine(store,testConfig,async()=>{calls++;throw new Error('synthetic lost ACK');});
  await assert.rejects(engine.dispatch(channel,job),/synthetic lost ACK/);
  await db.query("UPDATE sdr.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
  assert.equal(await new Store(db).claim(channel),undefined);
  assert.equal(calls,1);
  assert.equal((await store.getJob(job.id)).job.state,'working');
  assert.equal((await engine.complete(completion(job))).accepted,true);
  assert.equal((await engine.complete(completion(job))).accepted,false);
  const ledger=(await db.query<{detail:{settled:boolean,costMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(ledger.length,1);assert.equal(ledger[0].detail.settled,true);assert.equal(ledger[0].detail.costMicroUsd,400);
  assert.equal((await db.query("SELECT id FROM sdr.messages WHERE actor='agent'")).rows.length,1);
  assert.equal((await db.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
 } finally {await db.close();}
});

test('failure handler retains the reserved attempt and original deadline for a late callback',async()=>{
 const {db,store,channel,job}=await fixture();
 try {
  const engine=new Engine(store,testConfig,async()=>{throw new Error('synthetic lost ACK');});
  await assert.rejects(engine.dispatch(channel,job),/synthetic lost ACK/);
  const before=(await store.getJob(job.id)).job;
  assert.deepEqual(await new DispatchFailure(db,channel).execute({jobId:job.id,attempt:job.attempts}),
   {success:true,data:{kind:'awaiting_callback'}});
  const after=(await store.getJob(job.id)).job;
  assert.equal(after.state,'working');assert.equal(after.attempts,1);
  assert.equal(after.error_code,'ORCHESTRATOR_ACK_UNKNOWN');
  assert.deepEqual(after.context,before.context);assert.deepEqual(after.deadline,before.deadline);
  assert.equal((await engine.complete(completion(job))).accepted,true);
  assert.equal((await store.getJob(job.id)).job.state,'completed');
 } finally {await db.close();}
});

test('another gate or attempt cannot authorize another paid POST for the same reserved job',async()=>{
 const {db,store,channel,job}=await fixture();
 try {
  let calls=0;
  const lostAck:typeof fetch=async()=>{calls++;throw new Error('synthetic lost ACK');};
  await assert.rejects(new Engine(store,testConfig,lostAck).dispatch(channel,job),/synthetic lost ACK/);
  // Deliberate legacy/manual state corruption: defense at dispatch is independent
  // of the worker claim filter. This is not an allowed application transition.
  await db.query('UPDATE sdr.jobs SET attempts=attempts+1 WHERE id=$1',[job.id]);
  const retry=(await store.getJob(job.id)).job;
  await new Engine(store,{...testConfig,LAB_BUDGET_GATE_ID:'synthetic-other-gate'},async()=>{calls++;return Response.json({accepted:true});}).dispatch(channel,retry);
  assert.equal(calls,1);
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,1);
 } finally {await db.close();}
});

test('legacy reservation helper also refuses a new gate or attempt after any prior job reservation',async()=>{
 const {db,store,channel,job}=await fixture();
 try {
  assert.equal(await reserveLabBudget(store,testConfig,channel,job,{synthetic:true}),true);
  await db.query('UPDATE sdr.jobs SET attempts=attempts+1 WHERE id=$1',[job.id]);
  assert.equal(await reserveLabBudget(store,{...testConfig,LAB_BUDGET_GATE_ID:'synthetic-other-gate'},channel,(await store.getJob(job.id)).job,{synthetic:true}),false);
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,1);
 } finally {await db.close();}
});

test('failure before reservation recovers with backoff and rejects the old attempt before any POST',async()=>{
 const {db,store,channel,job}=await fixture();
 try {
  const failure=new DispatchFailure(db,channel);
  assert.deepEqual(await failure.execute({jobId:job.id,attempt:job.attempts}),{success:true,data:{kind:'requeued'}});
  const pending=(await store.getJob(job.id)).job;
  assert.equal(pending.state,'pending');assert.deepEqual(pending.deadline,job.deadline);
  assert.equal(await store.claim(channel),undefined,'backoff must be respected');
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
  await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[job.id]);
  const retry=await store.claim(channel);assert.ok(retry);assert.equal(retry.attempts,2);
  assert.deepEqual(await failure.execute({jobId:job.id,attempt:job.attempts}),{success:true,data:{kind:'ignored'}});
  let calls=0;
  const engine=new Engine(store,testConfig,async()=>{calls++;return Response.json({accepted:true});});
  await engine.dispatch(channel,job);assert.equal(calls,0);
  await engine.dispatch(channel,retry);assert.equal(calls,1);
  assert.equal((await engine.complete(completion(retry))).accepted,true);
  const ledger=(await db.query<{detail:{attempt:number,settled:boolean}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(ledger.length,1);assert.equal(ledger[0].detail.attempt,2);assert.equal(ledger[0].detail.settled,true);
 } finally {await db.close();}
});

test('callback committed before an ACK error stays terminal when the worker handles the failure',async()=>{
 const {db,store,channel,job}=await fixture();
 try {
  const engine=new Engine(store,testConfig,async()=>{
   assert.equal((await engine.complete(completion(job))).accepted,true);
   throw new Error('synthetic ACK error after completion');
  });
  await assert.rejects(engine.dispatch(channel,job),/synthetic ACK error/);
  const before=(await store.getJob(job.id)).job;
  const ledgerBefore=(await db.query("SELECT * FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(before.state,'completed');assert.equal(before.error_code,null);
  assert.deepEqual(await new DispatchFailure(db,channel).execute({jobId:job.id,attempt:1}),{success:true,data:{kind:'ignored'}});
  assert.deepEqual((await store.getJob(job.id)).job,before);
  assert.deepEqual((await db.query("SELECT * FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows,ledgerBefore);
  assert.equal(await store.claim(channel),undefined);
 } finally {await db.close();}
});

test('failure handling never reopens a human control or a superseded message revision',async()=>{
 for(const text of ['Quero falar com uma pessoa.','Pare de enviar mensagens.','Minha cidade é Vila Nova.']) {
  const {db,store,sessions,actor,channel,job}=await fixture();
  try {
   const engine=new Engine(store,testConfig,async()=>{throw new Error('synthetic lost ACK');});
   await assert.rejects(engine.dispatch(channel,job),/synthetic lost ACK/);
   assert.ok((await sessions.send(actor,job.conversation_id,{requestId:randomUUID(),text})).ok);
   const before=(await store.getJob(job.id)).job;
   assert.equal(before.state,'stale');
   const ledger=(await db.query("SELECT * FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
   assert.deepEqual(await new DispatchFailure(db,channel).execute({jobId:job.id,attempt:1}),{success:true,data:{kind:'ignored'}});
   assert.deepEqual((await store.getJob(job.id)).job,before);
   assert.equal((await engine.complete(completion(job))).accepted,false);
   assert.deepEqual((await db.query("SELECT * FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows,ledger);
   assert.equal((await db.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  } finally {await db.close();}
 }
});

test('an ambiguous attempt expires instead of retrying and retains its full unresolved reservation',async()=>{
 for(const state of ['working','running','pending']) {
  const {db,store,channel,job}=await fixture();
  try {
   const engine=new Engine(store,testConfig,async()=>{throw new Error('synthetic lost ACK');});
   await assert.rejects(engine.dispatch(channel,job),/synthetic lost ACK/);
   const ledger=(await db.query("SELECT * FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
   assert.equal(ledger.length,1);
   // pending represents an old worker's requeue persisted before the correction.
   await db.query("UPDATE sdr.jobs SET state=$2,deadline=now()-interval '1 second' WHERE id=$1",[job.id,state]);
   assert.equal(await store.claim(channel),undefined);
   const terminal=(await store.getJob(job.id)).job;
   assert.equal(terminal.state,'handoff');assert.equal(terminal.error_code,'PROCESSING_TIMEOUT');assert.equal(terminal.attempts,1);
   assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations WHERE id=$1',[job.conversation_id])).rows[0].state,'human');
   assert.equal((await engine.complete(completion(job))).accepted,false);
   assert.deepEqual(await new DispatchFailure(db,channel).execute({jobId:job.id,attempt:1}),{success:true,data:{kind:'ignored'}});
   assert.deepEqual((await db.query("SELECT * FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows,ledger);
   assert.equal((await db.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  } finally {await db.close();}
 }
});

test('WhatsApp recovery keeps its existing backoff and lease behavior',async()=>{
 const db=await testDatabase(),store=new Store(db);
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic WhatsApp recovery'}]});
  const input=TurnInputSchema.parse({phoneNumberId:'1093705843816293',conversationId:'synthetic-wa',contactId:'5511999999999',messageId:'synthetic-wa-message',text:'Quero conhecer a franquia'});
  const turn=await store.startTurn(input),channel=await store.channel(input.phoneNumberId);
  assert.equal(channel.kind,'whatsapp');
  await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[turn.id]);
  const job=await store.claim(channel);assert.ok(job);
  assert.deepEqual(await new DispatchFailure(db,channel).execute({jobId:job.id,attempt:job.attempts}),{success:true,data:{kind:'requeued'}});
  assert.equal(await store.claim(channel),undefined);
  await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[job.id]);
  assert.equal((await store.claim(channel))?.attempts,2);
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
  assert.equal((await db.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
 } finally {await db.close();}
});

test('failure contract rejects malformed input before I/O and sanitizes database errors',async()=>{
 const {db,channel,job}=await fixture();
 try {
  let transactions=0;
  const unavailable={...db,transaction:async()=>{transactions++;throw new Error('SECRET_SENTINEL_MUST_NOT_LEAK');}};
  const failure=new DispatchFailure(unavailable,channel);
  for(const raw of [null,{}, {jobId:job.id,attempt:0}, {jobId:job.id,attempt:1.5}, {jobId:job.id,attempt:1,gateId:'forged'}]) {
   assert.deepEqual(await failure.execute(raw),{success:false,error:{code:'INVALID_INPUT'}});
  }
  assert.equal(transactions,0);
  const result=await failure.execute({jobId:job.id,attempt:1});
  assert.deepEqual(result,{success:false,error:{code:'FAILURE_RECORDING_FAILED'}});
  assert.ok(DispatchFailureResultSchema.safeParse(result).success);
  assert.equal(transactions,1);assert.doesNotMatch(JSON.stringify(result),/SECRET_SENTINEL/);
 } finally {await db.close();}
});
