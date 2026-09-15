import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sprint4ReviewedReceipt } from '../evaluations/sprint4-reviewed-receipt.js';
import { evidenceFixture } from './sprint4-evidence-fixture.js';
import { CriteriaArtifactSchema, ReviewedReceiptPackageSchema, type CriterionEvidenceBinding, type ReviewedReceiptDependencies } from '../evaluations/sprint4-reviewed-receipt.spec.js';
import { EvidenceStorageInputSchema, TerminalArtifactSchema, terminalEvidenceHash, type TerminalArtifact } from '../evaluations/sprint4-evidence.spec.js';
import { ConversationReviewRecordSchema } from '../src/conversation-review.spec.js';
import { Sprint4ReviewPacket } from '../evaluations/sprint4-review-packet.js';

const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?
 '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const targetHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function reviewFor(artifacts:TerminalArtifact[]){
 const last=artifacts.at(-1)!.payload.observation,actorUserId='synthetic-human',idempotencyKey='33333333-3333-4333-8333-333333333333';
 const target={kind:'sprint4-conversation-target-v1',tenantId:'cognita-homologacao',brandId:'sapore',conversationId:last.binding.sessionId,
  candidateId:last.binding.candidateId,selectedJobId:last.binding.jobId,turns:artifacts.map(({payload:{observation:o}})=>({
   jobId:o.binding.jobId,versionId:o.job.version_id,contentHash:o.binding.target.contentHash,model:o.binding.target.model,status:o.job.state,
   completedAt:o.job.completed_at,triggerMessageId:o.input.id,responseMessageIds:o.response.map(m=>m.id),sources:[],excludedSources:[],
   guardCodes:[...new Set([...(o.job.error_code?[o.job.error_code]:[]),...o.guard.detail.guardViolations??[],...o.guard.detail.originalGuardViolations??[]])].sort(),memoryBefore:null,
  })),messages:artifacts.flatMap(({payload:{observation:o}})=>[o.input,...o.response].map(m=>({id:m.id,actor:m.actor,type:m.type,text:m.text,createdAt:m.created_at,jobId:o.binding.jobId}))),limitations:['synthetic-no-private-context']};
 return ConversationReviewRecordSchema.parse({kind:'sprint4-human-review-v1',rubric:'sprint4-conversation-v1',id:'s4-review:'+targetHash([target.tenantId,target.brandId,target.conversationId,actorUserId,idempotencyKey]),
  jobId:last.binding.jobId,targetHash:targetHash(target),idempotencyKey,scores:{intentContext:5,commercialFidelity:5,clarityNaturalness:5,nextStepUtility:5},
  notes:'SYNTHETIC fixture: no real human judgment.',actorUserId,reviewedAt:new Date(6000).toISOString(),target});
}

