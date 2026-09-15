import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/database.js';
import { LabSessions } from '../src/lab-sessions.js';
import { seedPilot } from '../src/seed.js';
import { testDatabase } from './db-helper.js';

test('send returns the public greeting snapshot using one extra query in the same transaction',async()=>{
 const actual=await testDatabase(),queries:string[]=[];
 let transactions=0;
 const db:Database={...actual,transaction:fn=>{
  transactions++;
  return actual.transaction(tx=>fn({query:(sql,params)=>{queries.push(sql);return tx.query(sql,params);}}));
 }};
 const sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Snapshot imediato',scenario:'free'});assert.ok(created.ok);
  transactions=0;queries.length=0;
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'oi'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const value=sent.value;
  assert.ok(value.detail,'send must include the persisted public snapshot');
  assert.equal(transactions,1);
  assert.equal(queries.length,11,'ten original greeting queries plus one owned snapshot read');
  assert.equal(value.detail.session.id,created.value.id);
  assert.equal(value.detail.session.state,'automatic');
  assert.deepEqual(value.detail.messages.map(message=>message.actor),['candidate','agent']);
  assert.equal(value.detail.messages[0].text,'oi');
  assert.ok(value.detail.job);
  assert.equal(value.detail.job.id,value.jobId);
  assert.equal(value.detail.job.state,'completed');
  assert.deepEqual(Object.keys(value.detail.job).sort(),['deadline','errorCode','id','state']);
  assert.equal(JSON.stringify(value).includes('deterministic_greeting'),false);
  const standalone=await sessions.detail(user,created.value.id);assert.ok(standalone.ok);
  assert.deepEqual(value.detail,standalone.value);
 }finally{await db.close();}
});

test('a failed snapshot read rolls back the send and a retry can commit it once',async()=>{
 const actual=await testDatabase();
 let failSnapshot=false;
 const db:Database={...actual,transaction:fn=>actual.transaction(tx=>fn({query:async(sql,params)=>{
  if(failSnapshot&&sql.includes('jsonb_agg'))throw new Error('synthetic snapshot failure');
  return tx.query(sql,params);
 }}))};
 const sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Envio atômico',scenario:'free'});assert.ok(created.ok);
  const request={requestId:randomUUID(),text:'oi'};
  failSnapshot=true;
  const failed=await sessions.send(user,created.value.id,request);assert.equal(failed.ok,false);
  if(!failed.ok)assert.equal(failed.error.code,'UPSTREAM_UNAVAILABLE');
  assert.equal((await actual.query('SELECT id FROM sdr.messages WHERE conversation_id=$1',[created.value.id])).rows.length,0);
  assert.equal((await actual.query('SELECT id FROM sdr.jobs WHERE conversation_id=$1',[created.value.id])).rows.length,0);
  assert.equal((await actual.query<{revision:number}>('SELECT revision FROM sdr.candidates WHERE id=$1',[created.value.candidateId])).rows[0].revision,0);
  failSnapshot=false;
  const retried=await sessions.send(user,created.value.id,request);assert.ok(retried.ok);
  assert.equal(retried.value.detail.messages.length,2);
  assert.equal(retried.value.detail.job?.state,'completed');
  assert.equal((await actual.query('SELECT id FROM sdr.jobs WHERE conversation_id=$1',[created.value.id])).rows.length,1);
 }finally{await db.close();}
});

test('send snapshots keep ownership, scope, request conflicts and invalid-input failures closed',async()=>{
 const db=await testDatabase(),sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Snapshot privado',scenario:'free'});assert.ok(created.ok);
  const request={requestId:randomUUID(),text:'oi'};
  const sent=await sessions.send(user,created.value.id,request);assert.ok(sent.ok);
  const unchanged=await sessions.detail(user,created.value.id);assert.ok(unchanged.ok);
  for(const denied of [{...user,userId:'other-tester'},{...user,tenantId:'other-tenant'},{...user,brandId:'other-brand'}]) {
   const result=await sessions.send(denied,created.value.id,request);assert.equal(result.ok,false);
   if(!result.ok)assert.equal(result.error.code,'SESSION_NOT_FOUND');
   assert.equal('value' in result,false);
  }
  for(const [input,code] of [[{...request,text:'Outro texto'},'REQUEST_CONFLICT'],[{requestId:randomUUID(),text:'   '},'INVALID_CONTRACT']] as const) {
   const result=await sessions.send(user,created.value.id,input);assert.equal(result.ok,false);
   if(!result.ok)assert.equal(result.error.code,code);
   assert.equal('value' in result,false);
  }
  const after=await sessions.detail(user,created.value.id);assert.ok(after.ok);assert.deepEqual(after.value,unchanged.value);
  assert.equal((await db.query('SELECT id FROM sdr.jobs WHERE conversation_id=$1',[created.value.id])).rows.length,1);
 }finally{await db.close();}
});

