import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Engine } from '../src/engine.js';
import { testConfig } from './config.js';
import { reserveLabBudget } from '../src/lab-budget.js';
import { ConfigSchema } from '../src/config.js';

async function fixture(tenantId='cognita-homologacao') {
 const db=await testDatabase(),store=new Store(db),sessions=new LabSessions(db);
 await seedPilot(db,{tenantId,testers:[{contactId:'5511999999999',label:'Synthetic'}]});
 const user={tenantId,brandId:'sapore',userId:'tester',role:'tester'};
 async function nextJob(text='Olá, quero conhecer a franquia.') {
  const session=await sessions.create(user,{requestId:randomUUID(),label:'Cota de teste',scenario:'free'});assert.ok(session.ok);
  const sent=await sessions.send(user,session.value.id,{requestId:randomUUID(),text});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[sent.value.jobId]);
  const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  return {channel,job};
 }
 return {db,store,nextJob};
}

test('laboratory refuses paid dispatch without a configured budget and explains the pause',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const {channel,job}=await nextJob();let calls=0;
  const config={...testConfig,LAB_BUDGET_GATE_ID:undefined,LAB_BUDGET_LIMIT_MICRO_USD:undefined};
  await new Engine(store,config,async()=>{calls++;return Response.json({accepted:true});}).dispatch(channel,job);
  assert.equal(calls,0);
  const terminal=(await db.query<{state:string,error_code:string}>('SELECT state,error_code FROM sdr.jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(terminal.state,'handoff');assert.equal(terminal.error_code,'LAB_BUDGET_NOT_CONFIGURED');
  const messages=(await db.query<{text:string}>("SELECT text FROM sdr.messages WHERE actor='agent'")).rows;
  assert.equal(messages.length,1);assert.match(messages[0].text,/cota/i);
 }finally{await db.close();}
});

test('one reservation permits one dispatch, survives engine restart and blocks overspending',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const {channel,job}=await nextJob();let calls=0;
  const transport:typeof fetch=async()=>{calls++;return Response.json({accepted:true});};
  const engine=new Engine(store,testConfig,transport);
  await Promise.all([engine.dispatch(channel,job),engine.dispatch(channel,job)]);
  assert.equal(calls,1);
  const events=(await db.query<{detail:{gateId:string,costMicroUsd:number,reservedMicroUsd:number,jobId:string}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(events.length,1);assert.equal(events[0].detail.jobId,job.id);
  assert.ok(events[0].detail.costMicroUsd>18000);
  assert.equal(events[0].detail.costMicroUsd,events[0].detail.reservedMicroUsd);
  const second=await nextJob();
  const restarted=new Engine(store,{...testConfig,LAB_BUDGET_LIMIT_MICRO_USD:events[0].detail.costMicroUsd},transport);
  await restarted.dispatch(second.channel,second.job);
  assert.equal(calls,1);
  assert.equal((await db.query<{error_code:string}>('SELECT error_code FROM sdr.jobs WHERE id=$1',[second.job.id])).rows[0].error_code,'LAB_BUDGET_EXHAUSTED');
 }finally{await db.close();}
});

test('accepted single-attempt completion settles measured usage exactly once',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const {channel,job}=await nextJob();
  const engine=new Engine(store,testConfig,async()=>Response.json({accepted:true}));
  await engine.dispatch(channel,job);
  const completion={jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:'gpt-5.4-2026-03-05',usage:{input_tokens:101,output_tokens:10,total_tokens:111},result:{bubbles:['Olá!'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}};
  assert.equal((await engine.complete(completion)).accepted,true);
  const reservation=async()=>(await db.query<{detail:{costMicroUsd:number,settled:boolean}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0].detail;
  assert.equal((await reservation()).costMicroUsd,403);assert.equal((await reservation()).settled,true);
  assert.equal((await engine.complete({...completion,usage:{input_tokens:1,output_tokens:1}})).accepted,false);
  assert.equal((await reservation()).costMicroUsd,403);
 }finally{await db.close();}
});

test('laboratory never uses the embedding model even when a direct OpenAI key exists',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const {channel,job}=await nextJob();const urls:string[]=[];
  await new Engine(store,{...testConfig,OPENAI_API_KEY:'synthetic-openai-key'},async url=>{urls.push(String(url));return Response.json({accepted:true});}).dispatch(channel,job);
  assert.deepEqual(urls,[testConfig.N8N_WEBHOOK_URL]);
 }finally{await db.close();}
});

test('laboratory rejects untranscribed audio locally without Kapso or transcription spending',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const {channel,job}=await nextJob();let calls=0;
  await db.query("UPDATE sdr.messages SET type='audio',text='',media_id='synthetic-audio' WHERE id=$1",[job.trigger_message_id]);
  await new Engine(store,{...testConfig,OPENAI_API_KEY:'synthetic-openai-key'},async()=>{calls++;return Response.json({});}).dispatch(channel,job);
  assert.equal(calls,0);
  const reply=(await db.query<{text:string}>("SELECT text FROM sdr.messages WHERE actor='agent'")).rows[0];
  assert.match(reply.text,/texto/i);
  assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.jobs WHERE id=$1',[job.id])).rows[0].state,'completed');
 }finally{await db.close();}
});

test('request input bound cannot enter the larger-context price tier',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const {channel,job}=await nextJob();
  assert.equal(await reserveLabBudget(store,testConfig,channel,job,{model:'gpt-5.4-2026-03-05',context:'x'.repeat(272000)}),false);
  assert.equal((await db.query<{error_code:string}>('SELECT error_code FROM sdr.jobs WHERE id=$1',[job.id])).rows[0].error_code,'LAB_BUDGET_INPUT_TOO_LARGE');
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
 }finally{await db.close();}
});

