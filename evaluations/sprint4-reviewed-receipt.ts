import { CriteriaArtifactSchema, ReviewedReceiptInputSchema, ReviewedReceiptPackageSchema, type ReviewedReceiptDependencies, type ReviewedReceiptResult, type Sprint4ReviewedReceiptSpec } from './sprint4-reviewed-receipt.spec.js';
import { Sprint4ReviewPacket } from './sprint4-review-packet.js';
import { ConversationReviewRecordSchema, type ConversationReviewRecord } from '../src/conversation-review.spec.js';
import { compareEvidenceTimestamps, terminalEvidenceHash, type TerminalArtifact } from './sprint4-evidence.spec.js';
import { ReceiptSchema, type Receipt } from './sprint4-controller.spec.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// The product target uses sorted-key canonical JSON; terminal/criteria archives use their
// own JSON.stringify digest. These are deliberately different hash domains.
const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?
 '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const targetDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function boundReview(review:ConversationReviewRecord,reviewId:string,artifacts:TerminalArtifact[]):boolean{
 const target=review.target,last=artifacts.at(-1)!.payload,scope=[target.tenantId,target.brandId,target.conversationId];
 if(review.id!==reviewId||review.id!=='s4-review:'+targetDigest([...scope,review.actorUserId,review.idempotencyKey])||
  targetDigest(target)!==review.targetHash||review.jobId!==last.observation.binding.jobId||target.selectedJobId!==review.jobId||
  target.tenantId!==last.admission.tenantId||target.brandId!==last.admission.brandId||target.conversationId!==last.admission.sessionId||
  target.candidateId!==last.observation.binding.candidateId||target.turns.length!==artifacts.length)return false;
 const messages=artifacts.flatMap(({payload:{observation:o}})=>[o.input,...o.response].map(m=>({id:m.id,actor:m.actor,type:m.type,text:m.text,createdAt:m.created_at,jobId:o.binding.jobId})))
  .sort((a,b)=>compareEvidenceTimestamps(a.createdAt,b.createdAt));
 if(target.messages.length!==messages.length||new Set(target.messages.map(m=>m.id)).size!==messages.length||messages.some((m,i)=>{
  const actual=target.messages[i];return actual.id!==m.id||actual.actor!==m.actor||actual.type!==m.type||actual.text!==m.text||actual.jobId!==m.jobId||
   compareEvidenceTimestamps(actual.createdAt,m.createdAt)!==0||compareEvidenceTimestamps(review.reviewedAt,m.createdAt)<0;
 }))return false;
 return artifacts.every(({payload:{observation:o}},index)=>{
  const turn=target.turns[index],codes=[...new Set([...(o.job.error_code?[o.job.error_code]:[]),...o.guard.detail.guardViolations??[],...o.guard.detail.originalGuardViolations??[]])].sort();
  return turn.jobId===o.binding.jobId&&turn.versionId===o.job.version_id&&turn.contentHash===o.binding.target.contentHash&&turn.model===o.binding.target.model&&
   turn.status===o.job.state&&compareEvidenceTimestamps(turn.completedAt,o.job.completed_at)===0&&compareEvidenceTimestamps(review.reviewedAt,turn.completedAt)>=0&&
   turn.triggerMessageId===o.input.id&&isDeepStrictEqual(turn.responseMessageIds,o.response.map(m=>m.id))&&isDeepStrictEqual([...turn.guardCodes].sort(),codes)&&
   o.job.result.sourceRefs.every(id=>turn.sources.some(source=>source.id===id))&&
   [...turn.memoryBefore?.facts??[],...turn.memoryBefore?.relations??[]].every(item=>artifacts.slice(0,index+1).some(a=>
    a.payload.observation.input.id===item.evidence.messageId&&a.payload.observation.input.text.includes(item.evidence.quote)));
 });
}
function deriveReceipt(artifact:TerminalArtifact,evidenceRef:string,digest:string,findings:string[]):Receipt{
 const o=artifact.payload.observation;
 return ReceiptSchema.parse({receiptId:'s4-reviewed:'+digest,turnId:o.binding.turnId,requestId:o.binding.requestId,sessionId:o.binding.sessionId,
  target:o.binding.target,observedAtMs:Date.parse(o.observedAt),kind:'terminal',jobId:o.binding.jobId,evidenceRef,jobState:o.job.state,
  guardCodes:[...new Set([...o.guard.detail.guardViolations??[],...o.guard.detail.originalGuardViolations??[]])].sort(),criticalCodes:findings,
  objectiveAudit:findings.length?'failed':'passed',ledger:{reservationId:o.ledger.id,state:o.ledger.detail.settled?'settled':'reserved',costMicroUsd:o.ledger.detail.costMicroUsd??null},
  responseArtifactRef:artifact.ref,rawArtifactRef:null,jobDeadlineAtMs:o.jobDeadlineAtMs,preparation:o.preparation});
}
function freezePackage(value:unknown):void{
 if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freezePackage(child);Object.freeze(value);}
}

