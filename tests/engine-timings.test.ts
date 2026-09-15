import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CompletionSchema, Engine } from '../src/engine.js';
import type { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { seedPilot } from '../src/seed.js';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';

const result={bubbles:['Obrigado.'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
const callback={jobId:'job',contextVersion:1,result};

async function fixture() {
 const actual=await testDatabase(),calls={transactions:0,queries:[] as string[]};let time=1000;
 const db:Database={
  query:async<T>(sql:string,params?:unknown[])=>{calls.queries.push(sql);time+=5;return actual.query<T>(sql,params);},
  transaction:async fn=>{calls.transactions++;time+=7;const value=await actual.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{calls.queries.push(sql);time+=5;return tx.query<T>(sql,params);}}));time+=11;return value;},
  close:()=>actual.close(),
 };
 await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictício'}]});
 const store=new Store(db),sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 const created=await sessions.create(user,{requestId:randomUUID(),label:'Tempos fictícios',scenario:'free'});assert.ok(created.ok);
 const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
 const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
 const clock=()=>time++,reset=()=>{calls.transactions=0;calls.queries.length=0;};
 const event=async()=> (await db.query<{detail:Record<string,unknown>}>("SELECT detail FROM sdr.events WHERE type='turn_completed' AND detail->>'jobId'=$1",[job.id])).rows[0]?.detail;
 return {db,store,sessions,user,channel,job,clock,reset,calls,event,sessionId:created.value.id};
}

test('callback accepts bounded optional n8n timing and discards invalid telemetry without rejecting the result',()=>{
 for(const modelRoundTripMs of [0,1234,180000])assert.deepEqual(CompletionSchema.parse({...callback,timings:{modelRoundTripMs}}).timings,{modelRoundTripMs});
 assert.equal(CompletionSchema.parse(callback).timings,undefined);
 for(const timings of [null,{},'secret',-1,{modelRoundTripMs:-1},{modelRoundTripMs:1.5},{modelRoundTripMs:180001},{modelRoundTripMs:Infinity},{modelRoundTripMs:'12'},{modelRoundTripMs:12,prompt:'private'}]) {
  const parsed=CompletionSchema.parse({...callback,timings});
  assert.equal(parsed.timings,undefined);assert.deepEqual(parsed.result,result);
 }
});

test('completion records separate duration-only metrics in its existing event without extra queries or replay writes',async()=>{
 const f=await fixture();
 try {
  const engine=new Engine(f.store,testConfig,async()=>Response.json({accepted:true}),f.clock);
  await engine.dispatch(f.channel,f.job);f.reset();
  const completion={...callback,jobId:f.job.id,contextVersion:f.job.context_version,timings:{modelRoundTripMs:1400}};
  assert.deepEqual(await engine.complete(completion),{accepted:true});
  // Grouped completion removes four reads from the prior eleven-query fixture; telemetry adds none.
  assert.equal(f.calls.transactions,1);assert.equal(f.calls.queries.length,7);
  const event=await f.event();assert.ok(event);
  const timings=event.timings as {backend:Record<string,number>,n8nReported:unknown};
  assert.ok(timings?.backend);assert.deepEqual(timings.n8nReported,{modelRoundTripMs:1400});
  for(const key of ['completeReadMs','guardMemoryMs','persistBeforeEventMs'])assert.ok(Number.isInteger(timings.backend[key])&&timings.backend[key]>=0,key);
  for(const forbidden of ['commitMs','totalMs','modelInferenceMs','messages','prompt','candidateId','text'])assert.equal(JSON.stringify(timings).includes(forbidden),false);
  assert.equal(event.guardPassed,true);
  const original=structuredClone(event);
  assert.deepEqual(await engine.complete(completion),{accepted:false,reason:'STALE_RESULT'});
  assert.deepEqual(await f.event(),original);
  const detail=await f.sessions.detail(f.user,f.sessionId);assert.ok(detail.ok);
  assert.equal(JSON.stringify(detail.value).includes('timings'),false);
 }finally{await f.db.close();}
});

test('worker timing reuses existing writes and reaches the event without entering the model payload',async()=>{
 const f=await fixture();
 try {
  let payload:unknown;const engine=new Engine(f.store,testConfig,async(_url,options)=>{payload=JSON.parse(String(options?.body));return Response.json({accepted:true});},f.clock);
  f.reset();await engine.dispatch(f.channel,f.job);
  // Fused laboratory preflight/preparation/reservation plus the conditional ACK.
  assert.equal(f.calls.transactions,2);assert.equal(f.calls.queries.length,9);
  const context=(await f.db.query<{context:Record<string,unknown>}>('SELECT context FROM sdr.jobs WHERE id=$1',[f.job.id])).rows[0].context;
  assert.ok(context.backendTimings);
  assert.equal(JSON.stringify(payload).includes('Timings'),false);
  assert.equal(JSON.stringify(payload).includes('prepareMs'),false);
  await engine.complete({...callback,jobId:f.job.id,contextVersion:f.job.context_version});
  const timings=(await f.event())?.timings as {backend:Record<string,number>,n8nReported?:unknown};
  assert.equal(timings.n8nReported,undefined);
  assert.deepEqual(Object.keys(timings.backend).sort(),['dispatchPreparationMs','n8nAckMs','completeReadMs','guardMemoryMs','persistBeforeEventMs'].sort());
  assert.ok(Object.values(timings.backend).every(value=>Number.isInteger(value)&&value>=0));
 }finally{await f.db.close();}
});

test('callback winning the ACK race keeps only measured preparation and never reopens the completed job',async()=>{
 const f=await fixture();
 try {
  const engine:Engine=new Engine(f.store,testConfig,async(_url,options)=>{
   assert.equal(String(options?.body).includes('backendTimings'),false);
   assert.deepEqual(await engine.complete({...callback,jobId:f.job.id,contextVersion:f.job.context_version,timings:{modelRoundTripMs:25}}),{accepted:true});
   return Response.json({accepted:true});
  },f.clock);
  await engine.dispatch(f.channel,f.job);
  const timings=(await f.event())?.timings as {backend:Record<string,number>,n8nReported:unknown};
  assert.ok(Number.isInteger(timings.backend.dispatchPreparationUntilContextWriteMs));
  for(const key of ['dispatchPreparationMs','preflightMs','prepareMs','budgetReservationMs','n8nAckMs'])assert.equal(timings.backend[key],undefined,key);
  assert.deepEqual(timings.n8nReported,{modelRoundTripMs:25});
  const stored=(await f.db.query<{state:string,context:{backendTimings:Record<string,number>}}>('SELECT state,context FROM sdr.jobs WHERE id=$1',[f.job.id])).rows[0];
  assert.equal(stored.state,'completed');assert.equal(stored.context.backendTimings.n8nAckMs,undefined);
 }finally{await f.db.close();}
});
