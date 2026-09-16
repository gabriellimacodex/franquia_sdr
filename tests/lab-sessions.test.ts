import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { seedPilot } from '../src/seed.js';
import { createServer } from '../src/server.js';
import { testConfig } from './config.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Briefings } from '../src/briefings.js';
import { Lab } from '../src/lab.js';

test('laboratory sessions are private, idempotent and create independent candidates', async () => {
 const db=await testDatabase();
 const app=await createServer(db,testConfig,{transport:async (_url,init)=>Response.json({id:String(new Headers(init?.headers).get('authorization')).slice(7)})});
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  for(const id of ['alice','bob']) await db.query("INSERT INTO sdr.memberships VALUES ($1,'cognita-homologacao','sapore','reviewer',true)",[id]);
  const payload={requestId:randomUUID(),label:'Primeiro contato',scenario:'free'};
  const request={method:'POST' as const,url:'/v1/lab/sessions',headers:{authorization:'Bearer alice'},payload};
  const first=await app.inject(request);
  assert.equal(first.statusCode,200,first.body);
  const session=first.json();
  assert.equal((await app.inject(request)).json().id,session.id);
  const second=(await app.inject({...request,payload:{...payload,requestId:randomUUID()}})).json();
  assert.notEqual(second.candidateId,session.candidateId);
  assert.equal((await app.inject({url:'/v1/lab/sessions',headers:{authorization:'Bearer bob'}})).json().sessions.length,0);
  assert.equal((await app.inject({url:'/v1/lab/sessions/'+session.id,headers:{authorization:'Bearer bob'}})).statusCode,404);
 } finally {await app.close();await db.close();}
});

test('human request pauses the lab, invalidates pending replies and never queues a Kapso assignment',async()=>{
 const db=await testDatabase(),lab=new LabSessions(db),store=new Store(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const session=await lab.create(user,{requestId:randomUUID(),label:'Humano',scenario:'human'});assert.ok(session.ok);
  await lab.send(user,session.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia'});
  await lab.send(user,session.value.id,{requestId:randomUUID(),text:'Quero falar com um humano'});
  const detail=await lab.detail(user,session.value.id);assert.ok(detail.ok);assert.equal(detail.value.session.state,'human');
  const brief=(await db.query<{assignment_status:string,version_id:string}>('SELECT * FROM sdr.briefings')).rows[0];assert.equal(brief.assignment_status,'not_applicable');assert.equal(brief.version_id,session.value.versionId);
  let calls=0;await new Briefings(store,testConfig,async()=>{calls++;return Response.json({});}).dispatch(await store.channel('1093705843816293'));assert.equal(calls,0);
  const snapshot=async()=>(await db.query<{messages:number,jobs:number,briefings:number,events:number,deliveries:number}>(`SELECT
   (SELECT count(*)::int FROM sdr.messages) AS messages,
   (SELECT count(*)::int FROM sdr.jobs) AS jobs,
   (SELECT count(*)::int FROM sdr.briefings) AS briefings,
   (SELECT count(*)::int FROM sdr.events) AS events,
   (SELECT count(*)::int FROM sdr.deliveries) AS deliveries`)).rows[0];
  const before=await snapshot();
  const blocked=await lab.send(user,session.value.id,{requestId:randomUUID(),text:'Outra pergunta'});assert.equal(blocked.ok,false);
  if(!blocked.ok)assert.equal(blocked.error.code,'SESSION_PAUSED');
  assert.deepEqual(await snapshot(),before);
 }finally{await db.close();}
});

test('WhatsApp worker cannot claim laboratory jobs; validated replies persist once without delivery records',async()=>{
 const db=await testDatabase(),store=new Store(db),lab=new LabSessions(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const created=await lab.create(user,{requestId:randomUUID(),label:'Teste',scenario:'free'});assert.ok(created.ok);
  const sent=await lab.send(user,created.value.id,{requestId:randomUUID(),text:'Olá, quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  await db.query('UPDATE sdr.jobs SET available_at=now()');
  assert.equal(await store.claim(await store.channel('1093705843816293')),undefined);
  const channel=await store.scopeForJob(sent.value.jobId);const job=await store.claim(channel);assert.ok(job);
  const engine=new Engine(store,testConfig,async()=>Response.json({accepted:true}));await engine.dispatch(channel,job);
  const callback={jobId:job.id,contextVersion:job.context_version,result:{bubbles:['Olá! Sou o assistente virtual da Sapore. Em qual cidade você pensa em abrir?'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}};
  assert.equal((await engine.complete(callback)).accepted,true);
  assert.equal((await engine.complete(callback)).accepted,false);
  assert.equal((await db.query("SELECT * FROM sdr.messages WHERE actor='agent'")).rows.length,1);
  assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length,0);
 }finally{await db.close();}
});

test('laboratory text creates one pinned job and repeated requests do not duplicate messages',async()=>{
 const db=await testDatabase();const app=await createServer(db,testConfig,{transport:async()=>Response.json({id:'tester'})});
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  await db.query("INSERT INTO sdr.memberships VALUES ('tester','cognita-homologacao','sapore','tester',true)");
  const headers={authorization:'Bearer tester'};
  const session=(await app.inject({method:'POST',url:'/v1/lab/sessions',headers,payload:{requestId:randomUUID(),label:'Texto',scenario:'free'}})).json();
  const request={method:'POST' as const,url:`/v1/lab/sessions/${session.id}/messages`,headers,payload:{requestId:randomUUID(),text:'Tenho interesse em uma franquia.'}};
  const response=await app.inject(request);assert.equal(response.statusCode,200,response.body);
  assert.equal((await app.inject(request)).json().jobId,response.json().jobId);
  const jobs=(await db.query<{version_id:string}>('SELECT * FROM sdr.jobs')).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].version_id,session.versionId);
  assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,1);
  const conflict=await app.inject({...request,payload:{...request.payload,text:'Outro texto'}});assert.equal(conflict.statusCode,409);
 }finally{await app.close();await db.close();}
});

