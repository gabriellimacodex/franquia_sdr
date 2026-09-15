import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { initialSnapshot, seedPilot } from '../src/seed.js';
import { snapshotHash } from '../src/versioning.js';
import { LabSessions } from '../src/lab-sessions.js';
import { CampaignAdmissionSchema } from '../src/campaign-admission.spec.js';
import type { Database } from '../src/database.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { testConfig } from './config.js';
import { LaboratoryDispatch } from '../src/laboratory-dispatch.js';

const campaignConfig={...testConfig,LAB_BUDGET_GATE_ID:'sprint3-continuous-20260910',LAB_BUDGET_LIMIT_MICRO_USD:1000000};

const scope={tenantId:'cognita-homologacao',brandId:'sapore'};
async function fixture(){
 const db=await testDatabase(),sessions=new LabSessions(db),actor={...scope,userId:'synthetic-campaign-admin',role:'admin'};
 const {versionId}=await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic only'}],adminUserIds:[actor.userId]});
 const created=await sessions.create(actor,{requestId:randomUUID(),label:'Synthetic campaign',scenario:'free'});assert.ok(created.ok);
 const admission={runId:'offline-campaign',turnId:'offline-C01-R1-T1',target:{versionId,contentHash:snapshotHash(initialSnapshot(scope)),model:'gpt-5.4-2026-03-05'},maxReservationMicroUsd:100000,submitBeforeMs:Date.now()+60000};
 const input={requestId:randomUUID(),text:'Quero conhecer a franquia em Vila Aurora.',campaignAdmission:admission};
 return {db,sessions,actor,session:created.value,admission,input};
}

test('campaign admission requires an active real admin, not the caller role claim',async()=>{
 const f=await fixture();try{
  for(const membership of [{role:'tester',active:true},{role:'reviewer',active:true},{role:'admin',active:false}]){
   await f.db.query('UPDATE sdr.memberships SET role=$2,active=$3 WHERE user_id=$1',[f.actor.userId,membership.role,membership.active]);
   const result=await f.sessions.send(f.actor,f.session.id,f.input);
   assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'FORBIDDEN');
  }
  await f.db.query('DELETE FROM sdr.memberships WHERE user_id=$1',[f.actor.userId]);
  const missing=await f.sessions.send(f.actor,f.session.id,f.input);assert.equal(missing.ok,false);if(!missing.ok)assert.equal(missing.error.code,'FORBIDDEN');
  assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length,0);
  assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length,0);
 }finally{await f.db.close();}
});

test('SEND binds one immutable ceiling event and private marker to the created job in its transaction',async()=>{
 const f=await fixture();try{
  const result=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(result.ok);assert.ok(result.value.jobId);
  const events=(await f.db.query<{id:string,detail:Record<string,unknown>}>("SELECT id,detail FROM sdr.events WHERE type='lab_campaign_admitted'")).rows;
  assert.equal(events.length,1);
  const event=events[0],job=(await f.db.query<{context:{campaignAdmission:unknown},deadline:Date}>('SELECT context,deadline FROM sdr.jobs WHERE id=$1',[result.value.jobId])).rows[0];
  assert.equal(event.id,'lab-campaign:'+result.value.jobId);
  assert.deepEqual(event.detail,{...f.admission,kind:'campaign-admission-v1',...scope,actorUserId:f.actor.userId,sessionId:f.session.id,requestId:f.input.requestId,
   jobId:result.value.jobId,candidateId:f.session.candidateId,contextVersion:1,epoch:0,gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000});
  assert.deepEqual(job.context.campaignAdmission,{id:event.id,contentHash:createHash('sha256').update(JSON.stringify(CampaignAdmissionSchema.parse(event.detail))).digest('hex')});
  assert.ok(job.deadline instanceof Date);
  assert.equal('exactPayloadBound' in event.detail,false);assert.equal('deadlineAtMs' in event.detail,false);
  assert.equal(JSON.stringify(result).includes('maxReservationMicroUsd'),false);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
 }finally{await f.db.close();}
});

