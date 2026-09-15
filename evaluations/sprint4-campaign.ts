import { CampaignInputSchema, CampaignPlanSchema, SPRINT4_CASES, type CampaignCase, type CampaignPlan, type CampaignPlannerSpec, type CampaignResult } from './sprint4-campaign.spec.js';
import { analyzeCampaignBudget } from './sprint4-campaign-budget.js';
import type { CampaignBudgetResult } from './sprint4-campaign-budget.spec.js';

/** Pure planning only: no network, environment, database, clock or execution side effects. */
export class Sprint4CampaignPlanner implements CampaignPlannerSpec {
 analyzeBudget(raw:unknown):CampaignBudgetResult { return analyzeCampaignBudget(raw, plan=>this.validate(plan)); }
 execute(raw:unknown):CampaignResult {
  try {
   const parsed=CampaignInputSchema.safeParse(raw);
   if(!parsed.success)return {success:false,error:{code:'INVALID_INPUT',message:'Invalid campaign input'}};
   const request=parsed.data;
   if(request.dailySnapshot&&request.dailySnapshot.actorUserId!==request.actorUserId)return {success:false,error:{code:'INVALID_INPUT',message:'Daily usage snapshot belongs to a different actor'}};
   if(new Set(request.cases.map(item=>item.caseId)).size!==request.cases.length)return {success:false,error:{code:'DUPLICATE_IDS',message:'Duplicate campaign case IDs'}};
   if(JSON.stringify(request.cases)!==JSON.stringify(SPRINT4_CASES))return {success:false,error:{code:'MATRIX_MISMATCH',message:'Campaign cases must match the approved matrix exactly'}};
   const execution=(item:CampaignCase,repetition:'R1'|'R2',phase:'conversation-candidate'|'m6-published')=>{
    const id=`${request.runId}/${phase}/${repetition}/${item.caseId}`;
    return {id,phase,caseId:item.caseId,repetition,target:request.target,sessionKey:`${id}/session`,sessionId:null,requiresFreshSession:true,status:'pending',
     humanReview:{status:'pending',evaluatorId:null,scores:null,reviewedAt:null},
     turns:item.inputs.map((input,index)=>({id:`${id}/T${index+1}`,turn:index+1,input,status:'pending',afterAuditedTerminalTurnId:index===0?null:`${id}/T${index}`,jobId:null,result:null,elapsedMs:null,usage:null}))};
   };
   const includeM6=request.m6Policy==='separate';
   const totalPaidCalls=includeM6?72:66;
   const availableMicroUsd=request.budgetSnapshot?request.budgetSnapshot.limitMicroUsd-request.budgetSnapshot.accountedMicroUsd:null;
   const availableMessages=request.dailySnapshot?100-request.dailySnapshot.usedMessages:null;
   const plan:CampaignPlan=CampaignPlanSchema.parse({
    kind:'sprint4-campaign-plan',request,status:'pending',readyToExecute:false,
    counts:{scenarioCount:30,repetitions:2,conversationExecutions:60,conversationPaidCalls:66,m6Executions:includeM6?3:0,m6PaidCalls:includeM6?6:0,totalPaidCalls,deterministicRequiredExecutions:60},
    phases:[{id:'conversation-candidate',scheduled:true,status:'pending',requiresPublishedVersion:false,executions:(['R1','R2'] as const).flatMap(repetition=>request.cases.map(item=>execution(item,repetition,'conversation-candidate')))},
     {id:'m6-published',scheduled:includeM6,status:'pending',requiresPublishedVersion:true,executions:includeM6?request.cases.slice(0,3).map(item=>execution(item,'R1','m6-published')):[]}],
    checks:{pinsVerified:false,
     budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1_000_000,availableMicroUsd,
      nextReservationCovered:availableMicroUsd===null||request.nextReservationMicroUsd===null?null:request.nextReservationMicroUsd<=availableMicroUsd,
      campaignCostMicroUsd:null,minimumAdditionalSpendMicroUsd:null,requiresLiveRecheck:true},
     daily:{actorUserId:request.actorUserId,limitMessages:100,rollingWindowHours:24,availableMessages,nextRepetitionMessages:33,plannedContextualMessages:totalPaidCalls,
      nextRepetitionFitsWindow:availableMessages===null?null:availableMessages>=33,campaignFitsWindow:availableMessages===null?null:availableMessages>=totalPaidCalls,
      controlsNeedAdditionalCapacity:true,requiresLiveRecheck:true}},
    pendingGates:['real-admin','published-evaluation-route','deterministic-30x2','conversation-30x2','human-average-at-least-4','publication','m6','commercial-approval','personal-reviewer-validation','budget-ledger-and-payload-reservation','actor-100-messages-rolling-24h'],
   });
   return {success:true,data:plan};
  }catch{return {success:false,error:{code:'PLANNING_FAILED',message:'Campaign planning failed'}};}
 }
 validate(raw:unknown):CampaignResult {
  try {
   const parsed=CampaignPlanSchema.safeParse(raw);
   if(!parsed.success)return {success:false,error:{code:'PLAN_MISMATCH',message:'Invalid saved campaign plan'}};
   const plan=parsed.data,expected=this.execute(plan.request);
   if(!expected.success)return expected;
   const executions=plan.phases.flatMap(phase=>phase.executions);
   const ids=executions.flatMap(item=>[item.id,item.sessionKey,...item.turns.map(turn=>turn.id)]);
   if(new Set(ids).size!==ids.length)return {success:false,error:{code:'DUPLICATE_IDS',message:'Duplicate campaign execution or turn IDs'}};
   if(executions.some(item=>JSON.stringify(item.target)!==JSON.stringify(plan.request.target)))return {success:false,error:{code:'PIN_MISMATCH',message:'Execution target differs from the requested version, hash or model'}};
   if(JSON.stringify(plan.counts)!==JSON.stringify(expected.data.counts))return {success:false,error:{code:'COUNT_MISMATCH',message:'Campaign counts differ from the approved schedule'}};
   if(JSON.stringify(plan)!==JSON.stringify(expected.data))return {success:false,error:{code:'PLAN_MISMATCH',message:'Saved plan differs from the canonical pending campaign'}};
   return expected;
  }catch{return {success:false,error:{code:'PLANNING_FAILED',message:'Campaign validation failed'}};}
 }
}
