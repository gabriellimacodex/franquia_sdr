import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { seedPilot, initialSnapshot } from '../src/seed.js';
import { Versioning } from '../src/versioning.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { testConfig } from './config.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { Sprint4Controller } from '../evaluations/sprint4-controller.js';
import { ControllerStateSchema, type AdmissionEvidence, type Receipt } from '../evaluations/sprint4-controller.spec.js';
import { Sprint4Journal } from '../evaluations/sprint4-journal.js';
import { Sprint4TerminalAudit } from '../evaluations/sprint4-terminal-audit.js';

// Cross-module local regression. No authenticated HTTP, n8n/provider execution, rating or publication is claimed.
test('durable controller admission reaches the financial-v2 runtime and terminal auditor without becoming automatic acceptance',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-admission-integration-'));
 const pg=new PGlite({extensions:{vector}});
 const db:Database={query:(sql,params)=>pg.query(sql,params),transaction:fn=>pg.transaction(tx=>fn(tx as Queryable)),close:()=>pg.close()};
 let journal=new Sprint4Journal({directory,initializeNew:true});
 const scope={tenantId:'cognita-homologacao',brandId:'sapore'} as const,actor={...scope,userId:'integration-admin',role:'admin'};
 let modelPosts=0;
 try{
  for(const migration of ['001_sdr.sql','002_versions.sql','003_lab_sessions.sql'])await pg.exec(await readFile(new URL('../migrations/'+migration,import.meta.url),'utf8'));
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}],adminUserIds:[actor.userId]});
  const draft=await new Versioning(db).saveDraft(scope,createFinancialDraftSnapshot(initialSnapshot(scope)),actor.userId);assert.ok(draft.ok);
  const planned=new Sprint4CampaignPlanner().execute({runId:'integrated-admission',actorUserId:actor.userId,
   target:{versionId:draft.value.versionId,contentHash:draft.value.contentHash,model:'gpt-5.4-2026-03-05'}});assert.ok(planned.success);
  const plan=planned.data,turn=plan.phases[0].executions[0].turns[0],sessions=new LabSessions(db),store=new Store(db);
  const session=await sessions.createEvaluation(actor,{requestId:randomUUID(),label:'Synthetic integrated campaign',scenario:'free',versionId:draft.value.versionId,contentHash:draft.value.contentHash});assert.ok(session.ok);
  const evidence:AdmissionEvidence={turnId:turn.id,actorUserId:actor.userId,target:plan.request.target,evidenceRef:'local-synthetic-readiness',
   observedAtMs:Date.now(),validUntilMs:Date.now()+60000,adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,...scope,
   executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,sessionId:session.value.id,sessionOwned:true,sessionReady:true,sessionFresh:true,requestId:randomUUID(),
   budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000,accountedMicroUsd:0,maxReservationMicroUsd:100000,remainingCampaignReviewed:true},
   daily:{actorUserId:actor.userId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}};
  const port={nowMs:Date.now,async inspect(){return structuredClone(evidence);}};
  let controller=new Sprint4Controller(journal.asCampaignJournal(),port);
  const action=await controller.execute({action:'next',plan});assert.ok(action.success);assert.equal(action.data.kind,'dispatch-once');if(action.data.kind!=='dispatch-once')return;
  const dispatch=action.data;
  const sent=await sessions.send(actor,dispatch.sessionId,{requestId:dispatch.requestId,text:dispatch.input,campaignAdmission:dispatch.campaignAdmission});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0].n,0);
  const created=sent.value.detail.job;assert.ok(created);assert.equal(created.state,'pending');
  assert.equal(typeof created.id,'string');assert.ok(typeof created.id==='string');
  assert.ok(created.deadline instanceof Date||typeof created.deadline==='string');
  const accepted:Receipt={receiptId:'integration-accepted',turnId:turn.id,requestId:dispatch.requestId,sessionId:dispatch.sessionId,target:dispatch.target,observedAtMs:Date.now(),
   kind:'accepted',jobId:created.id,jobDeadlineAtMs:new Date(created.deadline).getTime(),preparation:null,evidenceRef:'local-send-response',jobState:'pending',
   guardCodes:[],criticalCodes:[],objectiveAudit:'pending',ledger:{reservationId:null,state:'not-reserved',costMicroUsd:null},responseArtifactRef:null,rawArtifactRef:null};
  const recorded=await controller.execute({action:'record',plan,receipt:accepted});assert.ok(recorded.success);assert.equal(recorded.data.kind,'recorded');
  await journal.execute({action:'close'});journal=new Sprint4Journal({directory});controller=new Sprint4Controller(journal.asCampaignJournal(),port);
  const resumed=await controller.execute({action:'next',plan});assert.ok(resumed.success);assert.deepEqual(resumed.data,{kind:'awaiting-receipt',turnId:turn.id});
  const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
  const engine=new Engine(store,{...testConfig,LAB_BUDGET_GATE_ID:'sprint3-continuous-20260910',LAB_BUDGET_LIMIT_MICRO_USD:1000000},async()=>{modelPosts++;return Response.json({accepted:true});});
  await engine.dispatch(channel,job);assert.equal(modelPosts,1);
  assert.deepEqual(await engine.complete({jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:plan.request.target.model,
   usage:{input_tokens:100,output_tokens:10,total_tokens:110},result:{bubbles:['Você vai administrar a loja, e Caio participa da decisão.','O que motivou seu interesse na franquia?'],
    proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null,financialReply:null}}),{accepted:true});
  const audit=await db.transaction(async tx=>{
   await tx.query('SET TRANSACTION READ ONLY');await tx.query("SELECT set_config('sdr.tenant_id',$1,true),set_config('sdr.brand_id',$2,true)",[scope.tenantId,scope.brandId]);
   return new Sprint4TerminalAudit(tx,journal.asCampaignJournal()).execute({runId:plan.request.runId,turnId:turn.id});
  });
  assert.ok(audit.success,JSON.stringify(audit));assert.ok('preparation' in audit.data);
  assert.equal(audit.data.protocol,'sprint4-admission-v2');assert.equal(audit.data.jobDeadlineAtMs,accepted.jobDeadlineAtMs);
  assert.ok(audit.data.preparation.reservedMicroUsd<evidence.budget.maxReservationMicroUsd);
  assert.equal(audit.data.ledger.detail.settled,true);assert.equal(audit.data.ledger.detail.costMicroUsd,400);
  assert.equal(audit.data.objectiveAudit,'pending');assert.equal(audit.data.humanReview,'pending');
  const invalid=await controller.execute({action:'record',plan,receipt:audit.data});assert.equal(invalid.success,false);if(!invalid.success)assert.equal(invalid.error.code,'INVALID_INPUT');
  const after=await controller.execute({action:'next',plan});assert.ok(after.success);assert.deepEqual(after.data,{kind:'awaiting-receipt',turnId:turn.id});
  const state=ControllerStateSchema.parse(await journal.asCampaignJournal().read(plan.request.runId));
  assert.equal(state.entries.length,1);assert.equal(state.entries[0].receipts.length,1);assert.equal(state.entries[0].receipts[0].preparation,null);
  assert.equal(modelPosts,1);assert.equal((await db.query("SELECT count(*)::int AS n FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0].n,1);
 }finally{await journal.execute({action:'close'});await db.close();await rm(directory,{recursive:true,force:true});}
});