test('new admissions reject wrong pins, expired submission and non-laboratory channels before creating a message',async()=>{
 const f=await fixture();try{
  for(const admission of [{...f.admission,target:{...f.admission.target,versionId:'foreign-version'}},{...f.admission,target:{...f.admission.target,contentHash:'b'.repeat(64)}}]){
   const result=await f.sessions.send(f.actor,f.session.id,{...f.input,campaignAdmission:admission});assert.equal(result.ok,false);
   if(!result.ok)assert.equal(result.error.code,'CAMPAIGN_ADMISSION_INVALID');
  }
  const expired=await f.sessions.send(f.actor,f.session.id,{...f.input,campaignAdmission:{...f.admission,submitBeforeMs:0}});
  assert.equal(expired.ok,false);if(!expired.ok)assert.equal(expired.error.code,'CAMPAIGN_ADMISSION_EXPIRED');
  await f.db.query("UPDATE sdr.channels SET kind='whatsapp' WHERE kind='laboratory'");
  const channel=await f.sessions.send(f.actor,f.session.id,f.input);assert.equal(channel.ok,false);if(!channel.ok)assert.equal(channel.error.code,'CAMPAIGN_ADMISSION_INVALID');
  assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length,0);
  assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length,0);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_campaign_admitted'")).rows.length,0);
 }finally{await f.db.close();}
});

test('replay returns only the same immutable admission and cannot widen, replace, omit or retrofit a ceiling',async()=>{
 const f=await fixture();try{
  const first=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(first.ok);
  const before=(await f.db.query("SELECT * FROM sdr.events WHERE type='lab_campaign_admitted'")).rows;
  for(const admission of [{...f.admission,maxReservationMicroUsd:200000},{...f.admission,maxReservationMicroUsd:50000},{...f.admission,runId:'different-run'},
   {...f.admission,target:{...f.admission.target,contentHash:'b'.repeat(64)}},{...f.admission,submitBeforeMs:f.admission.submitBeforeMs+1000},undefined]){
   const replay=await f.sessions.send(f.actor,f.session.id,{...f.input,campaignAdmission:admission});assert.equal(replay.ok,false);if(!replay.ok)assert.equal(replay.error.code,'REQUEST_CONFLICT');
  }
  const same=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(same.ok);assert.equal(same.value.jobId,first.value.jobId);
  assert.deepEqual((await f.db.query("SELECT * FROM sdr.events WHERE type='lab_campaign_admitted'")).rows,before);
  const normalInput={requestId:randomUUID(),text:'Quero saber mais sobre a franquia.'};
  assert.ok((await f.sessions.send(f.actor,f.session.id,normalInput)).ok);
  const retrofit=await f.sessions.send(f.actor,f.session.id,{...normalInput,campaignAdmission:f.admission});assert.equal(retrofit.ok,false);if(!retrofit.ok)assert.equal(retrofit.error.code,'REQUEST_CONFLICT');
  assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length,2);
 }finally{await f.db.close();}
});

test('expiry at the final database write rolls back admission, job, inbound and memory revision together',async()=>{
 const f=await fixture();try{
  // Simulate a check made before expiry; the INSERT must independently use the DB wall clock.
  const delayed:Database={...f.db,transaction:fn=>f.db.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{
   const result=await tx.query<T>(sql,params);
   if(sql.includes('AS checked_at'))(result.rows[0] as Record<string,unknown>).checked_at=new Date(0);
   return result;
  }}))};
  const expired=await new LabSessions(delayed).send(f.actor,f.session.id,{...f.input,campaignAdmission:{...f.admission,submitBeforeMs:1}});
  assert.equal(expired.ok,false);if(!expired.ok)assert.equal(expired.error.code,'CAMPAIGN_ADMISSION_EXPIRED');
  assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length,0);
  assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length,0);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_campaign_admitted'")).rows.length,0);
  assert.equal((await f.db.query<{revision:number}>('SELECT revision FROM sdr.candidates WHERE id=$1',[f.session.candidateId])).rows[0].revision,0);
 }finally{await f.db.close();}
});