test('tester detail exposes the response deadline without leaking worker lease data',async()=>{
 const db=await testDatabase(),lab=new LabSessions(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const created=await lab.create(user,{requestId:randomUUID(),label:'Prazo visível',scenario:'free'});assert.ok(created.ok);
  const sent=await lab.send(user,created.value.id,{requestId:randomUUID(),text:'Olá.'});assert.ok(sent.ok);
  const detail=await lab.detail(user,created.value.id);assert.ok(detail.ok);assert.ok(detail.value.job);
  assert.equal(Number.isFinite(Date.parse(String(detail.value.job.deadline))),true);
  assert.equal('leaseUntil' in detail.value.job,false);
  assert.equal('availableAt' in detail.value.job,false);
 }finally{await db.close();}
});

test('tester membership cannot inspect other conversations through legacy reviewer endpoints',async()=>{
 const db=await testDatabase();const app=await createServer(db,testConfig,{transport:async()=>Response.json({id:'tester'})});
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  await db.query("INSERT INTO sdr.memberships VALUES ('tester','cognita-homologacao','sapore','tester',true)");
  for(const url of ['/v1/conversations','/v1/conversations/unknown','/v1/versions']) assert.equal((await app.inject({url,headers:{authorization:'Bearer tester'}})).statusCode,403);
 }finally{await app.close();await db.close();}
});

test('reviewer observability exposes scoped operational metrics without prompts, secrets or job context',async()=>{
 const db=await testDatabase(),store=new Store(db),sessions=new LabSessions(db),lab=new Lab(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'reviewer',role:'reviewer'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Observabilidade',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  await db.query('UPDATE sdr.jobs SET available_at=now()');
  const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  const engine=new Engine(store,testConfig,async()=>Response.json({accepted:true}));
  await engine.dispatch(channel,job);
  await engine.complete({jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:'gpt-5.4-2026-03-05',usage:{input_tokens:120,output_tokens:30,total_tokens:150},result:{bubbles:['Olá!'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}});
  const detail=await lab.detail(user,created.value.id);
  assert.deepEqual(detail.observability,{tenantId:user.tenantId,brandId:user.brandId});
  assert.equal(detail.jobs[0].correlationId,job.id);
  assert.equal(detail.jobs[0].attempts,1);
  assert.equal(detail.jobs[0].retrievalMode,'lexical');
  assert.deepEqual(detail.jobs[0].usage,{input_tokens:120,output_tokens:30,total_tokens:150});
  const serialized=JSON.stringify(detail);
  for(const forbidden of ['instructions','outputSchema','authorization','N8N_WEBHOOK_TOKEN','context'])assert.equal(serialized.includes(forbidden),false);
 }finally{await db.close();}
});

test('controlled timeout exposes correlation and latency without creating a delivery',async()=>{
 const db=await testDatabase(),store=new Store(db),sessions=new LabSessions(db),lab=new Lab(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'reviewer',role:'reviewer'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Timeout controlado',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  await db.query("UPDATE sdr.jobs SET deadline=now()-interval '1 second' WHERE id=$1",[sent.value.jobId]);
  const channel=await store.scopeForJob(sent.value.jobId);
  assert.equal(await store.claim(channel),undefined);
  const detail=await lab.detail(user,created.value.id),job=detail.jobs[0];
  assert.equal(job.status,'handoff');
  assert.equal(job.errorCode,'PROCESSING_TIMEOUT');
  assert.equal(job.correlationId,sent.value.jobId);
  if(job.latencyMs===null)assert.fail('timeout latency must be recorded');
  assert.equal(typeof job.latencyMs,'number');
  assert.ok(job.latencyMs>=0);
  assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length,0);
 }finally{await db.close();}
});