test('control sends return the persisted paused snapshot and replay cannot duplicate control side effects',async()=>{
 const db=await testDatabase(),sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  for(const [text,state] of [['Quero falar com um humano','human'],['Pare','stopped']]) {
   const created=await sessions.create(user,{requestId:randomUUID(),label:'Controle prioritário',scenario:'human'});assert.ok(created.ok);
   const pending=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(pending.ok);
   const request={requestId:randomUUID(),text};
   const sent=await sessions.send(user,created.value.id,request);assert.ok(sent.ok);
   assert.equal(sent.value.jobId,null);
   assert.equal(sent.value.detail.session.state,state);
   assert.equal(sent.value.detail.job?.id,pending.value.jobId);
   assert.equal(sent.value.detail.job?.state,'stale');
   assert.deepEqual(sent.value.detail.messages.map(message=>message.text),['Quero conhecer a franquia.',text]);
   const replay=await sessions.send(user,created.value.id,request);assert.ok(replay.ok);
   assert.deepEqual(replay.value,sent.value);
   assert.equal((await db.query('SELECT id FROM sdr.jobs WHERE conversation_id=$1',[created.value.id])).rows.length,1);
   assert.equal((await db.query('SELECT id FROM sdr.events WHERE conversation_id=$1',[created.value.id])).rows.length,1);
   assert.equal((await db.query('SELECT id FROM sdr.briefings WHERE conversation_id=$1',[created.value.id])).rows.length,1);
   const blocked=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'oi'});assert.equal(blocked.ok,false);
   if(!blocked.ok)assert.equal(blocked.error.code,'SESSION_PAUSED');
  }
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
 }finally{await db.close();}
});

test('replaying a send preserves its job id and returns current history without duplicating messages',async()=>{
 const db=await testDatabase(),sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Replay com histórico atual',scenario:'free'});assert.ok(created.ok);
  const original={requestId:randomUUID(),text:'oi'};
  const first=await sessions.send(user,created.value.id,original);assert.ok(first.ok);
  const followup=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Campinas, quero operar pessoalmente.'});assert.ok(followup.ok);
  assert.equal(followup.value.detail.job?.state,'pending');
  assert.deepEqual(followup.value.detail.messages.map(message=>message.actor),['candidate','agent','candidate']);
  await db.query('UPDATE sdr.jobs SET context=$1 WHERE id=$2',[JSON.stringify({instructions:'private-system-prompt',guardReview:{bubbles:['private-rejected-bubble']}}),followup.value.jobId]);
  const before=(await db.query('SELECT revision,lead_state FROM sdr.candidates WHERE id=$1',[created.value.candidateId])).rows;
  const replay=await sessions.send(user,created.value.id,original);assert.ok(replay.ok);
  assert.equal(replay.value.jobId,first.value.jobId);
  assert.equal(replay.value.detail.job?.id,followup.value.jobId,'snapshot is current even when replaying an older send');
  assert.deepEqual(replay.value.detail,followup.value.detail);
  assert.deepEqual((await db.query('SELECT revision,lead_state FROM sdr.candidates WHERE id=$1',[created.value.candidateId])).rows,before);
  assert.equal((await db.query('SELECT id FROM sdr.jobs WHERE conversation_id=$1',[created.value.id])).rows.length,2);
  assert.equal((await db.query('SELECT id FROM sdr.messages WHERE conversation_id=$1',[created.value.id])).rows.length,3);
  for(const hidden of ['context','instructions','guardReview','private-system-prompt','private-rejected-bubble'])assert.equal(JSON.stringify(replay.value).includes(hidden),false);
 }finally{await db.close();}
});