test('the measured reservation must fit the admitted ceiling before any reservation or POST',async()=>{
 const f=await fixture();try{
  const sent=await f.sessions.send(f.actor,f.session.id,{...f.input,campaignAdmission:{...f.admission,maxReservationMicroUsd:1}});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const store=new Store(f.db),channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  let calls=0;
  await new Engine(store,campaignConfig,async()=>{calls++;return Response.json({accepted:true});}).dispatch(channel,job);
  assert.equal(calls,0);
  const after=(await store.getJob(job.id)).job;
  assert.equal(after.state,'handoff');assert.equal(after.error_code,'CAMPAIGN_CEILING_EXCEEDED');
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_campaign_admitted'")).rows.length,1);
  const detail=await f.sessions.detail(f.actor,f.session.id);assert.ok(detail.ok);assert.equal(detail.value.session.state,'human');
  assert.match(String(detail.value.messages.at(-1)?.text),/limite.*turno/i);
 }finally{await f.db.close();}
});

test('a new request ID cannot admit the same campaign turn twice or replace its ceiling',async()=>{
 const f=await fixture();try{
  const first=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(first.ok);
  const second=await f.sessions.send(f.actor,f.session.id,{...f.input,requestId:randomUUID(),campaignAdmission:{...f.admission,maxReservationMicroUsd:200000}});
  assert.equal(second.ok,false);if(!second.ok)assert.equal(second.error.code,'REQUEST_CONFLICT');
  assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length,1);
  assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length,1);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_campaign_admitted'")).rows.length,1);
 }finally{await f.db.close();}
});

test('admission evidence must belong to the same conversation before the model POST',async()=>{
 const f=await fixture();try{
  const sent=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const other=await f.sessions.create(f.actor,{requestId:randomUUID(),label:'Other synthetic session',scenario:'free'});assert.ok(other.ok);
  await f.db.query("UPDATE sdr.events SET conversation_id=$1 WHERE type='lab_campaign_admitted'",[other.value.id]);
  const store=new Store(f.db),channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  let calls=0;await new Engine(store,campaignConfig,async()=>{calls++;return Response.json({accepted:true});}).dispatch(channel,job);
  assert.equal(calls,0);assert.equal((await store.getJob(job.id)).job.error_code,'CAMPAIGN_ADMISSION_INVALID');
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
 }finally{await f.db.close();}
});

test('missing, corrupt or revoked campaign evidence fails closed without becoming a normal job',async()=>{
 const corruptions=[
  "DELETE FROM sdr.events WHERE type='lab_campaign_admitted'",
  "UPDATE sdr.jobs SET context=context-'campaignAdmission'",
  "UPDATE sdr.jobs SET context=jsonb_set(context,'{campaignAdmission,contentHash}','\"invalid\"')",
  "UPDATE sdr.events SET detail=jsonb_set(detail,'{maxReservationMicroUsd}','1000000') WHERE type='lab_campaign_admitted'",
  "UPDATE sdr.events SET created_at=created_at+interval '1 day' WHERE type='lab_campaign_admitted'",
  "UPDATE sdr.memberships SET active=false WHERE role='admin'",
  "UPDATE sdr.memberships SET role='tester' WHERE role='admin'",
  "UPDATE sdr.lab_sessions SET owner_user_id='another-actor'",
  'changed-gate','changed-cap',
 ];
 for(const corruption of corruptions){
  const f=await fixture();try{
   const sent=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(sent.ok);assert.ok(sent.value.jobId);
   if(!corruption.startsWith('changed-'))await f.db.query(corruption);
   const config={...campaignConfig,...(corruption==='changed-gate'?{LAB_BUDGET_GATE_ID:'another-gate'}:{}),...(corruption==='changed-cap'?{LAB_BUDGET_LIMIT_MICRO_USD:2000000}:{})};
   const store=new Store(f.db),channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
   let calls=0;await new Engine(store,config,async()=>{calls++;return Response.json({accepted:true});}).dispatch(channel,job);
   assert.equal(calls,0,corruption);assert.equal((await store.getJob(job.id)).job.error_code,'CAMPAIGN_ADMISSION_INVALID',corruption);
   assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0,corruption);
  }finally{await f.db.close();}
 }
});

