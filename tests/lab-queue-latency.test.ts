import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { seedPilot } from '../src/seed.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Store } from '../src/store.js';
import { TurnInputSchema } from '../src/contracts.js';
import type { Database } from '../src/database.js';

test('explicit laboratory sends are immediately eligible while WhatsApp retains its debounce',async()=>{
 const db=await testDatabase(),lab=new LabSessions(db),store=new Store(db);
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
  const created=await lab.create(user,{requestId:randomUUID(),label:'Fila imediata',scenario:'free'});assert.ok(created.ok);
  const sent=await lab.send(user,created.value.id,{requestId:randomUUID(),text:'Olá, quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const timing=(await db.query<{delay_ms:number,deadline_ms:number}>('SELECT extract(epoch from available_at-created_at)*1000 AS delay_ms,extract(epoch from deadline-created_at)*1000 AS deadline_ms FROM sdr.jobs WHERE id=$1',[sent.value.jobId])).rows[0];
  assert.equal(Number(timing.delay_ms),0);
  assert.equal(Number(timing.deadline_ms),60000);
  const job=await store.claim(await store.scopeForJob(sent.value.jobId));assert.equal(job?.id,sent.value.jobId);
  const whatsapp=await store.startTurn(TurnInputSchema.parse({phoneNumberId:'1093705843816293',conversationId:'debounce-stays',contactId:'5511999999999',messageId:'wa-message',text:'Olá.',executionId:'wa-execution',controlFingerprint:'wa-initial'}));
  const waTiming=(await db.query<{delay_ms:number}>('SELECT extract(epoch from available_at-created_at)*1000 AS delay_ms FROM sdr.jobs WHERE id=$1',[whatsapp.id])).rows[0];
  assert.equal(Number(waTiming.delay_ms),2000);
 } finally {await db.close();}
});

test('laboratory polling reads owned history and public job fields in one domain query',async()=>{
 const db=await testDatabase(),queries:string[]=[];
 const observed:Database={...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,params)=>{queries.push(sql);return tx.query(sql,params);}}))};
 const lab=new LabSessions(observed);
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
  const created=await lab.create(user,{requestId:randomUUID(),label:'Consulta rápida',scenario:'free'});assert.ok(created.ok);
  const sent=await lab.send(user,created.value.id,{requestId:randomUUID(),text:'Olá.'});assert.ok(sent.ok);
  queries.length=0;
  const detail=await lab.detail(user,created.value.id);assert.ok(detail.ok);
  assert.equal(queries.filter(sql=>/FROM sdr\./.test(sql)).length,1);
  assert.equal(detail.value.session.id,created.value.id);
  assert.equal(detail.value.messages[0].text,'Olá.');
  assert.equal(detail.value.job?.id,sent.value.jobId);
  assert.deepEqual(Object.keys(detail.value.job!).sort(),['deadline','errorCode','id','state']);
  const other=await lab.detail({...user,userId:'other-tester'},created.value.id);
  assert.equal(other.ok,false);if(!other.ok)assert.equal(other.error.code,'SESSION_NOT_FOUND');
 } finally {await db.close();}
});