/** Private, read-only bridge. It neither publishes nor records controller state. */
export class Sprint4ReviewedReceipt implements Sprint4ReviewedReceiptSpec {
 constructor(private readonly dependencies:ReviewedReceiptDependencies){}
 async execute(raw:unknown):Promise<ReviewedReceiptResult>{
  try{
   const parsed=ReviewedReceiptInputSchema.safeParse(raw);if(!parsed.success)return {success:false,error:{code:'INVALID_INPUT'}};
   const input=parsed.data,packet=await new Sprint4ReviewPacket(this.dependencies.storage).execute({plan:input.plan,turnId:input.turnId});
   if(!packet.success){
    if(packet.error.code==='MISSING_ARTIFACT')return {success:true,data:{kind:'awaiting-review',turnId:input.turnId,gaps:['terminal-artifact-missing']}};
    return {success:false,error:{code:packet.error.code}};
   }
   const findings=packet.data.checks.flatMap(check=>check.findings.map(code=>check.id+':'+code));
   if(findings.length){
    const terminal=packet.data.artifacts.at(-1)!,digest=terminalEvidenceHash({planHash:packet.data.planHash,artifacts:packet.data.artifacts.map(a=>a.ref),findings});
    const receipt=deriveReceipt(terminal,terminal.ref,digest,findings);
    if('receipt' in input&&!isDeepStrictEqual(input.receipt,receipt))return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
    return {success:true,data:{kind:'halted',turnId:input.turnId,findings,receipt}};
   }
   let review:ConversationReviewRecord|undefined;
   if('reviewId' in input){
    const rawReview=await this.dependencies.reviews.read(input.reviewId);
    if(rawReview===null)return {success:true,data:{kind:'awaiting-review',turnId:input.turnId,gaps:['human-review-missing']}};
    const parsedReview=ConversationReviewRecordSchema.safeParse(rawReview);
    if(!parsedReview.success||!boundReview(parsedReview.data,input.reviewId,packet.data.artifacts))
     return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
    review=parsedReview.data;
   }
   const criteriaRef='criteriaArtifactRef' in input?input.criteriaArtifactRef:input.receipt.evidenceRef;
   const rawCriteria=await this.dependencies.criteria.read(criteriaRef);
   if(rawCriteria===null)
    return {success:true,data:{kind:'awaiting-review',turnId:input.turnId,gaps:['criteria-artifact-missing']}};
   const criteria=CriteriaArtifactSchema.safeParse(rawCriteria);
   if(!criteria.success)return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
   if(!review){
    const rawReview=await this.dependencies.reviews.read(criteria.data.payload.reviewId);
    if(rawReview===null)return {success:true,data:{kind:'awaiting-review',turnId:input.turnId,gaps:['human-review-missing']}};
    const parsedReview=ConversationReviewRecordSchema.safeParse(rawReview);
    if(!parsedReview.success||!boundReview(parsedReview.data,criteria.data.payload.reviewId,packet.data.artifacts))return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
    review=parsedReview.data;
   }
   if(criteria.data.ref!==criteriaRef||criteria.data.payload.planHash!==packet.data.planHash||
    criteria.data.payload.executionId!==packet.data.executionId||criteria.data.payload.turnId!==input.turnId||criteria.data.payload.reviewId!==review.id||
    criteria.data.payload.reviewTargetHash!==review.targetHash||compareEvidenceTimestamps(criteria.data.payload.assessedAt,review.reviewedAt)<0||
    criteria.data.payload.turns.length!==packet.data.artifacts.length||criteria.data.payload.turns.some((turn,i)=>
     turn.turnId!==packet.data.artifacts[i].payload.observation.binding.turnId||turn.artifactRef!==packet.data.artifacts[i].ref))
    return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
   const gaps:string[]=[],criterionFindings:string[]=[];
   for(const [index,turn] of criteria.data.payload.turns.entries())for(const criterion of turn.criteria){
    const label=turn.turnId+':'+criterion.id;
    if(criterion.status==='pending'){gaps.push(label+':judgment-pending');continue;}
    const assessor=criterion.assessor,semantic=!['O6','O7'].includes(criterion.id);
    if(!assessor||semantic&&(assessor.kind!=='human'||assessor.actorUserId!==review.actorUserId)){
     gaps.push(label+':human-assessor-missing-or-mismatched');continue;
    }
    const obligations=packet.data.checks.find(c=>c.id===criterion.id)!.pending.filter(item=>index===0||item!=='pre-first-turn-memory-not-archived');
    if(criterion.evidence.some(item=>!obligations.includes(item.obligation)))return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
    // The approved plan retains provider raw when available; unavailable raw remains an
    // explicit packet gap, not a retroactive requirement. Legacy refs for this gap stay
    // unverified metadata: never proof of raw existence or a substitute for human O8.
    const requiredObligations=obligations.filter(obligation=>!(criterion.id==='O8'&&obligation==='original-provider-response-unavailable'&&
     packet.data.artifacts[index].payload.rawArtifact.status==='unavailable'));
    const missingBefore=gaps.length;
    for(const obligation of requiredObligations){
     const matching=criterion.evidence.filter(item=>item.obligation===obligation);
     if(matching.length!==1){gaps.push(label+':'+obligation+':proof-missing-or-duplicate');continue;}
     const evidence=matching[0],binding={planHash:packet.data.planHash,executionId:packet.data.executionId,turnId:turn.turnId,artifactRef:turn.artifactRef,
      reviewId:review.id,reviewTargetHash:review.targetHash,criterion:criterion.id,obligation,assessor,
      judgment:{status:criterion.status,notes:criterion.notes,assessedAt:criteria.data.payload.assessedAt}};
     if(await this.dependencies.criteria.verifyEvidence({ref:evidence.ref,sha256:evidence.sha256,binding})!==true)
      gaps.push(label+':'+obligation+':proof-unverified');
    }
    if(criterion.status==='failed'&&gaps.length===missingBefore)criterionFindings.push(criterion.id+':judgment-failed');
   }
   if(criterionFindings.length){
    const codes=[...new Set(criterionFindings)].sort(),digest=terminalEvidenceHash({packet:packet.data,review,criteria:criteria.data,findings:codes});
    const receipt=deriveReceipt(packet.data.artifacts.at(-1)!,criteria.data.ref,digest,codes);
    if('receipt' in input&&!isDeepStrictEqual(input.receipt,receipt))return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
    return {success:true,data:{kind:'halted',turnId:input.turnId,findings:codes,receipt}};
   }
   if(gaps.length)return {success:true,data:{kind:'awaiting-review',turnId:input.turnId,gaps}};
   const payload={kind:'sprint4-reviewed-receipt-package-v1',packet:packet.data,review,criteria:criteria.data,
    humanSample:packet.data.allTurnsArchived?'complete-execution':'partial-execution',acceptance:'pending',limitations:[
     'criteria-proof-source-must-authenticate-assessors-and-verify-bound-private-artifacts',
     'hashes-detect-content-change-not-authenticity-against-arbitrary-storage-writers',
     'terminal-provider-raw-remains-unavailable-supplemental-proof-is-separate',
     'per-turn-receipt-not-campaign-acceptance-or-publication','four-dimensional-scores-are-not-an-approval-threshold',
    ]};
   const sha256=terminalEvidenceHash(payload),bundle=ReviewedReceiptPackageSchema.parse({ref:'reviewed-receipt-sha256:'+sha256,sha256,payload});
   freezePackage(bundle);
   const receipt=deriveReceipt(packet.data.artifacts.at(-1)!,criteria.data.ref,bundle.sha256,[]);
   if('receipt' in input&&!isDeepStrictEqual(input.receipt,receipt))return {success:false,error:{code:'EVIDENCE_MISMATCH'}};
   return {success:true,data:{kind:'receipt',receipt,package:bundle}};
  }catch{return {success:false,error:{code:'DEPENDENCY_FAILED'}};}
 }
}
