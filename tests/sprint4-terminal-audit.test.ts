import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { Engine } from '../src/engine.js';
import { DispatchFailure } from '../src/dispatch-failure.js';
import { seedPilot, initialSnapshot } from '../src/seed.js';
import { Versioning } from '../src/versioning.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { testConfig } from './config.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { ControllerStateSchema, LegacyControllerStateSchema } from '../evaluations/sprint4-controller.spec.js';
import { Sprint4TerminalAudit } from '../evaluations/sprint4-terminal-audit.js';
import { TerminalAuditResultSchema } from '../evaluations/sprint4-terminal-audit.spec.js';
import { CampaignAdmissionSchema } from '../src/campaign-admission.spec.js';
import { Sprint4EvidenceCapture } from '../evaluations/sprint4-evidence.js';
import { Sprint4EvidenceStorage } from '../evaluations/sprint4-evidence-storage.js';
import { Sprint4Controller } from '../evaluations/sprint4-controller.js';
import { Sprint4ReviewPacket } from '../evaluations/sprint4-review-packet.js';

const scope={tenantId:'cognita-homologacao',brandId:'sapore'},actor={...scope,userId:'synthetic-admin',role:'admin'};
async function fixture(options:{recoverBeforeReservation?:boolean;admission?:boolean}={}){
 const pg=new PGlite({extensions:{vector}});
 for(const migration of ['001_sdr.sql','002_versions.sql','003_lab_sessions.sql'])await pg.exec(await readFile(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 const db:Database={query:(sql,params)=>pg.query(sql,params),transaction:fn=>pg.transaction(tx=>fn(tx as Queryable)),close:()=>pg.close()};
 await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}],adminUserIds:[actor.userId]});
 const saved=await new Versioning(db).saveDraft(scope,initialSnapshot(scope),actor.userId);assert.ok(saved.ok);
 const planned=new Sprint4CampaignPlanner().execute({runId:'audit-fixture',actorUserId:actor.userId,target:{versionId:saved.value.versionId,contentHash:saved.value.contentHash,model:'gpt-5.4-2026-03-05'}});assert.ok(planned.success);
 const plan=planned.data,turn=plan.phases[0].executions[0].turns[0],sessions=new LabSessions(db),store=new Store(db);
 const session=await sessions.createEvaluation(actor,{requestId:randomUUID(),label:'Synthetic audit',scenario:'free',versionId:plan.request.target.versionId,contentHash:plan.request.target.contentHash});assert.ok(session.ok);
 const requestId=randomUUID(),admittedAt=Date.now();
 const v2State=options.admission?ControllerStateSchema.parse({protocol:'sprint4-admission-v2',revision:1,plan,entries:[{turnId:turn.id,receipts:[],admission:{
  turnId:turn.id,actorUserId:actor.userId,target:plan.request.target,evidenceRef:'synthetic-before-send',observedAtMs:admittedAt,validUntilMs:admittedAt+60000,
  adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,...scope,executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,
  sessionId:session.value.id,sessionOwned:true,sessionReady:true,sessionFresh:true,requestId,
  budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1_000_000,accountedMicroUsd:0,maxReservationMicroUsd:200000,remainingCampaignReviewed:true},
  daily:{actorUserId:actor.userId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}}}]}):null;
 const campaignAdmission=v2State?{runId:plan.request.runId,turnId:turn.id,target:plan.request.target,maxReservationMicroUsd:v2State.entries[0].admission.budget.maxReservationMicroUsd,submitBeforeMs:v2State.entries[0].admission.validUntilMs}:undefined;
 const sent=await sessions.send(actor,session.value.id,{requestId,text:turn.input,...(campaignAdmission?{campaignAdmission}:{})});assert.ok(sent.ok);assert.ok(sent.value.jobId);
 const channel=await store.scopeForJob(sent.value.jobId);let job=await store.claim(channel);assert.ok(job);
 if(options.recoverBeforeReservation){
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
  const recovered=await new DispatchFailure(db,channel).execute({jobId:job.id,attempt:job.attempts});assert.ok(recovered.success);
  // Advance only this synthetic fixture's backoff; the recovery and next claim use real services.
  await db.query("UPDATE sdr.jobs SET available_at=now()-interval '1 second' WHERE id=$1",[job.id]);
  job=await store.claim(channel);assert.ok(job);assert.equal(job.attempts,2);
 }
 const engine=new Engine(store,{...testConfig,LAB_BUDGET_GATE_ID:'sprint3-continuous-20260910',LAB_BUDGET_LIMIT_MICRO_USD:1_000_000},async()=>Response.json({accepted:true}));
 await engine.dispatch(channel,job);
 const reservation=(await db.query<{detail:{inputTokenBound:number,reservedMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0].detail;
 const result={bubbles:['Você vai administrar a loja, e Caio participa da decisão.','O que motivou seu interesse na franquia?'],proposals:[{field:'city',value:{kind:'text',text:'Vila Aurora'},evidence:{messageId:job.trigger_message_id,quote:turn.input},attribution:'candidate',capitalOrigin:null,relationId:null,replacesFactId:null}],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
 const complete=()=>engine.complete({jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:plan.request.target.model,usage:{input_tokens:100,output_tokens:10,total_tokens:110},result});
 const now=Date.now();
 const state=LegacyControllerStateSchema.parse({revision:1,plan,entries:[{turnId:turn.id,receipts:[],preflight:{turnId:turn.id,actorUserId:actor.userId,target:plan.request.target,evidenceRef:'synthetic-only',observedAtMs:now-1000,validUntilMs:now+1000,deadlineAtMs:now+60000,
  adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,...scope,executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,
  sessionId:session.value.id,sessionOwned:true,sessionReady:true,sessionFresh:true,requestId,
  budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1_000_000,accountedMicroUsd:0,exactPayloadBound:reservation.inputTokenBound,reservationMicroUsd:reservation.reservedMicroUsd,remainingCampaignReviewed:true},
  daily:{actorUserId:actor.userId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}}}]});
 const journal:{read:()=>Promise<unknown>}={read:async()=>structuredClone(v2State??state)},queries:string[]=[];
 const audit=(readOnly=true,tenantId=scope.tenantId,turnId=turn.id)=>db.transaction(async tx=>{
  if(readOnly)await tx.query('SET TRANSACTION READ ONLY');
  await tx.query("SELECT set_config('sdr.tenant_id',$1,true),set_config('sdr.brand_id',$2,true)",[tenantId,scope.brandId]);
  return new Sprint4TerminalAudit({query:(sql,params)=>{queries.push(sql);return tx.query(sql,params);}},journal).execute({runId:plan.request.runId,turnId});
 });
 return {db,state,v2State,plan,turn,job,result,session:session.value,complete,audit,queries,journal,sessions};
}

test('v2 terminal observation reports measured preparation below the admission ceiling, never a future preflight',async()=>{
 const f=await fixture({admission:true});try{
  assert.ok(f.v2State);await f.complete();
  const observed=await f.audit();assert.ok(observed.success,JSON.stringify(observed));
  assert.equal(TerminalAuditResultSchema.safeParse(observed).success,true);
  assert.ok('protocol' in observed.data);assert.equal(observed.data.protocol,'sprint4-admission-v2');
  assert.ok('preparation' in observed.data);assert.deepEqual(observed.data.preparation,{attempt:f.job.attempts,inputTokenBound:observed.data.ledger.detail.inputTokenBound,reservedMicroUsd:observed.data.ledger.detail.reservedMicroUsd,reservationId:observed.data.ledger.id});
  assert.ok(observed.data.ledger.detail.reservedMicroUsd<f.v2State.entries[0].admission.budget.maxReservationMicroUsd);
  assert.ok('jobDeadlineAtMs' in observed.data);assert.equal(observed.data.jobDeadlineAtMs,new Date(observed.data.job.deadline).getTime());
  assert.equal(observed.data.objectiveAudit,'pending');assert.equal(observed.data.humanReview,'pending');
  assert.equal(f.queries.length,1);assert.doesNotMatch(f.queries[0],/\b(?:INSERT|UPDATE|DELETE|SET|pg_advisory)\b/);
  for(const hidden of ['"context"','"prompt"','"instructions"','"backendTimings"','"guardReview"','"exactPayloadBound"'])assert.equal(JSON.stringify(observed).includes(hidden),false);
 }finally{await f.db.close();}
});

test('terminal evidence survives a real database memory advance and SQLite reopen without approving T2',async()=>{
 const f=await fixture({admission:true}),directory=await mkdtemp(join(tmpdir(),'s4-terminal-evidence-'));
 let archive=new Sprint4EvidenceStorage({directory,initializeNew:true}),audits=0;
 try{
  await f.complete();
  const audit={async execute(){audits++;return f.audit();}};
  const captured=await new Sprint4EvidenceCapture({journal:f.journal,audit,storage:archive}).execute({plan:f.plan,turnId:f.turn.id});
  assert.ok(captured.success,JSON.stringify(captured));assert.equal(captured.data.source,'captured');
  assert.deepEqual(captured.data.artifact.payload.observation.response.map(m=>m.text),f.result.bubbles);
  assert.equal(audits,1);assert.ok((await archive.execute({action:'close'})).success);
  await f.db.query('UPDATE sdr.candidates SET revision=revision+1 WHERE id=$1',[f.session.candidateId]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'MEMORY_ADVANCED'}});
  archive=new Sprint4EvidenceStorage({directory});
  const resumed=await new Sprint4EvidenceCapture({journal:f.journal,audit,storage:archive}).execute({plan:f.plan,turnId:f.turn.id});
  assert.ok(resumed.success,JSON.stringify(resumed));assert.equal(resumed.data.source,'archive');
  assert.deepEqual(resumed.data.artifact,captured.data.artifact);assert.equal(audits,1);
  const packet=await new Sprint4ReviewPacket(archive).execute({plan:f.plan,turnId:f.turn.id});
  assert.ok(packet.success,JSON.stringify(packet));assert.deepEqual(packet.data.artifacts,[captured.data.artifact]);
  assert.equal(packet.data.readyForReceipt,false);assert.equal(packet.data.humanReview.scores,null);
  assert.equal(packet.data.checks.find(c=>c.id==='O2')!.status,'pending-human');
  const controller=new Sprint4Controller({...f.journal,async compareAndSwap(){throw new Error('No receipt or dispatch expected');}},
   {nowMs:()=>Date.now(),async inspect(){throw new Error('No new admission expected');}});
  assert.deepEqual(await controller.execute({action:'next',plan:f.plan}),{success:true,data:{kind:'awaiting-receipt',turnId:f.turn.id}});
  assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length,1);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,1);
  assert.equal((await f.db.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
 }finally{await archive.execute({action:'close'});await f.db.close();await rm(directory,{recursive:true,force:true});}
});

