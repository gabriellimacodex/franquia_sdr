import { createHash } from 'node:crypto';
import { createLeadState } from '../src/domain.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { ControllerStateSchema } from '../evaluations/sprint4-controller.spec.js';
import { AdmissionTerminalAuditObservationSchema } from '../evaluations/sprint4-terminal-audit.spec.js';

export const evidenceHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Synthetic DTOs, not evidence from a provider, remote database or human reviewer. */
export function evidenceFixture(){
 const planned=new Sprint4CampaignPlanner().execute({runId:'archive-fixture',actorUserId:'synthetic-admin',target:{versionId:'synthetic-v2',contentHash:'a'.repeat(64),model:'gpt-5.4-2026-03-05'}});
 if(!planned.success)throw new Error('Invalid fixture plan');
 const plan=planned.data,turn=plan.phases[0].executions[0].turns[0],sessionId='synthetic-session',candidateId='synthetic-candidate';
 const requestId='11111111-1111-4111-8111-111111111111',jobId='synthetic-job',time=(n:number)=>new Date(n).toISOString();
 const state=ControllerStateSchema.parse({protocol:'sprint4-admission-v2',revision:1,plan,entries:[{turnId:turn.id,receipts:[],admission:{
  turnId:turn.id,actorUserId:plan.request.actorUserId,target:plan.request.target,evidenceRef:'synthetic-readiness',observedAtMs:1000,validUntilMs:2000,
  adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,tenantId:'cognita-homologacao',brandId:'sapore',
  executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,
  sessionId,sessionOwned:true,sessionReady:true,sessionFresh:true,requestId,
  budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000,accountedMicroUsd:0,maxReservationMicroUsd:60000,remainingCampaignReviewed:true},
  daily:{actorUserId:plan.request.actorUserId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true},
 }}]});
 const result={bubbles:['Você vai administrar a loja, e Caio participa da decisão.'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
 const reservationId='lab-budget:'+createHash('sha256').update(`sprint3-continuous-20260910:${jobId}:1`).digest('hex');
 const message={conversation_id:sessionId,candidate_id:candidateId,type:'text',created_at:time(1500)};
 const observation=AdmissionTerminalAuditObservationSchema.parse({
  protocol:'sprint4-admission-v2',kind:'terminal-observation',observedAt:time(3000),objectiveAudit:'pending',humanReview:'pending',publicationEvidenceId:null,
  binding:{runId:plan.request.runId,turnId:turn.id,actorUserId:plan.request.actorUserId,sessionId,requestId,jobId,candidateId,target:plan.request.target},
  job:{id:jobId,conversation_id:sessionId,candidate_id:candidateId,trigger_message_id:sessionId+':'+requestId,version_id:plan.request.target.versionId,
   state:'completed',context_version:1,epoch:0,attempts:1,error_code:null,result,usage:{input_tokens:100,output_tokens:10,total_tokens:110},created_at:time(1500),completed_at:time(2500),deadline:time(61000)},
  input:{...message,id:sessionId+':'+requestId,actor:'candidate',text:turn.input},
  response:[{...message,id:jobId+':reply:0',actor:'agent',text:result.bubbles[0],created_at:time(2500)}],
  guard:{id:'synthetic-guard',conversation_id:sessionId,created_at:time(2500),detail:{jobId,versionId:plan.request.target.versionId,guardPassed:true}},
  memory:{basis:'current-row-at-job-revision',revision:1,lead:createLeadState('cognita-homologacao','sapore',candidateId),facts:[],relations:[]},
  ledger:{id:reservationId,conversation_id:sessionId,created_at:time(1600),detail:{gateId:'sprint3-continuous-20260910',jobId,attempt:1,inputTokenBound:16000,reservedMicroUsd:58000,costMicroUsd:400,settled:true,inputTokens:100,outputTokens:10}},
  jobDeadlineAtMs:61000,preparation:{attempt:1,inputTokenBound:16000,reservedMicroUsd:58000,reservationId},
  limitations:['provider-response-and-execution-not-retained','runtime-config-not-proven-by-ledger','memory-is-not-an-immutable-post-turn-snapshot','database-timestamps-are-not-commit-or-render-times','publication-ratings-not-revalidated'],
 });
 const payload={kind:'sprint4-terminal-artifact-v1',planHash:evidenceHash(plan),admission:state.entries[0].admission,observation,
  rawArtifact:{status:'unavailable',reason:'not-retained-by-runtime'}};
 const sha256=evidenceHash(payload),artifact={ref:'terminal-sha256:'+sha256,sha256,payload};
 return {plan,turn,state,observation,payload,artifact};
}
