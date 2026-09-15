import { Sprint4CampaignPlanner } from './sprint4-campaign.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EvidenceStorageResultSchema, compareEvidenceTimestamps, terminalEvidenceHash, type EvidenceStorageSpec, type TerminalArtifact } from './sprint4-evidence.spec.js';
import { ReviewPacketInputSchema, ReviewPacketSchema, type ReviewCheck, type ReviewPacketResult, type ReviewPacketSpec } from './sprint4-review-packet.spec.js';

type Code=Extract<ReviewPacketResult,{success:false}>['error']['code'];
const fail=(code:Code):ReviewPacketResult=>({success:false,error:{code}});
/** Partial mechanical review only. Reads archived observations; never emits a Receipt or assigns human ratings. */
export class Sprint4ReviewPacket implements ReviewPacketSpec {
 constructor(private readonly storage:EvidenceStorageSpec){}
 async execute(raw:unknown):Promise<ReviewPacketResult>{
  try{
   const parsed=ReviewPacketInputSchema.safeParse(raw);if(!parsed.success)return fail('INVALID_INPUT');
   const validated=new Sprint4CampaignPlanner().validate(parsed.data.plan);if(!validated.success)return fail('INVALID_PLAN');
   const plan=validated.data,execution=plan.phases.flatMap(p=>p.executions).find(e=>e.turns.some(t=>t.id===parsed.data.turnId));
   if(!execution)return fail('INVALID_INPUT');
   const turn=execution.turns.find(t=>t.id===parsed.data.turnId)!;
   const artifacts:TerminalArtifact[]=[];
   for(const expected of execution.turns.filter(t=>t.turn<=turn.turn)){
    const result=EvidenceStorageResultSchema.parse(await this.storage.execute({action:'read',runId:plan.request.runId,turnId:expected.id}));
    if(!result.success||result.data.kind!=='read')return fail('DEPENDENCY_FAILED');
    if(!result.data.artifact)return fail('MISSING_ARTIFACT');
    const artifact=result.data.artifact,o=artifact.payload.observation,a=artifact.payload.admission,previous=artifacts.at(-1)?.payload.observation;
    if(artifact.payload.planHash!==terminalEvidenceHash(plan)||o.binding.runId!==plan.request.runId||o.binding.turnId!==expected.id||
     o.binding.actorUserId!==plan.request.actorUserId||JSON.stringify(o.binding.target)!==JSON.stringify(plan.request.target)||o.input.text!==expected.input||
     (previous?o.binding.sessionId!==previous.binding.sessionId||o.binding.candidateId!==previous.binding.candidateId||a.sessionFresh||
      o.binding.requestId===previous.binding.requestId||o.binding.jobId===previous.binding.jobId||o.ledger.id===previous.ledger.id||
      o.memory.revision<=previous.memory.revision||compareEvidenceTimestamps(new Date(a.observedAtMs).toISOString(),previous.observedAt)<0:!a.sessionFresh))return fail('EVIDENCE_MISMATCH');
    artifacts.push(artifact);
   }
   const checks:ReviewCheck[]=[
    {id:'O1',status:'partial',verified:['archived-rendered-dto'],findings:[],pending:['pinned-snapshot-and-original-output-contract','provider-response-model','human-question-count-and-usefulness']},
    {id:'O2',status:'pending-human',verified:[],findings:[],pending:['human-intent-and-independent-answer-review']},
    {id:'O3',status:'partial',verified:[],findings:[],pending:['semantic-attribution-and-extraction-review','external-isolation-proof']},
    {id:'O4',status:'pending-human',verified:[],findings:[],pending:['pinned-sources-and-financial-contract','human-commercial-review']},
    {id:'O5',status:'partial',verified:[],findings:[],pending:['fact-projection-updated-at-not-retained','human-conflict-wording-review']},
    {id:'O6',status:'partial',verified:['bound-persisted-response-set'],findings:[],pending:['commit-and-visible-browser-timing','global-channels-deliveries-briefings-and-concurrency']},
    {id:'O7',status:'partial',verified:[],findings:[],pending:['global-ledger-and-provider-execution']},
    {id:'O8',status:'pending-human',verified:[],findings:[],pending:['human-quality-review','original-provider-response-unavailable']},
   ];
   const check=(id:ReviewCheck['id'])=>checks.find(c=>c.id===id)!;
   const findingsByTurn:{criterion:ReviewCheck['id'];code:string;turnId:string;artifactRef:string}[]=[];
   for(const [index,artifact] of artifacts.entries()){
    const priorCounts=checks.map(c=>c.findings.length);
    const o=artifact.payload.observation,quality=check('O8');
    if(compareEvidenceTimestamps(o.job.completed_at,o.job.deadline)>0)check('O6').findings.push('terminal-row-after-deadline');
    else check('O6').verified.push('terminal-row-within-deadline-not-render-time');
    if(o.guard.detail.modelGuardPassed===false)quality.findings.push('model-guard-rejected');
    if(!o.guard.detail.guardPassed)quality.findings.push('final-guard-rejected');
    quality.findings.push(...o.guard.detail.guardViolations??[],...o.guard.detail.originalGuardViolations??[]);
    const r=o.ledger.detail,u=o.job.usage,inputTokens=u.input_tokens,outputTokens=u.output_tokens;
    const reservationId='lab-budget:'+createHash('sha256').update(`${r.gateId}:${o.binding.jobId}:${r.attempt}`).digest('hex');
    if(!r.settled||o.ledger.id!==reservationId||inputTokens===undefined||outputTokens===undefined||inputTokens<=0||outputTokens<=0||outputTokens>1200||
     inputTokens>r.inputTokenBound||r.inputTokens!==inputTokens||r.outputTokens!==outputTokens||u.total_tokens!==undefined&&u.total_tokens!==inputTokens+outputTokens||
     r.costMicroUsd!==Math.ceil(inputTokens*2.5+outputTokens*15)||r.reservedMicroUsd!==Math.ceil(r.inputTokenBound*2.5+1200*15)||
     r.costMicroUsd>r.reservedMicroUsd||r.reservedMicroUsd>artifact.payload.admission.budget.maxReservationMicroUsd)check('O7').findings.push('ledger-arithmetic-or-bound-mismatch');
    else check('O7').verified.push('reservation-and-settlement-arithmetic');
    const messages=artifacts.slice(0,index+1).map(item=>item.payload.observation.input),facts=o.memory.facts,relations=o.memory.relations;
    const references=[...facts,...relations,...(o.memory.lead.referral?[o.memory.lead.referral]:[])];
    if(references.some(item=>!messages.some(m=>m.id===item.evidence.messageId&&m.text.includes(item.evidence.quote))))check('O3').findings.push('canonical-citation-missing');
    else if(references.length)check('O3').verified.push('canonical-citations-in-archived-inputs');
    if(facts.some(f=>f.status==='confirmed'||f.confirmedBy!==null))check('O3').findings.push('unverified-human-confirmation');
    if(new Set(facts.map(f=>f.id)).size!==facts.length||new Set(relations.map(r=>r.id)).size!==relations.length)check('O3').findings.push('duplicate-memory-id');
    const sorted=<T extends {id:string}>(items:T[])=>[...items].sort((a,b)=>a.id.localeCompare(b.id));
    if(!isDeepStrictEqual(sorted(facts),sorted(o.memory.lead.facts))||!isDeepStrictEqual(sorted(relations),sorted(o.memory.lead.relations)))check('O3').findings.push('memory-projection-mismatch');
    const previous=artifacts[index-1]?.payload.observation.memory;
    if(previous){
     if(previous.facts.some(f=>!facts.some(current=>isDeepStrictEqual(current,f)))||previous.relations.some(r=>!relations.some(current=>isDeepStrictEqual(current,r))))check('O5').findings.push('prior-memory-dto-changed-or-missing');
     else check('O5').verified.push('prior-fact-and-relation-dtos-retained');
    }else check('O5').pending.push('pre-first-turn-memory-not-archived');
    checks.forEach((c,i)=>{for(const code of new Set(c.findings.slice(priorCounts[i])))findingsByTurn.push({criterion:c.id,code,turnId:o.binding.turnId,artifactRef:artifact.ref});});
   }
   for(const item of checks){item.verified=[...new Set(item.verified)];item.findings=[...new Set(item.findings)];if(item.findings.length)item.status='findings';}
   return {success:true,data:ReviewPacketSchema.parse({kind:'sprint4-review-packet-v1',planHash:terminalEvidenceHash(plan),executionId:execution.id,caseId:execution.caseId,
    throughTurn:turn.turn,allTurnsArchived:artifacts.length===execution.turns.length,objectiveAudit:'pending',readyForReceipt:false,
    humanReview:{status:'pending',evaluatorId:null,scores:null,reviewedAt:null},artifacts,checks,findingsByTurn})};
  }catch{return fail('DEPENDENCY_FAILED');}
 }
}