test('laboratory timeout never dispatches an unapproved briefing model call',async()=>{
 const db=await testDatabase(),store=new Store(db),sessions=new LabSessions(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'reviewer',role:'reviewer'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Timeout sem briefing pago',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  await db.query("UPDATE sdr.jobs SET deadline=now()-interval '1 second' WHERE id=$1",[sent.value.jobId]);
  const channel=await store.scopeForJob(sent.value.jobId);assert.equal(await store.claim(channel),undefined);
  let calls=0;
  await new Briefings(store,testConfig,async()=>{calls++;return Response.json({accepted:true});}).dispatch(channel);
  assert.equal(calls,0);
 }finally{await db.close();}
});

test('a superseded laboratory job records terminal latency without creating a delivery',async()=>{
 const db=await testDatabase(),sessions=new LabSessions(db),lab=new Lab(db);
 const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'reviewer',role:'reviewer'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Mensagem substituída',scenario:'free'});assert.ok(created.ok);
  const first=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(first.ok);assert.ok(first.value.jobId);
  const second=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Também quero entender o investimento.'});assert.ok(second.ok);assert.ok(second.value.jobId);
  const detail=await lab.detail(user,created.value.id),superseded=detail.jobs.find(job=>job.correlationId===first.value.jobId);
  assert.ok(superseded);
  assert.equal(superseded.status,'stale');
  assert.equal(superseded.errorCode,'CONTEXT_CHANGED');
  if(superseded.latencyMs===null)assert.fail('superseded job latency must be recorded');
  assert.ok(superseded.latencyMs>=0);
  assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length,0);
 }finally{await db.close();}
});

test('a reauthenticated user resumes the same laboratory history after an API restart',async()=>{
 const db=await testDatabase();
 const transport=async (_url:unknown,init?:RequestInit)=>{
  const token=String(new Headers(init?.headers).get('authorization')).slice(7);
  return Response.json({id:token.startsWith('login-')?'tester':'unknown',email:'tester@example.invalid'});
 };
 let app=await createServer(db,testConfig,{transport:transport as typeof fetch});
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  await db.query("INSERT INTO sdr.memberships VALUES ('tester','cognita-homologacao','sapore','tester',true)");
  const firstHeaders={authorization:'Bearer login-first'};
  const created=await app.inject({method:'POST',url:'/v1/lab/sessions',headers:firstHeaders,payload:{requestId:randomUUID(),label:'Continuidade',scenario:'free'}});assert.equal(created.statusCode,200,created.body);
  const session=created.json();
  const sent=await app.inject({method:'POST',url:`/v1/lab/sessions/${session.id}/messages`,headers:firstHeaders,payload:{requestId:randomUUID(),text:'Meu interesse fictício é pela região Sul.'}});assert.equal(sent.statusCode,200,sent.body);
  await app.close();
  app=await createServer(db,testConfig,{transport:transport as typeof fetch});
  const secondHeaders={authorization:'Bearer login-second'};
  const list=await app.inject({url:'/v1/lab/sessions',headers:secondHeaders});assert.equal(list.statusCode,200,list.body);
  assert.deepEqual(list.json().sessions.map((item:{id:string})=>item.id),[session.id]);
  const detail=await app.inject({url:`/v1/lab/sessions/${session.id}`,headers:secondHeaders});assert.equal(detail.statusCode,200,detail.body);
  assert.deepEqual(detail.json().messages.map((item:{text:string})=>item.text),['Meu interesse fictício é pela região Sul.']);
 }finally{await app.close();await db.close();}
});
