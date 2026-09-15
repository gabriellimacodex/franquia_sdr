import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import type { Database } from '../src/database.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { seedPilot } from '../src/seed.js';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';

test('laboratory dispatch fuses preflight/preparation/reservation and measures the phase through commit',async()=>{
 const actual=await testDatabase();
 const roundTripMs=150;let now=0,transactions=0,queries=0,inTransaction=false,requests=0;
 const db:Database={
  query:async<T>(sql:string,params?:unknown[])=>{now+=roundTripMs;queries++;return actual.query<T>(sql,params);},
  transaction:async fn=>{
   transactions++;now+=roundTripMs;inTransaction=true;
   try{return await actual.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{now+=roundTripMs;queries++;return tx.query<T>(sql,params);}}));}
   finally{now+=roundTripMs;inTransaction=false;}
  },
  close:()=>actual.close(),
 };
 try {
  await seedPilot(actual,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const store=new Store(db),sessions=new LabSessions(db);
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Preflight local',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);
  const channel=await store.scopeForJob(sent.value.jobId!),job=await store.claim(channel);assert.ok(job);
  now=0;transactions=0;queries=0;
  const engine=new Engine(store,testConfig,async url=>{
   requests++;assert.equal(inTransaction,false,'provider transport must stay outside the database lock');
   assert.equal(String(url),testConfig.N8N_WEBHOOK_URL);
   return Response.json({accepted:true});
  },()=>now);
  await engine.dispatch(channel,job);
  const stored=(await actual.query<{context:{backendTimings:{dispatchPreparationMs:number}}}>('SELECT context FROM sdr.jobs WHERE id=$1',[job.id])).rows[0];
  // Fused preparation is nine exchanges including BEGIN/COMMIT, at 150 ms each.
  assert.equal(stored.context.backendTimings.dispatchPreparationMs,9*roundTripMs);
  assert.equal(transactions,2,'only the conditional ACK remains independent');
  assert.equal(queries,9,'seven fused preparation queries plus two ACK queries');
  assert.equal(requests,1,'only the fictional n8n transport is used');
 }finally{await actual.close();}
});

test('combined preflight keeps the trigger check outside the 24-message audio window',async()=>{
 const db=await testDatabase();
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const store=new Store(db),sessions=new LabSessions(db);
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Janela de áudio',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Mensagem de teste.'});assert.ok(sent.ok);
  const channel=await store.scopeForJob(sent.value.jobId!),job=await store.claim(channel);assert.ok(job);
  await db.query("UPDATE sdr.messages SET type='unsupported',text='',provider_timestamp=now()-interval '2 minutes' WHERE id=$1",[job.trigger_message_id]);
  await db.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,media_id,provider_timestamp)
   SELECT 'window-'||n,$1,$2,$3,$4,'candidate',CASE WHEN n=0 THEN 'audio' ELSE 'text' END,
    CASE WHEN n=0 THEN '' ELSE 'Texto fictício' END,CASE WHEN n=0 THEN 'old-audio' ELSE NULL END,
    now()-(25-n)*interval '1 second' FROM generate_series(0,24) AS n`,[channel.tenantId,channel.brandId,job.conversation_id,job.candidate_id]);
  const engine=new Engine(store,testConfig,async()=>{assert.fail('unsupported input must not reach any provider');});
  await engine.dispatch(channel,job);
  const reply=(await db.query<{text:string}>("SELECT text FROM sdr.messages WHERE id=$1",[job.id+':capability'])).rows[0];
  assert.equal(reply.text,'Nesta etapa, consigo conversar por texto e receber áudio. Pode escrever a sua dúvida?');
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
 }finally{await db.close();}
});

test('combined preflight ignores other conversations, noncandidate audio and existing transcripts',async()=>{
 const db=await testDatabase();
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const store=new Store(db),sessions=new LabSessions(db);
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Texto local',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);
  const channel=await store.scopeForJob(sent.value.jobId!),job=await store.claim(channel);assert.ok(job);
  const other=await sessions.create(user,{requestId:randomUUID(),label:'Outra conversa',scenario:'free'});assert.ok(other.ok);
  await db.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,media_id,provider_timestamp)
   VALUES('other-audio',$1,$2,$3,$4,'candidate','audio','','other-media',now()),
    ('operator-audio',$1,$2,$5,$6,'human','audio','','operator-media',now()),
    ('transcribed-audio',$1,$2,$5,$6,'candidate','audio','Transcrição já disponível','transcribed-media',now())`,
   [channel.tenantId,channel.brandId,other.value.id,other.value.candidateId,job.conversation_id,job.candidate_id]);
  let requests=0;
  const engine=new Engine(store,testConfig,async url=>{requests++;assert.equal(String(url),testConfig.N8N_WEBHOOK_URL);return Response.json({accepted:true});});
  await engine.dispatch(channel,job);
  assert.equal(requests,1);
  assert.equal((await db.query('SELECT id FROM sdr.messages WHERE id=$1',[job.id+':capability'])).rows.length,0);
 }finally{await db.close();}
});

test('combined preflight isolates colliding message and conversation ids across tenants and brands',async()=>{
 const db=await testDatabase();
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const store=new Store(db),sessions=new LabSessions(db);
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Escopo isolado',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);
  const channel=await store.scopeForJob(sent.value.jobId!),job=await store.claim(channel);assert.ok(job);
  for(const [tenantId,brandId] of [['other-tenant',channel.brandId],[channel.tenantId,'other-brand']]) {
   await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2)',[tenantId,brandId]);
   await db.query(`INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state)
    SELECT id,$1,$2,contact_id,authorized_contact_id,label,lead_state||jsonb_build_object('tenantId',$1::text,'brandId',$2::text)
    FROM sdr.candidates WHERE tenant_id=$3 AND brand_id=$4 AND id=$5`,[tenantId,brandId,channel.tenantId,channel.brandId,job.candidate_id]);
   const phoneNumberId='other-'+tenantId+'-'+brandId;
   await db.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,kind) VALUES($1,$2,$3,'laboratory')",[phoneNumberId,tenantId,brandId]);
   await db.query('INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) VALUES($1,$2,$3,$4,$5)',[job.conversation_id,tenantId,brandId,job.candidate_id,phoneNumberId]);
   await db.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp)
    VALUES($1,$2,$3,$4,$5,'candidate','unsupported','',now()),('foreign-audio',$2,$3,$4,$5,'candidate','audio','',now())`,
    [job.trigger_message_id,tenantId,brandId,job.conversation_id,job.candidate_id]);
  }
  let requests=0;
  await new Engine(store,testConfig,async url=>{requests++;assert.equal(String(url),testConfig.N8N_WEBHOOK_URL);return Response.json({accepted:true});}).dispatch(channel,job);
  assert.equal(requests,1,'foreign unsupported triggers or audio must not intercept the local text turn');
 }finally{await db.close();}
});
