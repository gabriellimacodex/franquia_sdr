import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/database.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { seedPilot } from '../src/seed.js';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';

async function fixture(text='Quero conhecer a franquia.') {
 const actual=await testDatabase(),calls:{sql:string,params?:unknown[]}[]=[];
 let time=0,transactions=0,providerCalls=0;
 const db:Database={
  query:async<T>(sql:string,params?:unknown[])=>{calls.push({sql,params});time+=150;return actual.query<T>(sql,params);},
  transaction:async fn=>{transactions++;time+=150;try{return await actual.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{calls.push({sql,params});time+=150;return tx.query<T>(sql,params);}}));}finally{time+=150;}},
  close:()=>actual.close(),
 };
 await seedPilot(actual,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
 const store=new Store(db),sessions=new LabSessions(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 const created=await sessions.create(user,{requestId:randomUUID(),label:'Conclusão local',scenario:'free'});assert.ok(created.ok);
 const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text});assert.ok(sent.ok);assert.ok(sent.value.jobId);
 const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
 const engine=new Engine(store,testConfig,async()=>{providerCalls++;return Response.json({accepted:true});},()=>time);
 await engine.dispatch(channel,job);
 const result={bubbles:['Obrigado pelo interesse.','Em qual cidade você pretende abrir?'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
 const callback={jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:'gpt-5.4-2026-03-05',usage:{input_tokens:101,output_tokens:10,total_tokens:111},result};
 const reset=()=>{calls.length=0;time=0;transactions=0;};
 const metrics=()=>({queries:calls.length,transactions,simulatedMs:time,providerCalls});
 return {actual,db,store,sessions,user,sessionId:created.value.id,channel,job,engine,callback,calls,reset,metrics};
}

test('laboratory completion persists both bounded bubbles in one scoped insert without changing identity or replay',async()=>{
 const f=await fixture();
 try {
  f.reset();assert.deepEqual(await f.engine.complete(f.callback),{accepted:true});
  assert.equal(f.calls.filter(call=>call.sql.startsWith('INSERT INTO sdr.messages')).length,1,'the validated reply must use one batch insert');
  const messages=await f.actual.query<{id:string,text:string,actor:string,conversation_id:string,candidate_id:string}>('SELECT id,text,actor,conversation_id,candidate_id FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND id=ANY($3::text[]) ORDER BY id',[f.channel.tenantId,f.channel.brandId,f.callback.result.bubbles.map((_,i)=>f.job.id+':reply:'+i)]);
  assert.deepEqual(messages.rows,f.callback.result.bubbles.map((text,i)=>({id:f.job.id+':reply:'+i,text,actor:'agent',conversation_id:f.job.conversation_id,candidate_id:f.job.candidate_id})));
  assert.equal(f.metrics().providerCalls,1,'completion and replay must not call a provider');
  const detail=await f.sessions.detail(f.user,f.sessionId);assert.ok(detail.ok);
  assert.deepEqual(detail.value.messages.filter(message=>message.actor==='agent').map(message=>message.text),f.callback.result.bubbles);
  f.reset();assert.deepEqual(await f.engine.complete(f.callback),{accepted:false,reason:'STALE_RESULT'});
  assert.equal(f.calls.some(call=>/^(UPDATE|INSERT|DELETE)/.test(call.sql)),false);
  assert.deepEqual(await f.sessions.detail(f.user,f.sessionId),detail);
  assert.equal((await f.actual.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
 }finally{await f.actual.close();}
});

test('accepted laboratory completion writes the terminal state once and preserves locks and budget settlement',async t=>{
 const f=await fixture();
 try {
  f.reset();assert.deepEqual(await f.engine.complete(f.callback),{accepted:true});
  t.diagnostic(JSON.stringify(f.metrics()));
  assert.equal(f.calls.filter(call=>call.sql.startsWith('UPDATE sdr.jobs')).length,1,'do not write ready followed by completed inside the same transaction');
  const grouped=f.calls.filter(call=>call.sql.includes('locked_job AS MATERIALIZED'));assert.equal(grouped.length,1);
  assert.deepEqual([...grouped[0].sql.matchAll(/FOR UPDATE OF (\w+)/g)].map(match=>match[1]),['j','c','p']);
  assert.equal(f.calls[1].sql.includes('pg_advisory_xact_lock'),true,'scope lock must precede row locks');
  // New grouped-read requirement removes four queries; all write/ledger assertions remain.
  assert.deepEqual(f.metrics(),{queries:9,transactions:1,simulatedMs:1650,providerCalls:1});
  t.diagnostic('Two-bubble completion: 1650 ms versus the r7 2250 ms at a simulated 150 ms per database round trip; not E2E.');
  const job=(await f.actual.query<{state:string,result:unknown,error_code:string|null}>('SELECT state,result,error_code FROM sdr.jobs WHERE id=$1',[f.job.id])).rows[0];
  assert.equal(job.state,'completed');assert.equal(job.error_code,null);assert.deepEqual(job.result,f.callback.result);
  const reservation=(await f.actual.query<{detail:{settled:boolean,costMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved' AND detail->>'jobId'=$1",[f.job.id])).rows[0];
  assert.equal(reservation.detail.settled,true);assert.equal(reservation.detail.costMicroUsd,403);
  assert.equal((await f.actual.query("SELECT id FROM sdr.events WHERE type='turn_completed' AND detail->>'jobId'=$1",[f.job.id])).rows.length,1);
 }finally{await f.actual.close();}
});

test('an accepted empty reply performs no message insert and still settles the completed laboratory job',async()=>{
 const f=await fixture();
 try {
  f.reset();assert.deepEqual(await f.engine.complete({...f.callback,result:{...f.callback.result,bubbles:[]}}),{accepted:true});
  assert.equal(f.calls.filter(call=>call.sql.startsWith('INSERT INTO sdr.messages')).length,0,'empty output must not add a round trip');
  assert.equal((await f.actual.query<{state:string}>('SELECT state FROM sdr.jobs WHERE id=$1',[f.job.id])).rows[0].state,'completed');
  assert.equal((await f.actual.query<{detail:{settled:boolean}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved' AND detail->>'jobId'=$1",[f.job.id])).rows[0].detail.settled,true);
 }finally{await f.actual.close();}
});

test('a collision on the second bubble rolls back memory, terminal state, first bubble and completion event',async()=>{
 const text='Quero conhecer a franquia em Campinas.',f=await fixture(text);
 try {
  await f.actual.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'agent','text','Preexisting collision',now())",[f.channel.tenantId,f.channel.brandId,f.job.id+':reply:1',f.job.conversation_id,f.job.candidate_id]);
  const before=await f.actual.query('SELECT * FROM sdr.candidates WHERE id=$1',[f.job.candidate_id]);
  const beforeJob=await f.actual.query('SELECT * FROM sdr.jobs WHERE id=$1',[f.job.id]);
  const beforeEvents=await f.actual.query('SELECT * FROM sdr.events WHERE conversation_id=$1 ORDER BY id',[f.job.conversation_id]);
  const proposals=[{field:'city',value:{kind:'text',text:'Campinas'},evidence:{messageId:f.job.trigger_message_id,quote:text},attribution:'candidate',capitalOrigin:null,relationId:null,replacesFactId:null}];
  await assert.rejects(f.engine.complete({...f.callback,result:{...f.callback.result,proposals}}),error=>(error as {code?:string}).code==='23505');
  assert.deepEqual(await f.actual.query('SELECT * FROM sdr.candidates WHERE id=$1',[f.job.candidate_id]),before);
  assert.deepEqual(await f.actual.query('SELECT * FROM sdr.jobs WHERE id=$1',[f.job.id]),beforeJob);
  assert.deepEqual(await f.actual.query('SELECT * FROM sdr.events WHERE conversation_id=$1 ORDER BY id',[f.job.conversation_id]),beforeEvents,'reservation must remain unsettled and no completion event may escape');
  assert.equal((await f.actual.query('SELECT id FROM sdr.facts WHERE candidate_id=$1',[f.job.candidate_id])).rows.length,0);
  const replies=await f.actual.query<{id:string,text:string}>("SELECT id,text FROM sdr.messages WHERE id=ANY($1::text[]) ORDER BY id",[[f.job.id+':reply:0',f.job.id+':reply:1']]);
  assert.deepEqual(replies.rows,[{id:f.job.id+':reply:1',text:'Preexisting collision'}]);
 }finally{await f.actual.close();}
});

test('settlement failure after the completion event rolls back the full response without releasing its reservation',async()=>{
 const f=await fixture();
 try {
  const beforeJob=await f.actual.query('SELECT * FROM sdr.jobs WHERE id=$1',[f.job.id]);
  const beforeCandidate=await f.actual.query('SELECT * FROM sdr.candidates WHERE id=$1',[f.job.candidate_id]);
  const beforeEvents=await f.actual.query('SELECT * FROM sdr.events WHERE conversation_id=$1 ORDER BY id',[f.job.conversation_id]);
  let completionEventWritten=false,settlementAttempted=false;
  const failing:Database={...f.db,transaction:fn=>f.db.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{
   if(sql.startsWith('UPDATE sdr.events SET detail=detail||')){settlementAttempted=true;throw new Error('synthetic settlement failure');}
   const result=await tx.query<T>(sql,params);
   if(sql.startsWith('INSERT INTO sdr.events')&&params?.includes('turn_completed'))completionEventWritten=true;
   return result;
  }}))};
  const engine=new Engine(new Store(failing),testConfig,async()=>{assert.fail('completion must not call a provider');});
  await assert.rejects(engine.complete(f.callback),/synthetic settlement failure/);
  assert.equal(completionEventWritten,true);assert.equal(settlementAttempted,true);
  assert.deepEqual(await f.actual.query('SELECT * FROM sdr.jobs WHERE id=$1',[f.job.id]),beforeJob);
  assert.deepEqual(await f.actual.query('SELECT * FROM sdr.candidates WHERE id=$1',[f.job.candidate_id]),beforeCandidate);
  assert.deepEqual(await f.actual.query('SELECT * FROM sdr.events WHERE conversation_id=$1 ORDER BY id',[f.job.conversation_id]),beforeEvents);
  assert.equal((await f.actual.query("SELECT id FROM sdr.messages WHERE conversation_id=$1 AND actor='agent'",[f.job.conversation_id])).rows.length,0);
 }finally{await f.actual.close();}
});