/** All fixtures are synthetic DTOs: no provider call or human approval occurred. */
function fixture(){
 const f=evidenceFixture();
 const dependencies:ReviewedReceiptDependencies={storage:{execute:async()=>({success:true,data:{kind:'read',artifact:null}})},
  reviews:{read:async()=>null},criteria:{read:async()=>null,verifyEvidence:async()=>false}};
 return {...f,dependencies,input:{plan:f.plan,turnId:f.turn.id,reviewId:'synthetic-review',criteriaArtifactRef:'criteria-sha256:'+'b'.repeat(64)}};
}
function secondArtifact(f:ReturnType<typeof fixture>,first:TerminalArtifact):TerminalArtifact{
 const a=structuredClone(first),o=a.payload.observation,admission=a.payload.admission,turn=f.plan.phases[0].executions[0].turns[1];
 o.binding.turnId=admission.turnId=turn.id;o.binding.requestId=admission.requestId='22222222-2222-4222-8222-222222222222';
 o.binding.jobId=o.job.id=o.guard.detail.jobId=o.ledger.detail.jobId='synthetic-job-2';
 o.input.id=o.job.trigger_message_id=o.binding.sessionId+':'+o.binding.requestId;o.input.text=turn.input;o.response[0].id=o.binding.jobId+':reply:0';
 o.ledger.id=o.preparation.reservationId='lab-budget:'+createHash('sha256').update('sprint3-continuous-20260910:'+o.binding.jobId+':1').digest('hex');
 admission.sessionFresh=false;admission.observedAtMs=3100;admission.validUntilMs=4000;
 o.job.created_at=o.input.created_at=new Date(3500).toISOString();o.ledger.created_at=new Date(3600).toISOString();
 o.job.completed_at=o.guard.created_at=o.response[0].created_at=new Date(4500).toISOString();o.observedAt=new Date(5000).toISOString();
 o.job.context_version=o.memory.revision=2;a.sha256=terminalEvidenceHash(a.payload);a.ref='terminal-sha256:'+a.sha256;
 return TerminalArtifactSchema.parse(a);
}
async function judgedFixture(withSecond=false){
 const f=fixture(),artifact=TerminalArtifactSchema.parse(f.artifact),artifacts=[artifact];
 if(withSecond)artifacts.push(secondArtifact(f,artifact));
 const review=reviewFor(artifacts),turnId=artifacts.at(-1)!.payload.observation.binding.turnId;
 f.dependencies.storage.execute=async raw=>{
  const input=EvidenceStorageInputSchema.parse(raw);assert.equal(input.action,'read');if(input.action!=='read')throw new Error('Read only');
  return {success:true,data:{kind:'read',artifact:artifacts.find(a=>a.payload.observation.binding.turnId===input.turnId)??null}};
 };
 f.dependencies.reviews.read=async()=>structuredClone(review);
 const packet=await new Sprint4ReviewPacket(f.dependencies.storage).execute({plan:f.plan,turnId});assert.ok(packet.success);
 const proofs=new Map<string,{kind:string;binding:CriterionEvidenceBinding}>();
 const payload={kind:'sprint4-criteria-v1',planHash:packet.data.planHash,executionId:packet.data.executionId,turnId,
  reviewId:review.id,reviewTargetHash:review.targetHash,assessedAt:new Date(7000).toISOString(),turns:artifacts.map((a,index)=>({turnId:a.payload.observation.binding.turnId,artifactRef:a.ref,
   criteria:packet.data.checks.map(check=>{
    const assessor={kind:'human' as const,actorUserId:review.actorUserId};
    return {id:check.id,status:'passed',assessor,notes:'SYNTHETIC adjudication for local contract test only.',evidence:check.pending.filter(item=>index===0||item!=='pre-first-turn-memory-not-archived').map(obligation=>{
     const binding={planHash:packet.data.planHash,executionId:packet.data.executionId,turnId:a.payload.observation.binding.turnId,artifactRef:a.ref,
      reviewId:review.id,reviewTargetHash:review.targetHash,criterion:check.id,obligation,assessor,
      judgment:{status:'passed' as const,notes:'SYNTHETIC adjudication for local contract test only.',assessedAt:new Date(7000).toISOString()}};
     const proof={kind:'synthetic-proof-only',binding},sha256=terminalEvidenceHash(proof),ref='proof-sha256:'+sha256;proofs.set(ref,proof);
     return {obligation,ref,sha256};
    })};
   })}))};
 const sha256=terminalEvidenceHash(payload),criteria=CriteriaArtifactSchema.parse({ref:'criteria-sha256:'+sha256,sha256,payload});
 f.dependencies.criteria.read=async()=>structuredClone(criteria);
 f.dependencies.criteria.verifyEvidence=async request=>{
  const proof=proofs.get(request.ref);return !!proof&&terminalEvidenceHash(proof)===request.sha256&&canonical(proof.binding)===canonical(request.binding);
 };
 return {...f,artifact,artifacts,review,criteria,proofs,input:{...f.input,turnId,reviewId:review.id,criteriaArtifactRef:criteria.ref}};
}
test('missing archived terminal evidence stays awaiting review',async()=>{
 const f=fixture();
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute(f.input),
  {success:true,data:{kind:'awaiting-review',turnId:f.turn.id,gaps:['terminal-artifact-missing']}});
});
test('an archived terminal and passed guards do not replace a persisted human review',async()=>{
 const f=fixture();
 f.dependencies.storage.execute=async()=>({success:true,data:{kind:'read',artifact:TerminalArtifactSchema.parse(f.artifact)}});
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute(f.input),
  {success:true,data:{kind:'awaiting-review',turnId:f.turn.id,gaps:['human-review-missing']}});
});
test('four high human ratings alone leave archived O1–O8 criteria pending',async()=>{
 const f=fixture(),artifact=TerminalArtifactSchema.parse(f.artifact),review=reviewFor([artifact]);
 f.dependencies.storage.execute=async()=>({success:true,data:{kind:'read',artifact}});
 f.dependencies.reviews.read=async()=>review;
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,reviewId:review.id}),
  {success:true,data:{kind:'awaiting-review',turnId:f.turn.id,gaps:['criteria-artifact-missing']}});
});
test('review target must retain its own canonical digest and the exact archived identity, messages, pins and guards',async()=>{
 for(const change of ['digest','candidate','job','version','model','contentHash','input','response','missing-message','future-message','timestamp','guards','actor']){
  const f=fixture(),artifact=TerminalArtifactSchema.parse(f.artifact),review=reviewFor([artifact]);
  if(change==='digest')review.targetHash='f'.repeat(64);
  if(change==='candidate')review.target.candidateId='other-candidate';
  if(change==='job')review.target.turns[0].jobId='other-job';
  if(change==='version')review.target.turns[0].versionId='other-version';
  if(change==='model')review.target.turns[0].model='other-model';
  if(change==='contentHash')review.target.turns[0].contentHash='c'.repeat(64);
  if(change==='input')review.target.messages[0].text='Other candidate input';
  if(change==='response')review.target.messages[1].text='Other response';
  if(change==='missing-message')review.target.messages.shift();
  if(change==='future-message')review.target.messages.push({...review.target.messages[1],id:'future-reply'});
  if(change==='timestamp')review.target.messages[1].createdAt='1970-01-01T00:00:02.500001Z';
  if(change==='guards')review.target.turns[0].guardCodes=['invented-guard'];
  if(change==='actor')review.actorUserId='other-human';
  if(change!=='digest')review.targetHash=targetHash(review.target);
  f.dependencies.storage.execute=async()=>({success:true,data:{kind:'read',artifact}});
  f.dependencies.reviews.read=async()=>review;
  const result=await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,reviewId:review.id});
  assert.deepEqual(result,{success:false,error:{code:'EVIDENCE_MISMATCH'}},change);
 }
});
test('archived criteria must verify their digest and bind this exact plan, review and terminal prefix',async()=>{
 for(const variant of ['digest','plan','execution','turn','review','target','artifact','assessment-time']){
  const f=await judgedFixture(),c=f.criteria;
  if(variant==='digest')c.sha256='d'.repeat(64);
  if(variant==='plan')c.payload.planHash='e'.repeat(64);
  if(variant==='execution')c.payload.executionId='other-execution';
  if(variant==='turn')c.payload.turnId='other-turn';
  if(variant==='review')c.payload.reviewId='other-review';
  if(variant==='target')c.payload.reviewTargetHash='e'.repeat(64);
  if(variant==='artifact')c.payload.turns[0].artifactRef='terminal-sha256:'+'e'.repeat(64);
  if(variant==='assessment-time')c.payload.assessedAt=new Date(1).toISOString();
  if(variant!=='digest'){c.sha256=terminalEvidenceHash(c.payload);c.ref='criteria-sha256:'+c.sha256;}
  const result=await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,criteriaArtifactRef:c.ref});
  assert.deepEqual(result,{success:false,error:{code:'EVIDENCE_MISMATCH'}},variant);
 }
});
test('a genuine repaired-output guard finding yields a durable negative receipt even without a review',async()=>{
 const f=fixture(),artifact=TerminalArtifactSchema.parse(f.artifact);
 artifact.payload.observation.guard.detail.modelGuardPassed=false;
 artifact.payload.observation.guard.detail.originalGuardViolations=['unsupported_commercial_number'];
 artifact.sha256=terminalEvidenceHash(artifact.payload);artifact.ref='terminal-sha256:'+artifact.sha256;
 f.dependencies.storage.execute=async()=>({success:true,data:{kind:'read',artifact}});
 const service=new Sprint4ReviewedReceipt(f.dependencies),result=await service.execute(f.input);
 assert.ok(result.success&&result.data.kind==='halted',JSON.stringify(result));
 assert.ok(result.data.findings.includes('O8:unsupported_commercial_number'));
 assert.equal(result.data.receipt?.objectiveAudit,'failed');
 assert.equal(result.data.receipt?.evidenceRef,artifact.ref);
 assert.deepEqual(await service.execute({plan:f.plan,turnId:f.turn.id,receipt:result.data.receipt}),result);
});
test('criteria need explicit human judgments and independently verified evidence for every pending obligation',async()=>{
 for(const variant of ['pending','missing-assessor','system-semantic','other-human','missing-evidence','missing-proof','false-verifier','changed-judgment']){
  const f=await judgedFixture(),criterion=f.criteria.payload.turns[0].criteria[0];
  if(variant==='pending')criterion.status='pending';
  if(variant==='missing-assessor')criterion.assessor=null;
  if(variant==='system-semantic')criterion.assessor={kind:'system',systemId:'synthetic-system'};
  if(variant==='other-human')criterion.assessor={kind:'human',actorUserId:'other-human'};
  if(variant==='missing-evidence')criterion.evidence.pop();
  if(variant==='missing-proof')f.proofs.delete(criterion.evidence[0].ref);
  if(variant==='false-verifier')f.dependencies.criteria.verifyEvidence=async()=>false;
  if(variant==='changed-judgment')criterion.notes='Different judgment not attested by this proof';
  f.criteria.sha256=terminalEvidenceHash(f.criteria.payload);f.criteria.ref='criteria-sha256:'+f.criteria.sha256;
  const result=await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,criteriaArtifactRef:f.criteria.ref});
  assert.ok(result.success&&result.data.kind==='awaiting-review',variant+': '+JSON.stringify(result));assert.ok(result.data.gaps.length>0);
 }
});
test('fully bound synthetic judgments derive a deterministic receipt and immutable package, not final acceptance',async()=>{
 const f=await judgedFixture(),service=new Sprint4ReviewedReceipt(f.dependencies),result=await service.execute(f.input);
 assert.ok(result.success&&result.data.kind==='receipt',JSON.stringify(result));
 assert.equal(result.data.receipt.evidenceRef,f.criteria.ref);assert.equal(result.data.receipt.responseArtifactRef,f.artifact.ref);
 assert.equal(result.data.receipt.rawArtifactRef,null,'Supplemental proof references must not masquerade as retained provider raw');
 assert.equal(result.data.receipt.objectiveAudit,'passed');assert.equal(result.data.receipt.ledger.costMicroUsd,400);
 assert.equal(result.data.package.payload.humanSample,'partial-execution');assert.equal(result.data.package.payload.acceptance,'pending');
 assert.equal(result.data.package.payload.packet.objectiveAudit,'pending');assert.equal(result.data.package.payload.packet.readyForReceipt,false);
 assert.deepEqual(result.data.package.payload.review,f.review);assert.ok(Object.isFrozen(result.data.package.payload.review));
 assert.notEqual(f.review.targetHash,f.artifact.sha256);assert.ok(ReviewedReceiptPackageSchema.safeParse(result.data.package).success);
 const altered=structuredClone(result.data.package);altered.payload.review.notes='Altered human judgment';
 assert.equal(ReviewedReceiptPackageSchema.safeParse(altered).success,false);
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute(f.input),result);
});
test('a bound human failed criterion remains a negative receipt despite high scores and other pending judgments',async()=>{
 const f=await judgedFixture(),criterion=f.criteria.payload.turns[0].criteria.find(c=>c.id==='O2')!;
 criterion.status='failed';
 for(const evidence of criterion.evidence){
  const proof=structuredClone(f.proofs.get(evidence.ref)!);proof.binding.judgment.status='failed';
  evidence.sha256=terminalEvidenceHash(proof);evidence.ref='proof-sha256:'+evidence.sha256;f.proofs.set(evidence.ref,proof);
 }
 f.criteria.payload.turns[0].criteria.find(c=>c.id==='O7')!.status='pending';
 f.criteria.sha256=terminalEvidenceHash(f.criteria.payload);f.criteria.ref='criteria-sha256:'+f.criteria.sha256;
 const result=await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,criteriaArtifactRef:f.criteria.ref});
 assert.ok(result.success&&result.data.kind==='halted',JSON.stringify(result));
 assert.deepEqual(result.data.findings,['O2:judgment-failed']);assert.equal(result.data.receipt.objectiveAudit,'failed');
 assert.equal(result.data.receipt.evidenceRef,f.criteria.ref);
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute({plan:f.plan,turnId:f.turn.id,receipt:result.data.receipt}),result);
});
test('resume rereads durable sources and accepts only an exactly rederived receipt',async()=>{
 const f=await judgedFixture(),result=await new Sprint4ReviewedReceipt(f.dependencies).execute(f.input);
 assert.ok(result.success&&result.data.kind==='receipt');
 const resume={plan:f.plan,turnId:f.turn.id,receipt:result.data.receipt};
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute(resume),result);
 for(const change of ['audit','cost','id','notes']){
  const altered=structuredClone(resume);
  if(change==='audit')altered.receipt.objectiveAudit='failed';
  if(change==='cost')altered.receipt.ledger.costMicroUsd=0;
  if(change==='id')altered.receipt.receiptId='forged-receipt';
  if(change==='notes')f.review.notes='Mutated persisted review record';
  assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute(altered),{success:false,error:{code:'EVIDENCE_MISMATCH'}},change);
 }
});
test('T2 includes the exact T1 prefix and per-turn criteria; a T1 rating cannot stand in for the full execution',async()=>{
 const f=await judgedFixture(true),result=await new Sprint4ReviewedReceipt(f.dependencies).execute(f.input);
 assert.ok(result.success&&result.data.kind==='receipt',JSON.stringify(result));
 assert.equal(result.data.package.payload.humanSample,'complete-execution');assert.equal(result.data.package.payload.packet.throughTurn,2);
 assert.deepEqual(result.data.package.payload.packet.artifacts,f.artifacts);assert.equal(result.data.package.payload.review.target.turns.length,2);
 assert.deepEqual(result.data.package.payload.review.target.messages.map(m=>m.id),f.artifacts.flatMap(a=>[a.payload.observation.input.id,...a.payload.observation.response.map(m=>m.id)]));
 for(const variant of ['t1-body','t1-omitted','t1-review','turn-order','prior-criteria-missing','prior-judgment-pending','archive-missing']){
  const altered=await judgedFixture(true);
  if(variant==='t1-body')altered.review.target.messages[1].text='Changed T1 answer';
  if(variant==='t1-omitted'){altered.review.target.turns.shift();altered.review.target.messages.splice(0,2);}
  if(variant==='t1-review')altered.dependencies.reviews.read=async()=>reviewFor([altered.artifacts[0]]);
  if(variant==='turn-order')altered.review.target.turns.reverse();
  if(variant==='prior-criteria-missing')altered.criteria.payload.turns.shift();
  if(variant==='prior-judgment-pending')altered.criteria.payload.turns[0].criteria[0].status='pending';
  if(variant==='archive-missing')altered.artifacts.shift();
  altered.review.targetHash=targetHash(altered.review.target);
  altered.criteria.sha256=terminalEvidenceHash(altered.criteria.payload);altered.criteria.ref='criteria-sha256:'+altered.criteria.sha256;
  const rejected=await new Sprint4ReviewedReceipt(altered.dependencies).execute({...altered.input,criteriaArtifactRef:altered.criteria.ref});
  if(variant==='prior-judgment-pending'||variant==='archive-missing')assert.ok(rejected.success&&rejected.data.kind==='awaiting-review',variant);
  else assert.deepEqual(rejected,{success:false,error:{code:'EVIDENCE_MISMATCH'}},variant);
 }
});
test('strict commands reject caller decisions and dependency failures never become an approval',async()=>{
 const f=await judgedFixture();
 for(const extra of [{passed:true},{scores:f.review.scores},{actorUserId:f.review.actorUserId},{objectiveAudit:'passed'}])
  assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,...extra}),{success:false,error:{code:'INVALID_INPUT'}});
 const altered=structuredClone(f.input);altered.plan.request.cases[0].inputs[0]='Not the approved matrix';
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute(altered),{success:false,error:{code:'INVALID_PLAN'}});
 f.dependencies.criteria.verifyEvidence=async()=>{throw new Error('private dependency detail must not escape');};
 assert.deepEqual(await new Sprint4ReviewedReceipt(f.dependencies).execute(f.input),{success:false,error:{code:'DEPENDENCY_FAILED'}});
});
test('unavailable provider raw stays an explicit gap without requiring invented proof when every substantive judgment is valid',async()=>{
 const f=await judgedFixture(),quality=f.criteria.payload.turns[0].criteria.find(c=>c.id==='O8')!;
 const unavailable=quality.evidence.find(e=>e.obligation==='original-provider-response-unavailable')!;
 quality.evidence=quality.evidence.filter(e=>e!==unavailable);f.proofs.delete(unavailable.ref);
 f.criteria.sha256=terminalEvidenceHash(f.criteria.payload);f.criteria.ref='criteria-sha256:'+f.criteria.sha256;
 const verified:string[]=[],verify=f.dependencies.criteria.verifyEvidence;
 f.dependencies.criteria.verifyEvidence=async request=>{verified.push(request.binding.obligation);return verify(request);};
 const result=await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,criteriaArtifactRef:f.criteria.ref});
 assert.ok(result.success&&result.data.kind==='receipt',JSON.stringify(result));
 assert.equal(result.data.receipt.rawArtifactRef,null);assert.equal(result.data.package.payload.acceptance,'pending');
 assert.deepEqual(result.data.package.payload.packet.artifacts[0].payload.rawArtifact,{status:'unavailable',reason:'not-retained-by-runtime'});
 assert.ok(result.data.package.payload.packet.checks.find(c=>c.id==='O8')!.pending.includes('original-provider-response-unavailable'));
 assert.ok(result.data.package.payload.limitations.includes('terminal-provider-raw-remains-unavailable-supplemental-proof-is-separate'));
 assert.ok(verified.includes('human-quality-review'));assert.equal(verified.includes('original-provider-response-unavailable'),false);
});
test('legacy raw-gap references remain unverified metadata and exact prior receipts can still be resumed',async()=>{
 const f=await judgedFixture(),before=await new Sprint4ReviewedReceipt(f.dependencies).execute(f.input);
 assert.ok(before.success&&before.data.kind==='receipt');
 // This deterministic package digest was recorded before the raw-applicability correction.
 assert.equal(before.data.receipt.receiptId,'s4-reviewed:479d1aa1d5164a165c9d0544dcd5f1129fb6726ac8bfb1b757c22928f619a42b');
 const legacy=f.criteria.payload.turns[0].criteria.find(c=>c.id==='O8')!.evidence.find(e=>e.obligation==='original-provider-response-unavailable')!;
 f.proofs.delete(legacy.ref);
 const verify=f.dependencies.criteria.verifyEvidence;
 f.dependencies.criteria.verifyEvidence=async request=>{
  assert.notEqual(request.binding.obligation,'original-provider-response-unavailable','Legacy metadata is not reclassified as raw proof');
  return verify(request);
 };
 const resumed=await new Sprint4ReviewedReceipt(f.dependencies).execute({plan:f.plan,turnId:f.turn.id,receipt:before.data.receipt});
 assert.deepEqual(resumed,before);
 assert.ok(before.data.package.payload.criteria.payload.turns[0].criteria.find(c=>c.id==='O8')!.evidence.some(e=>e.ref===legacy.ref));
 assert.equal(before.data.receipt.rawArtifactRef,null);
});
test('unavailable raw never replaces O8 human identity, judgment or verified quality evidence',async()=>{
 for(const variant of ['review-missing','assessor-missing','system-assessor','judgment-pending','quality-reference-missing','quality-proof-missing']){
  const f=await judgedFixture(),quality=f.criteria.payload.turns[0].criteria.find(c=>c.id==='O8')!;
  const humanProof=quality.evidence.find(e=>e.obligation==='human-quality-review')!;
  quality.evidence=quality.evidence.filter(e=>e.obligation!=='original-provider-response-unavailable');
  if(variant==='review-missing')f.dependencies.reviews.read=async()=>null;
  if(variant==='assessor-missing')quality.assessor=null;
  if(variant==='system-assessor')quality.assessor={kind:'system',systemId:'synthetic-system'};
  if(variant==='judgment-pending')quality.status='pending';
  if(variant==='quality-reference-missing')quality.evidence=[];
  if(variant==='quality-proof-missing')f.proofs.delete(humanProof.ref);
  f.criteria.sha256=terminalEvidenceHash(f.criteria.payload);f.criteria.ref='criteria-sha256:'+f.criteria.sha256;
  const result=await new Sprint4ReviewedReceipt(f.dependencies).execute({...f.input,criteriaArtifactRef:f.criteria.ref});
  assert.ok(result.success&&result.data.kind==='awaiting-review',variant+': '+JSON.stringify(result));
  assert.ok(result.data.gaps.length>0);
  assert.equal(result.data.gaps.some(gap=>gap.includes('original-provider-response-unavailable')),false);
 }
});
test('raw unavailability cannot erase final guards, original model guards, T1 findings or a verified failed quality judgment',async()=>{
 for(const variant of ['final-guard','model-guard','prior-guard','human-failed']){
  const f=await judgedFixture(variant==='prior-guard'),quality=f.criteria.payload.turns[0].criteria.find(c=>c.id==='O8')!;
  quality.evidence=quality.evidence.filter(e=>e.obligation!=='original-provider-response-unavailable');
  if(variant==='human-failed'){
   quality.status='failed';
   for(const evidence of quality.evidence){
    const proof=structuredClone(f.proofs.get(evidence.ref)!);proof.binding.judgment.status='failed';
    evidence.sha256=terminalEvidenceHash(proof);evidence.ref='proof-sha256:'+evidence.sha256;f.proofs.set(evidence.ref,proof);
   }
  }else{
   const artifact=f.artifacts[0],guard=artifact.payload.observation.guard.detail;
   if(variant==='final-guard')guard.guardPassed=false;
   if(variant==='model-guard')guard.modelGuardPassed=false;
   if(variant==='prior-guard')guard.originalGuardViolations=['unsupported_commercial_number'];
   artifact.sha256=terminalEvidenceHash(artifact.payload);artifact.ref='terminal-sha256:'+artifact.sha256;
  }
  f.criteria.sha256=terminalEvidenceHash(f.criteria.payload);f.criteria.ref='criteria-sha256:'+f.criteria.sha256;
  const service=new Sprint4ReviewedReceipt(f.dependencies),result=await service.execute({...f.input,criteriaArtifactRef:f.criteria.ref});
  assert.ok(result.success&&result.data.kind==='halted',variant+': '+JSON.stringify(result));
  assert.equal(result.data.receipt.objectiveAudit,'failed');assert.equal(result.data.receipt.rawArtifactRef,null);
  assert.deepEqual(await service.execute({plan:f.plan,turnId:f.input.turnId,receipt:result.data.receipt}),result);
 }
});
