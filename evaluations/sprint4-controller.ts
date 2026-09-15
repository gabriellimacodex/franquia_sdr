import { Sprint4CampaignPlanner } from './sprint4-campaign.js';
import { AdmissionEvidenceSchema, ControllerInputSchema, StoredControllerStateSchema, type CampaignEvidence, type CampaignJournal, type ControllerResult, type ControllerState, type Receipt, type Sprint4ControllerSpec } from './sprint4-controller.spec.js';

function identityConflict(left:Receipt,right:Receipt):boolean {
 return left.jobId!==null&&right.jobId!==null&&left.jobId!==right.jobId||
  left.jobDeadlineAtMs!==null&&right.jobDeadlineAtMs!==null&&left.jobDeadlineAtMs!==right.jobDeadlineAtMs||
  left.preparation!==null&&right.preparation!==null&&JSON.stringify(left.preparation)!==JSON.stringify(right.preparation)||
  left.ledger.reservationId!==null&&right.ledger.reservationId!==null&&left.ledger.reservationId!==right.ledger.reservationId;
}

export function haltReason(receipts:Receipt[],maxReservationMicroUsd:number,admissionObservedAtMs:number):'critical'|'ambiguous'|'failed'|null {
 if(receipts.some(receipt=>receipt.criticalCodes.length>0||receipt.preparation!==null&&receipt.preparation.reservedMicroUsd>maxReservationMicroUsd||
  receipt.ledger.costMicroUsd!==null&&receipt.ledger.costMicroUsd>(receipt.preparation?.reservedMicroUsd??maxReservationMicroUsd)))return 'critical';
 if(receipts.some(receipt=>receipt.kind==='ambiguous'||receipt.jobState==='unknown'||receipt.kind!=='terminal'&&receipt.jobState==='completed'||
  receipt.jobDeadlineAtMs!==null&&receipt.jobDeadlineAtMs<=admissionObservedAtMs||receipt.preparation!==null&&(
  receipt.preparation.reservedMicroUsd!==Math.ceil(receipt.preparation.inputTokenBound*2.5+1200*15)||receipt.preparation.reservationId!==receipt.ledger.reservationId)||
  receipt.kind==='accepted'&&(!receipt.jobId||receipt.jobDeadlineAtMs===null||receipt.preparation!==null||receipt.ledger.state!=='not-reserved'||receipt.ledger.reservationId!==null||receipt.ledger.costMicroUsd!==null)||
  receipt.kind==='prepared'&&(!receipt.jobId||receipt.jobDeadlineAtMs===null||receipt.preparation===null||receipt.ledger.state!=='reserved')||
  receipt.kind==='terminal'&&(!receipt.jobId||receipt.jobDeadlineAtMs===null||receipt.preparation===null||receipt.objectiveAudit==='unknown'||
  receipt.ledger.state!=='settled'||receipt.ledger.costMicroUsd===null||!receipt.ledger.reservationId||!receipt.responseArtifactRef)))return 'ambiguous';
 if(receipts.some(receipt=>receipt.guardCodes.length>0||receipt.objectiveAudit==='failed'||['failed','handoff','stale','cancelled'].includes(receipt.jobState)||
  receipt.kind==='terminal'&&receipt.jobState!=='completed'))return 'failed';
 return null;
}

/** No default adapters; never sends a request or creates model/human evidence.
 * A future runner may consume dispatch-once only once, before expiry, with the recorded requestId.
 * A lost action/timeout requires audit, never replay/reset. Receipts are trusted audit inputs,
 * not proof of their own truth; neither recorded sequence nor objective audit is human acceptance. */
