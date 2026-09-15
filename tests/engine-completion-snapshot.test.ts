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

test('laboratory completion uses the grouped snapshot in its existing commit and settles one reply once', async () => {
 const actual = await testDatabase(), statements:string[]=[];
 let transactions=0;
 const db:Database={
  query:async<T>(sql:string,params?:unknown[])=>{statements.push(sql);return actual.query<T>(sql,params);},
  transaction:fn=>{transactions++;return actual.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{statements.push(sql);return tx.query<T>(sql,params);}}));},
  close:()=>actual.close(),
 };
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'synthetic-tester',role:'tester'};
  const sessions=new LabSessions(db),store=new Store(db),engine=new Engine(store,testConfig,async()=>Response.json({accepted:true}));
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Fixture',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  await engine.dispatch(channel,job);
  const input={jobId:job.id,contextVersion:job.context_version,model:'gpt-5.4-2026-03-05',usage:{input_tokens:100,output_tokens:10,total_tokens:110},
   result:{bubbles:['Em qual cidade você pensa em abrir?'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}};
  statements.length=0;transactions=0;
  assert.deepEqual(await engine.complete(input),{accepted:true});
  assert.equal(statements.filter(sql=>sql.includes('locked_job AS MATERIALIZED')).length,1);
  assert.equal(statements.length,9,'four read round trips removed from the prior thirteen-query path');
  assert.equal(transactions,1);
  assert.deepEqual(await engine.complete(input),{accepted:false,reason:'STALE_RESULT'});
  assert.equal((await actual.query("SELECT id FROM sdr.messages WHERE actor='agent'")).rows.length,1);
  const reservation=(await actual.query<{detail:{settled:boolean;costMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(reservation.length,1);assert.equal(reservation[0].detail.settled,true);assert.equal(reservation[0].detail.costMicroUsd,400);
 } finally {await db.close();}
});