test('terminal observation binds a recorded intent to real private rows without approving the campaign',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.complete(),{accepted:true});
  const observed=await f.audit();assert.ok(observed.success);assert.equal(TerminalAuditResultSchema.safeParse(observed).success,true);
  assert.equal(observed.data.binding.jobId,f.job.id);assert.equal(observed.data.binding.requestId,f.state.entries[0].preflight.requestId);
  assert.deepEqual(observed.data.response.map(message=>message.text),f.result.bubbles);assert.equal(observed.data.guard.detail.guardPassed,true);
  assert.equal(observed.data.memory.lead.facts[0].field,'city');assert.deepEqual(observed.data.memory.facts,observed.data.memory.lead.facts);
  assert.equal(observed.data.ledger.detail.settled,true);assert.equal(observed.data.ledger.detail.costMicroUsd,400);
  assert.equal(observed.data.objectiveAudit,'pending');assert.equal(observed.data.humanReview,'pending');
  assert.equal(f.queries.length,1);assert.match(f.queries[0],/^WITH /);assert.doesNotMatch(f.queries[0],/\b(?:INSERT|UPDATE|DELETE|SET|pg_advisory)\b/);
  const visible=JSON.stringify(observed);for(const hidden of ['"snapshot"','"context"','"prompt"','"instructions"','"backendTimings"','"guardReview"'])assert.equal(visible.includes(hidden),false);
 }finally{await f.db.close();}
});

