import { Sprint4CampaignPlanner } from './sprint4-campaign.js';
import { haltReason } from './sprint4-controller.js';
import { BootstrapResultSchema } from './sprint4-bootstrap.spec.js';
import { HttpResultSchema } from './sprint4-http.spec.js';
import { ControllerResultSchema, ControllerStateSchema } from './sprint4-controller.spec.js';
import { EvidenceCaptureResultSchema, terminalEvidenceHash } from './sprint4-evidence.spec.js';
import { ReviewedReceiptResultSchema } from './sprint4-reviewed-receipt.spec.js';
import { RunnerInputSchema, type RunnerDependencies, type RunnerResult, type Sprint4RunnerSpec } from './sprint4-runner.spec.js';

export class Sprint4Runner implements Sprint4RunnerSpec {
 constructor(private readonly dependencies:RunnerDependencies){}
 async execute(raw:unknown):Promise<RunnerResult>{
  try{
   const parsed=RunnerInputSchema.safeParse(raw);if(!parsed.success)return {success:false,error:{code:'INVALID_INPUT'}};
   const validated=new Sprint4CampaignPlanner().validate(parsed.data.plan);if(!validated.success)return {success:false,error:{code:'INVALID_PLAN'}};
   const plan=validated.data,turns=plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns));
   const stored=await this.dependencies.journal.read(validated.data.request.runId),state=stored===null?null:ControllerStateSchema.parse(stored);
   if(state&&(JSON.stringify(state.plan)!==JSON.stringify(plan)||state.entries.some((entry,index)=>entry.turnId!==turns[index]?.id||
    entry.admission.turnId!==entry.turnId||entry.admission.actorUserId!==plan.request.actorUserId||JSON.stringify(entry.admission.target)!==JSON.stringify(plan.request.target)||
    entry.receipts.some(receipt=>receipt.turnId!==entry.turnId||receipt.requestId!==entry.admission.requestId||receipt.sessionId!==entry.admission.sessionId||JSON.stringify(receipt.target)!==JSON.stringify(plan.request.target)))))
    return {success:false,error:{code:'STATE_MISMATCH'}};
   if(parsed.data.action==='observe'&&state===null)return {success:true,data:{kind:'idle'}};
   for(const entry of state?.entries??[]){
    const reason=haltReason(entry.receipts,entry.admission.budget.maxReservationMicroUsd,entry.admission.observedAtMs);
    if(reason)return {success:true,data:{kind:'halted',turnId:entry.turnId,reason}};
   }
   const last=state?.entries.at(-1);
   const finalReceipt=last?.receipts.find(receipt=>receipt.kind==='terminal'&&receipt.objectiveAudit==='passed');
   if(parsed.data.action==='advance'&&last&&!finalReceipt)
    return {success:true,data:{kind:'awaiting-receipt',turnId:last.turnId}};
   if(parsed.data.action==='advance'&&last&&finalReceipt){
    const verified=ReviewedReceiptResultSchema.parse(await this.dependencies.review.execute({plan,turnId:last.turnId,receipt:finalReceipt}));
    if(!verified.success)return {success:false,error:{code:'DEPENDENCY_FAILED'}};
    if(verified.data.kind==='awaiting-review')return {success:true,data:{kind:'awaiting-review',turnId:last.turnId,artifactRef:finalReceipt.responseArtifactRef??'',gaps:verified.data.gaps}};
    if(verified.data.kind!=='receipt'||JSON.stringify(verified.data.receipt)!==JSON.stringify(finalReceipt))return {success:false,error:{code:'STATE_MISMATCH'}};
   }
   if(parsed.data.action==='observe'&&last){
    const captured=EvidenceCaptureResultSchema.parse(await this.dependencies.capture.execute({plan:validated.data,turnId:last.turnId}));
    if(!captured.success){
     if(captured.error.code==='AUDIT_FAILED'&&captured.error.auditCode==='NOT_TERMINAL')return {success:true,data:{kind:'awaiting-job',turnId:last.turnId}};
     return {success:false,error:{code:'DEPENDENCY_FAILED'}};
    }
    const artifact=captured.data.artifact,observation=artifact.payload.observation;
    if(artifact.payload.planHash!==terminalEvidenceHash(plan)||JSON.stringify(artifact.payload.admission)!==JSON.stringify(last.admission)||
     observation.binding.runId!==plan.request.runId||observation.binding.turnId!==last.turnId||observation.input.text!==turns[state!.entries.length-1].input)
     return {success:false,error:{code:'STATE_MISMATCH'}};
    let gaps=['review-selection-required'];
    if(parsed.data.review){
     const reviewed=ReviewedReceiptResultSchema.parse(await this.dependencies.review.execute({plan:validated.data,turnId:last.turnId,...parsed.data.review}));
     if(!reviewed.success)return {success:false,error:{code:'DEPENDENCY_FAILED'}};
     if(reviewed.data.kind==='awaiting-review')gaps=reviewed.data.gaps;
     else{
      const receipt=reviewed.data.receipt;
      if(receipt.turnId!==last.turnId||receipt.jobId!==observation.binding.jobId||receipt.responseArtifactRef!==artifact.ref||
       receipt.requestId!==observation.binding.requestId||receipt.sessionId!==observation.binding.sessionId||JSON.stringify(receipt.target)!==JSON.stringify(observation.binding.target)||
       receipt.kind!=='terminal'||receipt.jobState!==observation.job.state||receipt.jobDeadlineAtMs!==observation.jobDeadlineAtMs||
       JSON.stringify(receipt.preparation)!==JSON.stringify(observation.preparation)||
       JSON.stringify(receipt.ledger)!==JSON.stringify({reservationId:observation.ledger.id,state:observation.ledger.detail.settled?'settled':'reserved',costMicroUsd:observation.ledger.detail.costMicroUsd??null}))
       return {success:false,error:{code:'STATE_MISMATCH'}};
      const recorded=ControllerResultSchema.parse(await this.dependencies.controller.execute({action:'record',plan,receipt}));
      if(!recorded.success||!['recorded','halted'].includes(recorded.data.kind))return {success:false,error:{code:'DEPENDENCY_FAILED'}};
      if(recorded.data.kind==='recorded'||recorded.data.kind==='halted')return {success:true,data:recorded.data};
     }
    }
    return {success:true,data:{kind:'awaiting-review',turnId:last.turnId,artifactRef:captured.data.artifact.ref,gaps}};
   }
   if(parsed.data.action==='advance'){
    const turn=turns[state?.entries.length??0];
    if(!turn)return {success:true,data:{kind:'advance-observed',outcome:HttpResultSchema.parse(await this.dependencies.http.execute({action:'advance',plan}))}};
    const execution=plan.phases.flatMap(phase=>phase.executions).find(item=>item.turns.some(item=>item.id===turn.id))!;
    let prepared=BootstrapResultSchema.parse(await this.dependencies.bootstrap.execute({action:'ensure-session',plan,executionId:execution.id}));
    if(prepared.success&&prepared.data.kind==='awaiting-reconciliation')prepared=BootstrapResultSchema.parse(await this.dependencies.bootstrap.execute({action:'reconcile',plan,executionId:execution.id}));
    if(!prepared.success||prepared.data.kind!=='session-recorded')return {success:true,data:{kind:'bootstrap-observed',outcome:prepared}};
    const {intent,observation}=prepared.data.record;
    if(prepared.data.executionId!==execution.id||intent.executionId!==execution.id||intent.runId!==plan.request.runId||
     intent.planHash!==terminalEvidenceHash(plan)||intent.actorUserId!==plan.request.actorUserId||JSON.stringify(intent.target)!==JSON.stringify(plan.request.target)||
     intent.mode!==(execution.phase==='m6-published'?'published':'evaluation')||observation.intentHash!==terminalEvidenceHash(intent)||observation.observedAtMs<intent.createdAtMs||
     observation.session.versionId!==intent.target.versionId||observation.session.label!==intent.label||observation.session.scenario!==intent.scenario||
     turn.afterAuditedTerminalTurnId!==null&&observation.session.id!==last?.admission.sessionId)
     return {success:false,error:{code:'STATE_MISMATCH'}};
    return {success:true,data:{kind:'advance-observed',outcome:HttpResultSchema.parse(await this.dependencies.http.execute({action:'advance',plan,expectedTurnId:turn.id}))}};
   }
   return {success:false,error:{code:'DEPENDENCY_FAILED'}};
  }catch{return {success:false,error:{code:'DEPENDENCY_FAILED'}};}
 }
}
