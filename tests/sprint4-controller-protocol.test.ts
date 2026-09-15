import test from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../evaluations/sprint4-controller.spec.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { Sprint4Controller } from '../evaluations/sprint4-controller.js';

const evidence={turnId:'C01/R1/T1',actorUserId:'synthetic-admin',target:{versionId:'v1',contentHash:'a'.repeat(64),model:'gpt-5.4-2026-03-05'},evidenceRef:'private-fixture',
 observedAtMs:1000,validUntilMs:2000,adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,
 tenantId:'cognita-homologacao',brandId:'sapore',executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,
 sessionId:'session-1',sessionOwned:true,sessionReady:true,sessionFresh:true,requestId:'11111111-1111-4111-8111-111111111111',
 budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000,accountedMicroUsd:359814,maxReservationMicroUsd:60000,remainingCampaignReviewed:true},
 daily:{actorUserId:'synthetic-admin',limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}};

test('admission evidence contains a conservative ceiling and never claims a future payload or job deadline',()=>{
 assert.ok(contracts.AdmissionEvidenceSchema,'The new admission contract must exist');
 const result=contracts.AdmissionEvidenceSchema.safeParse(evidence);assert.ok(result.success);
 assert.equal('deadlineAtMs' in result.data,false);assert.equal('exactPayloadBound' in result.data.budget,false);
 assert.equal(contracts.AdmissionEvidenceSchema.safeParse({...evidence,deadlineAtMs:61000}).success,false);
 assert.equal(contracts.AdmissionEvidenceSchema.safeParse({...evidence,budget:{...evidence.budget,exactPayloadBound:16000,reservationMicroUsd:58000}}).success,false);
});

test('stored protocol distinguishes immutable legacy preflight from a new admission without coercing either',()=>{
 const result=new Sprint4CampaignPlanner().execute({runId:'protocol-fixture',actorUserId:evidence.actorUserId,target:evidence.target});assert.ok(result.success);
 const plan=result.data,turnId=plan.phases[0].executions[0].turns[0].id;
 const admission={...evidence,turnId};
 const legacy={revision:1,plan,entries:[{turnId,preflight:{...admission,deadlineAtMs:61000,budget:{gateId:admission.budget.gateId,limitMicroUsd:1000000,accountedMicroUsd:359814,exactPayloadBound:16000,reservationMicroUsd:58000,remainingCampaignReviewed:true}},receipts:[]}]};
 const current={protocol:'sprint4-admission-v2',revision:1,plan,entries:[{turnId,admission,receipts:[]}]};
 assert.ok(contracts.StoredControllerStateSchema,'Both historical and current protocols need explicit read schemas');
 assert.deepEqual(contracts.StoredControllerStateSchema.parse(legacy),legacy);
 assert.deepEqual(contracts.ControllerStateSchema.parse(current),current);
 assert.equal(contracts.ControllerStateSchema.safeParse(legacy).success,false);
 assert.equal(contracts.StoredControllerStateSchema.safeParse({...current,protocol:'unknown'}).success,false);
 assert.equal(contracts.StoredControllerStateSchema.safeParse({...legacy,protocol:'sprint4-admission-v2'}).success,false);
});

test('receipts can observe job creation before reservation and record the later measured preparation explicitly',()=>{
 const accepted={receiptId:'accepted-1',turnId:evidence.turnId,requestId:evidence.requestId,sessionId:evidence.sessionId,target:evidence.target,observedAtMs:1500,
  kind:'accepted',jobId:'job-1',jobDeadlineAtMs:61000,preparation:null,evidenceRef:'job-created',jobState:'pending',guardCodes:[],criticalCodes:[],objectiveAudit:'pending',
  ledger:{reservationId:null,state:'not-reserved',costMicroUsd:null},responseArtifactRef:null,rawArtifactRef:null};
 assert.deepEqual(contracts.ReceiptSchema.parse(accepted),accepted);
 const prepared={...accepted,receiptId:'prepared-1',kind:'prepared',jobState:'working',observedAtMs:2500,
  preparation:{attempt:2,inputTokenBound:16000,reservedMicroUsd:58000,reservationId:'reservation-1'},ledger:{reservationId:'reservation-1',state:'reserved',costMicroUsd:null}};
 assert.deepEqual(contracts.ReceiptSchema.parse(prepared),prepared);
 assert.equal(contracts.LegacyReceiptSchema.safeParse(accepted).success,false);
 assert.equal(contracts.ReceiptSchema.safeParse({...prepared,preparation:{...prepared.preparation,attempt:0}}).success,false);
});

test('resuming a legacy run returns an explicit read-only gate without inspecting, appending or upgrading it',async()=>{
 const result=new Sprint4CampaignPlanner().execute({runId:'legacy-resume',actorUserId:evidence.actorUserId,target:evidence.target});assert.ok(result.success);
 const plan=result.data,turnId=plan.phases[0].executions[0].turns[0].id;
 const legacy={revision:1,plan,entries:[{turnId,preflight:{...evidence,turnId,deadlineAtMs:61000,budget:{gateId:evidence.budget.gateId,limitMicroUsd:1000000,accountedMicroUsd:359814,exactPayloadBound:16000,reservationMicroUsd:58000,remainingCampaignReviewed:true}},receipts:[]}]};
 const before=JSON.stringify(legacy);let inspections=0,writes=0;
 const controller=new Sprint4Controller({async read(){return legacy;},async compareAndSwap(){writes++;return true;}},
  {nowMs:()=>1500,async inspect(){inspections++;return evidence;}});
 const resumed=await controller.execute({action:'next',plan});assert.equal(resumed.success,false);
 if(!resumed.success)assert.equal(resumed.error.code,'LEGACY_READ_ONLY');
 assert.equal(inspections,0);assert.equal(writes,0);assert.equal(JSON.stringify(legacy),before);
});