test('v2 requires the real admission event even when the journal and paid result look valid',async()=>{
 const f=await fixture({admission:true});try{
  await f.complete();await f.db.query("DELETE FROM sdr.events WHERE type='lab_campaign_admitted'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
 }finally{await f.db.close();}
});

test('v2 verifies the private admission marker hash against the canonical event',async()=>{
 const f=await fixture({admission:true});try{
  await f.complete();await f.db.query("UPDATE sdr.jobs SET context=jsonb_set(context,'{campaignAdmission,contentHash}',$2::jsonb) WHERE id=$1",[f.job.id,JSON.stringify('a'.repeat(64))]);
  const result=await f.audit();assert.equal(result.success,false);assert.deepEqual(result,{success:false,error:{code:'BINDING_MISMATCH'}});
 }finally{await f.db.close();}
});

test('v2 binds every canonical admission field to its journal, session and job even with a recomputed marker',async()=>{
 const f=await fixture({admission:true});try{
  await f.complete();
  const original=CampaignAdmissionSchema.parse((await f.db.query<{detail:unknown}>("SELECT detail FROM sdr.events WHERE type='lab_campaign_admitted'")).rows[0].detail);
  const variants=[{actorUserId:'another-admin'},{runId:'another-run'},{turnId:'another-turn'},{sessionId:'another-session'},
   {requestId:randomUUID()},{jobId:'another-job'},{candidateId:'another-candidate'},{contextVersion:2},{epoch:1},
   {maxReservationMicroUsd:original.maxReservationMicroUsd+1},{submitBeforeMs:original.submitBeforeMs+1},
   {target:{...original.target,versionId:'other-version'}},{target:{...original.target,contentHash:'b'.repeat(64)}}];
  for(const variant of variants){
   const changed=CampaignAdmissionSchema.parse({...original,...variant});
   await f.db.query("UPDATE sdr.events SET detail=$2 WHERE id=$1",['lab-campaign:'+f.job.id,JSON.stringify(changed)]);
   await f.db.query("UPDATE sdr.jobs SET context=jsonb_set(context,'{campaignAdmission,contentHash}',$2::jsonb) WHERE id=$1",[f.job.id,JSON.stringify(createHash('sha256').update(JSON.stringify(changed)).digest('hex'))]);
   const result=await f.audit();assert.equal(result.success,false,JSON.stringify(variant));assert.deepEqual(result,{success:false,error:{code:'BINDING_MISMATCH'}});
  }
 }finally{await f.db.close();}
});

test('v2 detects the same run and turn admitted to another job, not just duplicate current-job IDs',async()=>{
 const f=await fixture({admission:true});try{
  await f.complete();
  await f.db.query("INSERT INTO sdr.events SELECT 'lab-campaign:other-job',tenant_id,brand_id,conversation_id,type,jsonb_set(detail,'{jobId}','\"other-job\"'),created_at FROM sdr.events WHERE type='lab_campaign_admitted'");
  const result=await f.audit();assert.equal(result.success,false);assert.deepEqual(result,{success:false,error:{code:'BINDING_MISMATCH'}});
 }finally{await f.db.close();}
});

test('an admitted job cannot be downgraded to legacy even if either private witness is removed',async()=>{
 const f=await fixture({admission:true});try{
  await f.complete();f.journal.read=async()=>structuredClone(f.state);
  const both=await f.audit();assert.equal(both.success,false);assert.deepEqual(both,{success:false,error:{code:'BINDING_MISMATCH'}});
  const context=(await f.db.query<{context:unknown}>('SELECT context FROM sdr.jobs WHERE id=$1',[f.job.id])).rows[0].context;
  await f.db.query("UPDATE sdr.jobs SET context=context-'campaignAdmission' WHERE id=$1",[f.job.id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
  await f.db.query('UPDATE sdr.jobs SET context=$2 WHERE id=$1',[f.job.id,JSON.stringify(context)]);
  await f.db.query("DELETE FROM sdr.events WHERE type='lab_campaign_admitted'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
 }finally{await f.db.close();}
});

test('v2 admission expires submission at the event boundary, not later preparation or audit',async()=>{
 const f=await fixture({admission:true});try{
  assert.ok(f.v2State);await f.complete();const intent=f.v2State.entries[0].admission;
  const original=(await f.db.query<{detail:unknown,created_at:Date}>("SELECT detail,created_at FROM sdr.events WHERE type='lab_campaign_admitted'")).rows[0];
  await f.db.query("UPDATE sdr.events SET created_at=to_timestamp($1::double precision/1000) WHERE type='lab_campaign_admitted'",[intent.validUntilMs]);
  const expired=await f.audit();assert.equal(expired.success,false);assert.deepEqual(expired,{success:false,error:{code:'BINDING_MISMATCH'}});
  // Synthetic timestamp boundary: the actual admitted instant was before this shorter send-only window.
  intent.validUntilMs=original.created_at.getTime()+1;assert.ok(Date.now()>intent.validUntilMs);
  const admission=CampaignAdmissionSchema.parse({...CampaignAdmissionSchema.parse(original.detail),submitBeforeMs:intent.validUntilMs});
  await f.db.query("UPDATE sdr.events SET detail=$1,created_at=$2 WHERE type='lab_campaign_admitted'",[JSON.stringify(admission),original.created_at]);
  await f.db.query("UPDATE sdr.jobs SET context=jsonb_set(context,'{campaignAdmission,contentHash}',$2::jsonb) WHERE id=$1",[f.job.id,JSON.stringify(createHash('sha256').update(JSON.stringify(admission)).digest('hex'))]);
  const observed=await f.audit();assert.ok(observed.success,JSON.stringify(observed));assert.ok('jobDeadlineAtMs' in observed.data);
  assert.notEqual(observed.data.jobDeadlineAtMs,intent.validUntilMs);assert.equal(observed.data.objectiveAudit,'pending');
 }finally{await f.db.close();}
});

test('v2 accepts measured reservation equal to its ceiling and rejects a valid-formula reservation above it',async()=>{
 const f=await fixture({admission:true});try{
  assert.ok(f.v2State);await f.complete();
  const ledger=(await f.db.query<{detail:{reservedMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0];
  f.v2State.entries[0].admission.budget.maxReservationMicroUsd=ledger.detail.reservedMicroUsd;
  const original=CampaignAdmissionSchema.parse((await f.db.query<{detail:unknown}>("SELECT detail FROM sdr.events WHERE type='lab_campaign_admitted'")).rows[0].detail);
  const admission=CampaignAdmissionSchema.parse({...original,maxReservationMicroUsd:ledger.detail.reservedMicroUsd});
  await f.db.query("UPDATE sdr.events SET detail=$1 WHERE type='lab_campaign_admitted'",[JSON.stringify(admission)]);
  await f.db.query("UPDATE sdr.jobs SET context=jsonb_set(context,'{campaignAdmission,contentHash}',$2::jsonb) WHERE id=$1",[f.job.id,JSON.stringify(createHash('sha256').update(JSON.stringify(admission)).digest('hex'))]);
  assert.ok((await f.audit()).success);
  await f.db.query("UPDATE sdr.events SET detail=detail||$1::jsonb WHERE type='lab_model_budget_reserved'",[JSON.stringify({inputTokenBound:272000,reservedMicroUsd:698000})]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'AMBIGUOUS_LEDGER'}});
 }finally{await f.db.close();}
});

test('v2 preserves the sole paid recovery attempt and rejects mismatched or additional reservations',async()=>{
 const f=await fixture({admission:true,recoverBeforeReservation:true});try{
  await f.complete();const observed=await f.audit();assert.ok(observed.success,JSON.stringify(observed));
  assert.ok('preparation' in observed.data);assert.equal(observed.data.preparation.attempt,2);assert.equal(observed.data.ledger.detail.attempt,2);
  await f.db.query('UPDATE sdr.jobs SET attempts=3 WHERE id=$1',[f.job.id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'AMBIGUOUS_LEDGER'}});
  await f.db.query('UPDATE sdr.jobs SET attempts=2 WHERE id=$1',[f.job.id]);
  await f.db.query("INSERT INTO sdr.events SELECT 'extra-v2-reservation',tenant_id,brand_id,conversation_id,type,jsonb_set(detail,'{gateId}','\"another-gate\"'),created_at FROM sdr.events WHERE type='lab_model_budget_reserved'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'AMBIGUOUS_LEDGER'}});
 }finally{await f.db.close();}
});

test('a free pre-reservation recovery may settle its sole paid attempt without losing terminal evidence',async()=>{
 const f=await fixture({recoverBeforeReservation:true});try{
  assert.deepEqual(await f.complete(),{accepted:true});
  const reservations=(await f.db.query<{detail:{attempt:number,settled:boolean}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(reservations.length,1);assert.equal(reservations[0].detail.attempt,2);assert.equal(reservations[0].detail.settled,true);
  const observed=await f.audit();assert.ok(observed.success,JSON.stringify(observed));
  assert.equal(observed.data.job.attempts,2);assert.equal(observed.data.ledger.detail.attempt,2);
  assert.equal(observed.data.objectiveAudit,'pending');assert.equal(observed.data.humanReview,'pending');
 }finally{await f.db.close();}
});

test('only a canonical recorded intent may reach SQL; caller receipts or invented targets are not authority',async()=>{
 const f=await fixture();try{
  let queries=0;const tx:Queryable={query:async()=>{queries++;throw new Error('SQL must not run');}};
  const command={runId:f.plan.request.runId,turnId:f.turn.id};
  const auditor=new Sprint4TerminalAudit(tx,f.journal);
  assert.deepEqual(await auditor.execute({...command,receipt:{objectiveAudit:'passed'}}),{success:false,error:{code:'INVALID_INPUT'}});
  assert.deepEqual(await new Sprint4TerminalAudit(tx,{read:async()=>null}).execute(command),{success:false,error:{code:'INTENT_NOT_FOUND'}});
  assert.deepEqual(await auditor.execute({...command,turnId:'invented-turn'}),{success:false,error:{code:'INTENT_NOT_FOUND'}});
  const bad=structuredClone(f.state);bad.plan.phases[0].executions[0].turns[0].input='Altered campaign';
  assert.deepEqual(await new Sprint4TerminalAudit(tx,{read:async()=>bad}).execute(command),{success:false,error:{code:'INVALID_INTENT'}});
  bad.plan=f.plan;bad.entries[0].preflight.target={...f.plan.request.target,contentHash:'b'.repeat(64)};
  assert.deepEqual(await new Sprint4TerminalAudit(tx,{read:async()=>bad}).execute(command),{success:false,error:{code:'INVALID_INTENT'}});
  assert.equal(queries,0);
 }finally{await f.db.close();}
});

test('the adapter requires read-only scoped SQL and current database admin ownership, not a saved preflight claim',async()=>{
 const f=await fixture();try{
  await f.complete();
  assert.deepEqual(await f.audit(false),{success:false,error:{code:'UNSAFE_READ_CONTEXT'}});
  assert.deepEqual(await f.audit(true,'other-tenant'),{success:false,error:{code:'UNSAFE_READ_CONTEXT'}});
  await f.db.query("UPDATE sdr.memberships SET role='tester' WHERE user_id=$1",[actor.userId]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
  await f.db.query("UPDATE sdr.memberships SET role='admin' WHERE user_id=$1",[actor.userId]);
  await f.db.query("UPDATE sdr.lab_sessions SET owner_user_id='another-admin' WHERE id=$1",[f.session.id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
 }finally{await f.db.close();}
});

test('request text, job identity, pinned version/hash and evaluation provenance must agree independently of the journal',async()=>{
 const f=await fixture();try{
  await f.complete();
  const original=structuredClone(f.state),intent=f.state.entries[0].preflight;
  intent.requestId=randomUUID();assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});intent.requestId=original.entries[0].preflight.requestId;
  await f.db.query('UPDATE sdr.messages SET text=$2 WHERE id=$1',[f.job.trigger_message_id,'Different request']);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
  await f.db.query('UPDATE sdr.messages SET text=$2 WHERE id=$1',[f.job.trigger_message_id,f.turn.input]);
  await f.db.query("UPDATE sdr.jobs SET candidate_id='wrong-candidate' WHERE id=$1",[f.job.id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
  await f.db.query('UPDATE sdr.jobs SET candidate_id=$2 WHERE id=$1',[f.job.id,f.job.candidate_id]);
  const wrongPlan=new Sprint4CampaignPlanner().execute({...f.plan.request,target:{...f.plan.request.target,contentHash:'b'.repeat(64)}});assert.ok(wrongPlan.success);
  f.state.plan=wrongPlan.data;intent.target=wrongPlan.data.request.target;
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
  f.state.plan=original.plan;intent.target=original.plan.request.target;
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{contentHash}','\"wrong\"') WHERE type='lab_evaluation_session_created'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'BINDING_MISMATCH'}});
 }finally{await f.db.close();}
});

test('unfinished jobs and memory advanced or inconsistent after completion cannot become terminal proof',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.audit(),{success:false,error:{code:'NOT_TERMINAL'}});
  await f.complete();
  await f.db.query('UPDATE sdr.candidates SET revision=revision+1 WHERE id=$1',[f.job.candidate_id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'MEMORY_ADVANCED'}});
  await f.db.query('UPDATE sdr.candidates SET revision=revision-1 WHERE id=$1',[f.job.candidate_id]);
  await f.db.query('DELETE FROM sdr.facts WHERE candidate_id=$1',[f.job.candidate_id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'INCOMPLETE_EVIDENCE'}});
 }finally{await f.db.close();}
});

test('missing settlement, repeated attempts and inconsistent usage/cost remain ambiguous despite a passed receipt',async()=>{
 const f=await fixture();try{
  await f.complete();const intent=f.state.entries[0].preflight;
  f.state.entries[0].receipts.push({receiptId:'forged-proof',turnId:f.turn.id,requestId:intent.requestId,sessionId:f.session.id,target:f.plan.request.target,observedAtMs:Date.now(),kind:'terminal',jobId:f.job.id,evidenceRef:'not-proof',jobState:'completed',guardCodes:[],criticalCodes:[],objectiveAudit:'passed',ledger:{reservationId:'not-proof',state:'settled',costMicroUsd:400},responseArtifactRef:'not-proof',rawArtifactRef:null});
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{settled}','false') WHERE type='lab_model_budget_reserved'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'AMBIGUOUS_LEDGER'}});
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{settled}','true') WHERE type='lab_model_budget_reserved'");
  await f.db.query("INSERT INTO sdr.events SELECT 'extra-reservation',tenant_id,brand_id,conversation_id,type,jsonb_set(detail,'{gateId}','\"another-gate\"'),created_at FROM sdr.events WHERE type='lab_model_budget_reserved'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'AMBIGUOUS_LEDGER'}});
  await f.db.query("DELETE FROM sdr.events WHERE id='extra-reservation'");
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{costMicroUsd}','399') WHERE type='lab_model_budget_reserved'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'AMBIGUOUS_LEDGER'}});
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{costMicroUsd}','400') WHERE type='lab_model_budget_reserved'");
  await f.db.query('UPDATE sdr.jobs SET attempts=2 WHERE id=$1',[f.job.id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'AMBIGUOUS_LEDGER'}});
 }finally{await f.db.close();}
});

test('response messages and guard events must corroborate the stored result and terminal control state',async()=>{
 const f=await fixture();try{
  await f.complete();
  await f.db.query('UPDATE sdr.messages SET text=$2 WHERE id=$1',[f.job.id+':reply:0','Unrelated replacement']);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'INCOMPLETE_EVIDENCE'}});
  await f.db.query('UPDATE sdr.messages SET text=$2 WHERE id=$1',[f.job.id+':reply:0',f.result.bubbles[0]]);
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{versionId}','\"other-version\"') WHERE type='turn_completed'");
  assert.deepEqual(await f.audit(),{success:false,error:{code:'INCOMPLETE_EVIDENCE'}});
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{versionId}',$1::jsonb) WHERE type='turn_completed'",[JSON.stringify(f.job.version_id)]);
  await f.db.query("UPDATE sdr.conversations SET state='human',epoch=epoch+1 WHERE id=$1",[f.session.id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'INCOMPLETE_EVIDENCE'}});
 }finally{await f.db.close();}
});