test('a valid admission stays private through dispatch, callback and replay while the exact reservation is recorded',async()=>{
 const f=await fixture();try{
  const sent=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const before=(await f.db.query<{context:unknown}>('SELECT context FROM sdr.jobs WHERE id=$1',[sent.value.jobId])).rows[0].context;
  const store=new Store(f.db),channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  const bodies:string[]=[];const engine=new Engine(store,campaignConfig,async(_url,init)=>{bodies.push(String(init?.body));return Response.json({accepted:true});});
  await engine.dispatch(channel,job);assert.equal(bodies.length,1);
  const ledger=(await f.db.query<{detail:{inputTokenBound:number,reservedMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0].detail;
  assert.equal(ledger.inputTokenBound,Buffer.byteLength(bodies[0],'utf8')+4096);
  assert.equal(ledger.reservedMicroUsd,Math.ceil(ledger.inputTokenBound*2.5+1200*15));assert.ok(ledger.reservedMicroUsd<=f.admission.maxReservationMicroUsd);
  for(const hidden of ['campaignAdmission','maxReservationMicroUsd',f.admission.runId,f.admission.turnId,f.actor.userId])assert.equal(bodies[0].includes(hidden),false,hidden);
  const result={bubbles:['Em qual cidade você considera abrir a franquia?'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
  assert.equal((await engine.complete({jobId:job.id,contextVersion:job.context_version,model:f.admission.target.model,configVersion:job.version_id,result,usage:{input_tokens:100,output_tokens:10}})).accepted,true);
  const stored=(await f.db.query<{context:{campaignAdmission:unknown},state:string}>('SELECT context,state FROM sdr.jobs WHERE id=$1',[job.id])).rows[0];
  assert.equal(stored.state,'completed');assert.deepEqual(stored.context.campaignAdmission,(before as {campaignAdmission:unknown}).campaignAdmission);
  const replay=await f.sessions.send(f.actor,f.session.id,f.input);assert.ok(replay.ok);assert.equal(replay.value.jobId,job.id);
  assert.equal(JSON.stringify(replay.value).includes('campaignAdmission'),false);
  await engine.dispatch(channel,job);assert.equal(bodies.length,1);
 }finally{await f.db.close();}
});

test('submission expiry does not shorten an already admitted job deadline',async()=>{
 const f=await fixture();try{
  const input={...f.input,campaignAdmission:{...f.admission,submitBeforeMs:Date.now()+5000}};
  const sent=await f.sessions.send(f.actor,f.session.id,input);assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const store=new Store(f.db),channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  const now=new Date(input.campaignAdmission.submitBeforeMs+1);assert.ok(now<job.deadline);
  const result=await new LaboratoryDispatch(f.db,channel,campaignConfig,()=>now).execute({jobId:job.id,attempt:job.attempts,contextVersion:job.context_version,epoch:job.epoch,versionId:job.version_id});
  assert.ok(result.success);assert.equal(result.data.kind,'ready');
  assert.equal((await store.getJob(job.id)).job.deadline.getTime(),job.deadline.getTime());
 }finally{await f.db.close();}
});

test('failure after admission INSERT rolls back the marker, inbound and job, without exposing an accepted receipt',async()=>{
 const f=await fixture();try{
  const failing:Database={...f.db,transaction:fn=>f.db.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{
   const result=await tx.query<T>(sql,params);if(sql.startsWith('INSERT INTO sdr.events')&&sql.includes('lab_campaign_admitted'))throw new Error('synthetic storage failure');return result;
  }}))};
  const result=await new LabSessions(failing).send(f.actor,f.session.id,f.input);assert.equal(result.ok,false);
  assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length,0);
  assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length,0);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_campaign_admitted'")).rows.length,0);
 }finally{await f.db.close();}
});

test('normal tester messages and free stop/replay keep their existing behavior without budget reservations',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE sdr.memberships SET role='tester' WHERE user_id=$1",[f.actor.userId]);
  const normal=await f.sessions.send({...f.actor,role:'tester'},f.session.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(normal.ok);assert.ok(normal.value.jobId);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_campaign_admitted'")).rows.length,0);
  await f.db.query("UPDATE sdr.memberships SET role='admin' WHERE user_id=$1",[f.actor.userId]);
  const input={...f.input,text:'Pare.'};
  const stop=await f.sessions.send(f.actor,f.session.id,input);assert.ok(stop.ok);assert.equal(stop.value.jobId,null);assert.equal(stop.value.detail.session.state,'stopped');
  const replay=await f.sessions.send(f.actor,f.session.id,input);assert.ok(replay.ok);assert.equal(replay.value.jobId,null);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type IN ('lab_campaign_admitted','lab_model_budget_reserved')")).rows.length,0);
 }finally{await f.db.close();}
});