test('the pilot budget cannot be multiplied across another tenant',async()=>{
 const {db,store,nextJob}=await fixture('another-tenant');
 try {
  const {channel,job}=await nextJob();let calls=0;
  await new Engine(store,testConfig,async()=>{calls++;return Response.json({accepted:true});}).dispatch(channel,job);
  assert.equal(calls,0);
  assert.equal((await db.query<{error_code:string}>('SELECT error_code FROM sdr.jobs WHERE id=$1',[job.id])).rows[0].error_code,'LAB_BUDGET_SCOPE_MISMATCH');
 }finally{await db.close();}
});

test('budget configuration requires a positive cap and gate as a pair',()=>{
 const input={...testConfig,EXECUTION_MODE:'laboratory',N8N_WEBHOOK_TOKEN:'a'.repeat(32),N8N_CALLBACK_TOKEN:'b'.repeat(32)};
 assert.equal(ConfigSchema.safeParse(input).success,true);
 assert.equal(ConfigSchema.safeParse({...input,LAB_BUDGET_GATE_ID:undefined}).success,false);
 assert.equal(ConfigSchema.safeParse({...input,LAB_BUDGET_LIMIT_MICRO_USD:undefined}).success,false);
 assert.equal(ConfigSchema.safeParse({...input,LAB_BUDGET_LIMIT_MICRO_USD:0}).success,false);
 assert.equal(ConfigSchema.safeParse({...input,LAB_BUDGET_LIMIT_MICRO_USD:-1}).success,false);
});

test('historical ambiguous attempts across gates keep every full reservation after a valid completion',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const {channel,job}=await nextJob();
  await assert.rejects(new Engine(store,testConfig,async()=>{throw new Error('uncertain POST outcome');}).dispatch(channel,job),/uncertain/);
  // Historical ledger fixture: new worker recovery must not create this second
  // paid attempt, but old ambiguous reservations must remain fully accounted for.
  await db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) SELECT id||':historical',tenant_id,brand_id,conversation_id,type,detail||$2::jsonb FROM sdr.events WHERE type='lab_model_budget_reserved' AND detail->>'jobId'=$1",[job.id,JSON.stringify({gateId:'second-synthetic-gate',attempt:2})]);
  await db.query("UPDATE sdr.jobs SET attempts=2 WHERE id=$1",[job.id]);
  const engine=new Engine(store,{...testConfig,LAB_BUDGET_GATE_ID:'second-synthetic-gate'},async()=>Response.json({accepted:true}));
  const completion={jobId:job.id,contextVersion:job.context_version,model:'gpt-5.4-2026-03-05',usage:{input_tokens:100,output_tokens:10},result:{bubbles:['Olá!'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}};
  assert.equal((await engine.complete(completion)).accepted,true);
  const events=(await db.query<{detail:{costMicroUsd:number,reservedMicroUsd:number,settled:boolean}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(events.length,2);
  for(const {detail} of events){assert.equal(detail.settled,false);assert.equal(detail.costMicroUsd,detail.reservedMicroUsd);}
 }finally{await db.close();}
});

test('missing, inconsistent and stale provider usage never releases reserved budget',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  for(const scenario of ['missing','inconsistent','stale']) {
   const {channel,job}=await nextJob();
   const engine=new Engine(store,testConfig,async()=>Response.json({accepted:true}));
   await engine.dispatch(channel,job);
   if(scenario==='stale')await db.query("UPDATE sdr.jobs SET state='stale' WHERE id=$1",[job.id]);
   const usage=scenario==='missing'?undefined:{input_tokens:100,output_tokens:10,total_tokens:scenario==='inconsistent'?1:110};
   const result=await engine.complete({jobId:job.id,contextVersion:job.context_version,model:'gpt-5.4-2026-03-05',usage,result:{bubbles:['Olá!'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}});
   assert.equal(result.accepted,scenario!=='stale');
   const event=(await db.query<{detail:{costMicroUsd:number,reservedMicroUsd:number,settled:boolean}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved' AND detail->>'jobId'=$1",[job.id])).rows[0].detail;
   assert.equal(event.settled,false);assert.equal(event.costMicroUsd,event.reservedMicroUsd);
  }
 }finally{await db.close();}
});

test('simultaneous distinct jobs share the same finite gate balance',async()=>{
 const {db,store,nextJob}=await fixture();
 try {
  const baseline=await nextJob();
  await new Engine(store,testConfig,async()=>Response.json({accepted:true})).dispatch(baseline.channel,baseline.job);
  const firstCost=(await db.query<{detail:{costMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0].detail.costMicroUsd;
  const first=await nextJob(),second=await nextJob();let calls=0;
  const config={...testConfig,LAB_BUDGET_GATE_ID:'concurrent-synthetic-gate',LAB_BUDGET_LIMIT_MICRO_USD:Math.floor(firstCost*1.5)};
  const engine=new Engine(store,config,async()=>{calls++;return Response.json({accepted:true});});
  await Promise.all([engine.dispatch(first.channel,first.job),engine.dispatch(second.channel,second.job)]);
  assert.equal(calls,1);
  const spend=(await db.query<{sum:string}>("SELECT sum((detail->>'costMicroUsd')::bigint)::text AS sum FROM sdr.events WHERE type='lab_model_budget_reserved' AND detail->>'gateId'=$1",[config.LAB_BUDGET_GATE_ID])).rows[0];
  assert.ok(Number(spend.sum)<=config.LAB_BUDGET_LIMIT_MICRO_USD);
 }finally{await db.close();}
});