test('a journal cannot relabel one request as two campaign turns',async()=>{
 const f=await fixture();try{
  await f.complete();
  const prior=f.state.entries[0],second=f.plan.phases[0].executions[0].turns[1];
  f.state.entries.push({...structuredClone(prior),turnId:second.id,preflight:{...structuredClone(prior.preflight),turnId:second.id,sessionFresh:false}});
  assert.deepEqual(await f.audit(),{success:false,error:{code:'INVALID_INTENT'}});
 }finally{await f.db.close();}
});

test('M6 requires a normal session and a real matching publication record, without deriving human acceptance',async()=>{
 const f=await fixture();try{
  await f.complete();const template=structuredClone(f.state.entries[0].preflight);
  const turns=f.plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns)),m6=turns[66];
  // Synthetic journal prefix only: this fixture neither runs nor approves the preceding 66 turns.
  f.state.entries=turns.slice(0,67).map((turn,index)=>({turnId:turn.id,receipts:[],preflight:{...structuredClone(template),turnId:turn.id,published:index===66,
   requestId:index===66?template.requestId:randomUUID(),sessionId:index===66?template.sessionId:'prior-'+turn.id.slice(0,turn.id.lastIndexOf('/')),
   sessionFresh:turn.afterAuditedTerminalTurnId===null}}));
  assert.deepEqual(await f.audit(true,scope.tenantId,m6.id),{success:false,error:{code:'BINDING_MISMATCH'}});
  await f.db.query("DELETE FROM sdr.events WHERE type='lab_evaluation_session_created'");
  assert.deepEqual(await f.audit(true,scope.tenantId,m6.id),{success:false,error:{code:'INCOMPLETE_EVIDENCE'}});
  // A local publication row is raw fixture evidence, NOT a fabricated human score or a publish call.
  await f.db.query("INSERT INTO sdr.publication_events(id,tenant_id,brand_id,version_id,content_hash,approved_by,validation_run_ids,created_at) SELECT 'fixture-publication',tenant_id,brand_id,version_id,$2,'synthetic-admin','[]',created_at-interval '1 second' FROM sdr.lab_sessions WHERE id=$1",[f.session.id,f.plan.request.target.contentHash]);
  const observed=await f.audit(true,scope.tenantId,m6.id);assert.ok(observed.success);
  assert.equal(observed.data.publicationEvidenceId,'fixture-publication');assert.equal(observed.data.objectiveAudit,'pending');assert.equal(observed.data.humanReview,'pending');
 }finally{await f.db.close();}
});