export class Sprint4Controller implements Sprint4ControllerSpec {
 constructor(private readonly journal:CampaignJournal,private readonly evidence:CampaignEvidence){}
 async execute(raw:unknown):Promise<ControllerResult>{
  try{
   const input=ControllerInputSchema.safeParse(raw);
   if(!input.success)return {success:false,error:{code:'INVALID_INPUT',message:'Invalid controller command'}};
   const validated=new Sprint4CampaignPlanner().validate(input.data.plan);
   if(!validated.success)return {success:false,error:{code:'INVALID_PLAN',message:'Campaign plan is not canonical'}};
   const plan=validated.data,runId=plan.request.runId;
   const stored=await this.journal.read(runId),state=stored===null?null:StoredControllerStateSchema.parse(stored);
   if(state&&!('protocol' in state))return {success:false,error:{code:'LEGACY_READ_ONLY',message:'Historical preflight remains auditable but cannot authorize new dispatches or be upgraded'}};
   if(state&&JSON.stringify(state.plan)!==JSON.stringify(plan))return {success:false,error:{code:'STATE_MISMATCH',message:'Run is already bound to a different plan'}};
   const turns=plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns.map(turn=>({...turn,phase:phase.id}))));
   if(state?.entries.some((entry,index)=>entry.turnId!==turns[index]?.id||entry.admission.turnId!==entry.turnId||
    entry.admission.actorUserId!==plan.request.actorUserId||JSON.stringify(entry.admission.target)!==JSON.stringify(plan.request.target)||
    entry.receipts.some(receipt=>receipt.turnId!==entry.turnId||receipt.requestId!==entry.admission.requestId||receipt.sessionId!==entry.admission.sessionId||JSON.stringify(receipt.target)!==JSON.stringify(plan.request.target))||
    entry.receipts.some((receipt,receiptIndex)=>entry.receipts.slice(0,receiptIndex).some(prior=>identityConflict(receipt,prior)))||
    index<state.entries.length-1&&!entry.receipts.some(receipt=>receipt.kind==='terminal'&&receipt.objectiveAudit==='passed')
   ))return {success:false,error:{code:'STATE_MISMATCH',message:'Journal is not an auditable prefix of the fixed campaign'}};
   if(state?.entries.some((entry,index)=>{
    const prior=state.entries.slice(0,index),afterId=turns[index].afterAuditedTerminalTurnId,after=prior.find(item=>item.turnId===afterId);
    return prior.some(item=>item.admission.requestId===entry.admission.requestId)||
     (afterId?(!after||entry.admission.sessionFresh||entry.admission.sessionId!==after.admission.sessionId):
      (!entry.admission.sessionFresh||prior.some(item=>item.admission.sessionId===entry.admission.sessionId)))||
     entry.receipts.some(receipt=>prior.some(item=>item.receipts.some(previous=>receipt.jobId!==null&&receipt.jobId===previous.jobId||
      receipt.ledger.reservationId!==null&&receipt.ledger.reservationId===previous.ledger.reservationId)));
   }))return {success:false,error:{code:'STATE_MISMATCH',message:'Journal reuses a turn identity or breaks its session dependency'}};
   const last=state?.entries.at(-1);
   if(input.data.action==='record'){
    const receipt=input.data.receipt;
    const prior=state?.entries.flatMap(entry=>entry.receipts).find(item=>item.receiptId===receipt.receiptId);
    if(prior){
     if(JSON.stringify(prior)!==JSON.stringify(receipt))return {success:false,error:{code:'RECEIPT_CONFLICT',message:'Receipt ID already contains different evidence'}};
     return {success:true,data:{kind:'recorded',turnId:receipt.turnId,duplicate:true}};
    }
    if(!state||!last||receipt.turnId!==last.turnId||receipt.requestId!==last.admission.requestId||receipt.sessionId!==last.admission.sessionId||
     JSON.stringify(receipt.target)!==JSON.stringify(plan.request.target)||
     last.receipts.some(item=>identityConflict(receipt,item))||
     state.entries.slice(0,-1).some(entry=>entry.receipts.some(item=>receipt.jobId!==null&&item.jobId===receipt.jobId||receipt.ledger.reservationId!==null&&item.ledger.reservationId===receipt.ledger.reservationId))
    )return {success:false,error:{code:'RECEIPT_MISMATCH',message:'Receipt does not match the recorded intent'}};
    last.receipts.push(receipt);state.revision++;
    if(!await this.journal.compareAndSwap(runId,state.revision-1,state))return {success:false,error:{code:'CONCURRENT_CHANGE',message:'Journal changed; receipt was not recorded'}};
    const reason=haltReason(last.receipts,last.admission.budget.maxReservationMicroUsd,last.admission.observedAtMs);
    if(reason)return {success:true,data:{kind:'halted',turnId:last.turnId,reason}};
    return {success:true,data:{kind:'recorded',turnId:last.turnId,duplicate:false}};
   }
   const halted=state?.entries.find(entry=>haltReason(entry.receipts,entry.admission.budget.maxReservationMicroUsd,entry.admission.observedAtMs));
   if(halted)return {success:true,data:{kind:'halted',turnId:halted.turnId,reason:haltReason(halted.receipts,halted.admission.budget.maxReservationMicroUsd,halted.admission.observedAtMs)!}};
   if(last&&!last.receipts.some(receipt=>receipt.kind==='terminal'&&receipt.objectiveAudit==='passed'))return {success:true,data:{kind:'awaiting-receipt',turnId:last.turnId}};
   const turn=turns[state?.entries.length??0];
   if(input.data.expectedTurnId!==undefined&&turn?.id!==input.data.expectedTurnId)return {success:false,error:{code:'GATE_BLOCKED',message:'The intended next turn changed; no dispatch was issued'}};
   if(!turn)return {success:true,data:{kind:'sequence-recorded',turnsRecorded:turns.length,acceptance:'pending'}};
   const expectedSessionId=turn.afterAuditedTerminalTurnId?state?.entries.find(entry=>entry.turnId===turn.afterAuditedTerminalTurnId)?.admission.sessionId??null:null;
   const checked=AdmissionEvidenceSchema.safeParse(await this.evidence.inspect({plan,turnId:turn.id,expectedSessionId}));
   if(!checked.success)return {success:false,error:{code:'GATE_BLOCKED',message:'Admission evidence is missing or invalid'}};
   const admission=checked.data,now=this.evidence.nowMs();
   if(!Number.isSafeInteger(now)||admission.observedAtMs>now||admission.validUntilMs<=now||
    admission.actorUserId!==plan.request.actorUserId||admission.turnId!==turn.id||JSON.stringify(admission.target)!==JSON.stringify(plan.request.target)||
    !admission.adminActive||!admission.routeValidated||!admission.healthy||!admission.noUnexpectedJobs||!admission.sessionOwned||!admission.sessionReady||
    turn.phase==='m6-published'&&!admission.published||
    state?.entries.some(entry=>entry.admission.requestId===admission.requestId||!turn.afterAuditedTerminalTurnId&&entry.admission.sessionId===admission.sessionId)||
    (turn.afterAuditedTerminalTurnId?(!expectedSessionId||admission.sessionId!==expectedSessionId||admission.sessionFresh):!admission.sessionFresh)||
    !admission.budget.remainingCampaignReviewed||admission.budget.maxReservationMicroUsd<Math.ceil(4096*2.5+1200*15)||
    admission.budget.accountedMicroUsd+admission.budget.maxReservationMicroUsd>admission.budget.limitMicroUsd||
    admission.daily.actorUserId!==plan.request.actorUserId||admission.daily.usedMessages>=100||!admission.daily.stageAndControlsReviewed
   )return {success:false,error:{code:'GATE_BLOCKED',message:'Current evidence does not permit the next planned turn'}};
   const next:ControllerState={protocol:'sprint4-admission-v2',revision:(state?.revision??0)+1,plan,entries:[...state?.entries??[],{turnId:turn.id,admission,receipts:[]}]};
   if(!await this.journal.compareAndSwap(runId,state?.revision??null,next))return {success:false,error:{code:'CONCURRENT_CHANGE',message:'Journal changed; no dispatch was issued'}};
   const afterCommit=this.evidence.nowMs();
   if(!Number.isSafeInteger(afterCommit)||afterCommit<now||afterCommit>=admission.validUntilMs)return {success:false,error:{code:'GATE_BLOCKED',message:'Intent persisted but evidence expired; audit before any further action'}};
   return {success:true,data:{kind:'dispatch-once',turnId:turn.id,input:turn.input,sessionId:admission.sessionId,requestId:admission.requestId,target:plan.request.target,validUntilMs:admission.validUntilMs,
    campaignAdmission:{runId,turnId:turn.id,target:plan.request.target,maxReservationMicroUsd:admission.budget.maxReservationMicroUsd,submitBeforeMs:admission.validUntilMs}}};
  }catch{return {success:false,error:{code:'DEPENDENCY_FAILED',message:'Controller dependency or evidence failed; no automatic retry'}};}
 }
}