test('legitimate handoff and guard rejection remain distinct raw observations, never automatic acceptance',async()=>{
 for(const rejected of [false,true]){
  const f=await fixture();try{
   f.result.proposals=[];
   Object.assign(f.result,{bubbles:[rejected?'Seu retorno é garantido.':'O atendimento automático ficará pausado para revisão da equipe.'],nextAction:rejected?'continue':'handoff',handoffReason:rejected?null:'Revisão solicitada.'});
   await f.complete();const observed=await f.audit();assert.ok(observed.success);
   assert.equal(observed.data.job.state,'handoff');assert.equal(observed.data.guard.detail.guardPassed,!rejected);
   assert.equal(observed.data.ledger.detail.settled,true);assert.equal(observed.data.objectiveAudit,'pending');
   if(rejected){assert.deepEqual(observed.data.guard.detail.guardViolations,['return_guarantee']);assert.equal(JSON.stringify(observed).includes('Seu retorno é garantido.'),false);}
  }finally{await f.db.close();}
 }
});

test('SQL and journal failures are sanitized and never become empty successful evidence',async()=>{
 const f=await fixture();try{
  const command={runId:f.plan.request.runId,turnId:f.turn.id};
  const broken:Queryable={query:async()=>{throw new Error('private-fixture-canary');}};
  assert.deepEqual(await new Sprint4TerminalAudit(broken,f.journal).execute(command),{success:false,error:{code:'READ_FAILED'}});
  assert.deepEqual(await new Sprint4TerminalAudit(f.db,{read:async()=>{throw new Error('private-fixture-canary');}}).execute(command),{success:false,error:{code:'READ_FAILED'}});
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='turn_completed'")).rows.length,0);
 }finally{await f.db.close();}
});

test('colliding private IDs from another tenant or brand cannot enter the single SQL observation',async()=>{
 const f=await fixture();try{
  await f.complete();
  for(const [tenant,brand] of [['foreign-tenant','sapore'],['cognita-homologacao','foreign-brand']]){
   const s=[tenant,brand];
   await f.db.query("INSERT INTO sdr.brands VALUES($1,$2,'Foreign canary')",s);
   await f.db.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,kind) VALUES($1||':'||$2,$1,$2,'laboratory')",s);
   await f.db.query("INSERT INTO sdr.versions SELECT id,$1,$2,label,snapshot,content_hash,model,test_status,created_at FROM sdr.versions WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
   await f.db.query("INSERT INTO sdr.candidates SELECT id,$1,$2,contact_id,authorized_contact_id,'Foreign canary',lead_state,revision,updated_at FROM sdr.candidates WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
   await f.db.query("INSERT INTO sdr.conversations SELECT id,$1,$2,candidate_id,$1||':'||$2,state,epoch,execution_id,control_fingerprint,last_inbound_at,updated_at FROM sdr.conversations WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
   await f.db.query("INSERT INTO sdr.lab_sessions SELECT $1,$2,id,owner_user_id,request_id,candidate_id,'Foreign canary',scenario,version_id,created_at FROM sdr.lab_sessions WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
   await f.db.query("INSERT INTO sdr.jobs SELECT $1||':'||$2||id,$1,$2,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state,result,error_code,context,usage,created_at,available_at,deadline,lease_until,attempts,completed_at FROM sdr.jobs WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
   await f.db.query("INSERT INTO sdr.messages SELECT id,$1,$2,conversation_id,candidate_id,actor,type,'Foreign canary',media_id,transcript_origin,provider_timestamp,created_at FROM sdr.messages WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
   await f.db.query("INSERT INTO sdr.events SELECT $1||':'||$2||id,$1,$2,conversation_id,type,detail,created_at FROM sdr.events WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
   await f.db.query("INSERT INTO sdr.facts SELECT id,$1,$2,candidate_id,data,updated_at FROM sdr.facts WHERE tenant_id='cognita-homologacao' AND brand_id='sapore'",s);
  }
  const observed=await f.audit();assert.ok(observed.success);assert.equal(observed.data.binding.jobId,f.job.id);
  assert.equal(observed.data.response.length,2);assert.equal(observed.data.memory.facts.length,1);assert.equal(JSON.stringify(observed).includes('Foreign canary'),false);
 }finally{await f.db.close();}
});

test('stale or failed jobs and expired unresolved work never masquerade as ordinary pending observations',async()=>{
 const f=await fixture();try{
  for(const state of ['stale','failed','cancelled','dispatched']){
   await f.db.query('UPDATE sdr.jobs SET state=$2 WHERE id=$1',[f.job.id,state]);
   assert.deepEqual(await f.audit(),{success:false,error:{code:'TERMINAL_FAILURE'}});
  }
  await f.db.query("UPDATE sdr.jobs SET state='running',deadline=now()-interval '1 second' WHERE id=$1",[f.job.id]);
  assert.deepEqual(await f.audit(),{success:false,error:{code:'INCOMPLETE_EVIDENCE'}});
 }finally{await f.db.close();}
});
