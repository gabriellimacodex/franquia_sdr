import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { Queryable } from '../src/database.js';
import { AgentDecisionSchema, LeadFactSchema, LeadStateSchema, RelationProposalSchema } from '../src/domain.js';
import { SnapshotSchema } from '../src/engine.js';
import { snapshotHash } from '../src/versioning.js';
import { UsageSchema } from '../src/usage.js';
import { CampaignAdmissionSchema, CampaignAdmissionMarkerSchema } from '../src/campaign-admission.spec.js';
import { StoredControllerStateSchema, type CampaignJournal } from './sprint4-controller.spec.js';
import { Sprint4CampaignPlanner } from './sprint4-campaign.js';
import { AuditGuardSchema, AuditJobSchema, AuditMessageSchema, AuditReservationSchema, TerminalAuditErrorSchema, TerminalAuditInputSchema, TerminalAuditObservationSchema, type Sprint4TerminalAuditSpec, type TerminalAuditResult } from './sprint4-terminal-audit.spec.js';

const fail=(code:z.infer<typeof TerminalAuditErrorSchema>['code']):TerminalAuditResult=>({success:false,error:{code}});

const readSql=`WITH selected_session AS MATERIALIZED (
 SELECT l.*,c.state,c.epoch,c.candidate_id AS conversation_candidate_id,ch.kind AS channel_kind
 FROM sdr.lab_sessions l JOIN sdr.conversations c USING(tenant_id,brand_id,id)
 JOIN sdr.channels ch ON ch.phone_number_id=c.phone_number_id AND ch.tenant_id=l.tenant_id AND ch.brand_id=l.brand_id
 WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.owner_user_id=$3 AND l.id=$4
), selected_jobs AS MATERIALIZED (
 SELECT id,conversation_id,candidate_id,trigger_message_id,version_id,state,context_version,epoch,attempts,error_code,result,usage,created_at,completed_at,deadline
 FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND trigger_message_id=$5
)
SELECT to_jsonb(statement_timestamp()) AS observed_at,
 coalesce(current_setting('sdr.tenant_id',true)=$1 AND current_setting('sdr.brand_id',true)=$2,false) AS scope_ok,
 current_setting('transaction_read_only')='on' AS read_only,
 EXISTS(SELECT 1 FROM sdr.memberships WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3 AND active AND role='admin') AS admin_active,
 (SELECT to_jsonb(l) FROM selected_session l) AS session,
 coalesce((SELECT jsonb_agg(to_jsonb(j)) FROM selected_jobs j),'[]'::jsonb) AS jobs,
 coalesce((SELECT jsonb_agg(j.context->'campaignAdmission') FROM sdr.jobs j WHERE j.tenant_id=$1 AND j.brand_id=$2 AND j.id IN(SELECT id FROM selected_jobs)),'[]'::jsonb) AS admission_markers,
 (SELECT jsonb_build_object('id',p.id,'revision',p.revision,'lead_state',p.lead_state) FROM sdr.candidates p JOIN selected_session l ON p.id=l.candidate_id WHERE p.tenant_id=$1 AND p.brand_id=$2) AS candidate,
 (SELECT jsonb_build_object('id',v.id,'content_hash',v.content_hash,'model',v.model,'snapshot',v.snapshot) FROM sdr.versions v JOIN selected_session l ON v.id=l.version_id WHERE v.tenant_id=$1 AND v.brand_id=$2) AS version,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'conversation_id',m.conversation_id,'candidate_id',m.candidate_id,'actor',m.actor,'type',m.type,'text',m.text,'created_at',m.created_at) ORDER BY m.created_at,m.id)
  FROM sdr.messages m WHERE m.tenant_id=$1 AND m.brand_id=$2 AND (m.conversation_id=$4 OR m.id=$5 OR m.id IN(SELECT j.id||':reply:'||i FROM selected_jobs j CROSS JOIN generate_series(0,1) i))),'[]'::jsonb) AS messages,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'conversation_id',e.conversation_id,'created_at',e.created_at,'detail',e.detail)) FROM sdr.events e
  WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.type='turn_completed' AND e.detail->>'jobId' IN(SELECT id FROM selected_jobs)),'[]'::jsonb) AS guards,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'conversation_id',e.conversation_id,'created_at',e.created_at,'detail',e.detail)) FROM sdr.events e
  WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.type='lab_model_budget_reserved' AND e.detail->>'jobId' IN(SELECT id FROM selected_jobs)),'[]'::jsonb) AS reservations,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'conversation_id',e.conversation_id,'created_at',e.created_at,'detail',e.detail)) FROM sdr.events e
  WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.type='lab_campaign_admitted'
   AND (e.id IN(SELECT 'lab-campaign:'||id FROM selected_jobs) OR e.detail->>'jobId' IN(SELECT id FROM selected_jobs)
    OR e.detail->>'runId'=$7 AND e.detail->>'turnId'=$8)),'[]'::jsonb) AS admissions,
 coalesce((SELECT jsonb_agg(e.detail) FROM sdr.events e WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.conversation_id=$4 AND e.type='lab_evaluation_session_created'),'[]'::jsonb) AS evaluation,
 (SELECT e.id FROM sdr.publication_events e JOIN selected_session l ON e.version_id=l.version_id WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.content_hash=$6 AND e.created_at<=l.created_at ORDER BY e.created_at DESC,e.id LIMIT 1) AS publication_id,
 coalesce((SELECT jsonb_agg(f.data ORDER BY f.id) FROM sdr.facts f JOIN selected_session l ON f.candidate_id=l.candidate_id WHERE f.tenant_id=$1 AND f.brand_id=$2),'[]'::jsonb) AS facts,
 coalesce((SELECT jsonb_agg(r.data ORDER BY r.id) FROM sdr.relations r JOIN selected_session l ON r.candidate_id=l.candidate_id WHERE r.tenant_id=$1 AND r.brand_id=$2),'[]'::jsonb) AS relations`;

const RowSchema=z.object({observed_at:z.string(),scope_ok:z.boolean(),read_only:z.boolean(),admin_active:z.boolean(),
 session:z.object({id:z.string(),candidate_id:z.string(),conversation_candidate_id:z.string(),owner_user_id:z.string(),request_id:z.string(),version_id:z.string(),channel_kind:z.string(),state:z.string(),epoch:z.number().int()}).nullable(),
 jobs:z.array(AuditJobSchema),admission_markers:z.array(z.unknown()),candidate:z.object({id:z.string(),revision:z.number().int(),lead_state:LeadStateSchema}).nullable(),
 version:z.object({id:z.string(),content_hash:z.string(),model:z.string(),snapshot:z.unknown()}).nullable(),messages:z.array(AuditMessageSchema),
 guards:z.array(AuditGuardSchema),reservations:z.array(AuditReservationSchema),admissions:z.array(z.object({id:z.string(),conversation_id:z.string(),created_at:z.string(),detail:z.unknown()})),evaluation:z.array(z.unknown()),publication_id:z.string().nullable(),facts:z.array(LeadFactSchema),relations:z.array(RelationProposalSchema),
});

/** Private evidence only, never a controller Receipt or an objective/human approval.
 * Caller supplies a scoped READ ONLY transaction and durable journal reader; no defaults or sends.
 * A settled row corroborates the backend's model check, not independent provider execution.
 * Current membership/publication rows do not replace the runner's live authorization gates. */
export class Sprint4TerminalAudit implements Sprint4TerminalAuditSpec {
 constructor(private readonly tx:Queryable,private readonly journal:Pick<CampaignJournal,'read'>){}
 async execute(raw:unknown):Promise<TerminalAuditResult>{
  try{
   const parsed=TerminalAuditInputSchema.safeParse(raw);if(!parsed.success)return fail('INVALID_INPUT');
   const input=parsed.data,stored=await this.journal.read(input.runId);if(stored===null)return fail('INTENT_NOT_FOUND');
   const checked=StoredControllerStateSchema.safeParse(stored);if(!checked.success)return fail('INVALID_INTENT');
   const state=checked.data,canonical=new Sprint4CampaignPlanner().validate(state.plan);
   const entries=state.entries.map(entry=>({turnId:entry.turnId,intent:'admission' in entry?entry.admission:entry.preflight}));
   if(!canonical.success||state.plan.request.runId!==input.runId)return fail('INVALID_INTENT');
   const turns=state.plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns));
   if(entries.some((entry,index)=>entry.turnId!==turns[index]?.id||entry.intent.turnId!==entry.turnId||entry.intent.actorUserId!==state.plan.request.actorUserId||JSON.stringify(entry.intent.target)!==JSON.stringify(state.plan.request.target)))return fail('INVALID_INTENT');
   if(new Set(entries.map(entry=>entry.intent.requestId)).size!==entries.length||entries.some((entry,index)=>{
    const previousId=turns[index].afterAuditedTerminalTurnId,previous=entries.find(item=>item.turnId===previousId);
    return previousId?(!previous||entry.intent.sessionFresh||entry.intent.sessionId!==previous.intent.sessionId):
     (!entry.intent.sessionFresh||entries.slice(0,index).some(item=>item.intent.sessionId===entry.intent.sessionId));
   }))return fail('INVALID_INTENT');
   const entry=entries.find(item=>item.turnId===input.turnId);if(!entry)return fail('INTENT_NOT_FOUND');
   const preflight=entry.intent,plan=state.plan;
   const row=RowSchema.parse((await this.tx.query(readSql,[preflight.tenantId,preflight.brandId,plan.request.actorUserId,preflight.sessionId,preflight.sessionId+':'+preflight.requestId,plan.request.target.contentHash,input.runId,input.turnId])).rows[0]);
   if(!row.scope_ok||!row.read_only)return fail('UNSAFE_READ_CONTEXT');
   if(!row.admin_active||!row.session||row.session.channel_kind!=='laboratory'||!row.candidate||!row.version)return fail('BINDING_MISMATCH');
   if(row.jobs.length!==1)return fail('BINDING_MISMATCH');
   const job=row.jobs[0],candidate=row.candidate!,guard=row.guards[0],ledger=row.reservations[0];
   const session=row.session,target=plan.request.target,version=row.version,snapshot=SnapshotSchema.safeParse(version.snapshot);
   // Legacy is a historical read format, never a way to discard a persisted admission.
   if(!('protocol' in state)&&(row.admissions.length>0||row.admission_markers.some(marker=>marker!==null)))return fail('BINDING_MISMATCH');
   if('protocol' in state){
    const event=row.admissions[0],admission=CampaignAdmissionSchema.safeParse(event?.detail),marker=CampaignAdmissionMarkerSchema.safeParse(row.admission_markers[0]);
    if(row.admissions.length!==1||row.admission_markers.length!==1||!admission.success||!marker.success||
     event.id!=='lab-campaign:'+job.id||marker.data.id!==event.id||marker.data.contentHash!==createHash('sha256').update(JSON.stringify(admission.data)).digest('hex'))return fail('BINDING_MISMATCH');
    const admittedAtMs=new Date(event.created_at).getTime();
    if(!Number.isFinite(admittedAtMs)||admittedAtMs>=admission.data.submitBeforeMs)return fail('BINDING_MISMATCH');
    if(!('maxReservationMicroUsd' in preflight.budget)||event.conversation_id!==session.id||!isDeepStrictEqual(admission.data,{
     runId:input.runId,turnId:input.turnId,target,maxReservationMicroUsd:preflight.budget.maxReservationMicroUsd,submitBeforeMs:preflight.validUntilMs,
     kind:'campaign-admission-v1',tenantId:preflight.tenantId,brandId:preflight.brandId,actorUserId:plan.request.actorUserId,
     sessionId:session.id,requestId:preflight.requestId,jobId:job.id,candidateId:candidate.id,contextVersion:job.context_version,epoch:job.epoch,
     gateId:preflight.budget.gateId,limitMicroUsd:preflight.budget.limitMicroUsd,
    }))return fail('BINDING_MISMATCH');
   }
   const turn=turns.find(item=>item.id===input.turnId)!;
   const inbound=row.messages.find(message=>message.id===preflight.sessionId+':'+preflight.requestId);
   if(session.id!==preflight.sessionId||session.owner_user_id!==plan.request.actorUserId||session.candidate_id!==session.conversation_candidate_id||session.candidate_id!==candidate.id||
    job.conversation_id!==session.id||job.candidate_id!==candidate.id||job.trigger_message_id!==inbound?.id||job.version_id!==target.versionId||session.version_id!==target.versionId||
    version.id!==target.versionId||version.content_hash!==target.contentHash||version.model!==target.model||!snapshot.success||snapshot.data.model!==target.model||
    snapshot.data.tenant.tenantId!==preflight.tenantId||snapshot.data.tenant.brandId!==preflight.brandId||snapshotHash(snapshot.data)!==target.contentHash||
    candidate.lead_state.tenantId!==preflight.tenantId||candidate.lead_state.brandId!==preflight.brandId||candidate.lead_state.leadId!==candidate.id||
    !inbound||inbound.conversation_id!==session.id||inbound.candidate_id!==candidate.id||inbound.actor!=='candidate'||inbound.type!=='text'||inbound.text!==turn.input)return fail('BINDING_MISMATCH');
   const candidatePhase=plan.phases[0].executions.some(execution=>execution.turns.some(item=>item.id===turn.id));
   const evaluation=z.array(z.object({ownerUserId:z.string(),requestId:z.string(),versionId:z.string(),contentHash:z.string()})).safeParse(row.evaluation);
   if(candidatePhase&&(!evaluation.success||evaluation.data.length!==1||evaluation.data[0].ownerUserId!==plan.request.actorUserId||evaluation.data[0].requestId!==session.request_id||
    evaluation.data[0].versionId!==target.versionId||evaluation.data[0].contentHash!==target.contentHash))return fail('BINDING_MISMATCH');
   if(!candidatePhase){
    if(row.evaluation.length||!preflight.published)return fail('BINDING_MISMATCH');
    if(!row.publication_id)return fail('INCOMPLETE_EVIDENCE');
   }
   if(['pending','working','running'].includes(job.state))return fail(job.completed_at===null&&new Date(job.deadline)>new Date(row.observed_at)?'NOT_TERMINAL':'INCOMPLETE_EVIDENCE');
   if(!['completed','handoff'].includes(job.state))return fail('TERMINAL_FAILURE');
   if(job.completed_at===null)return fail('INCOMPLETE_EVIDENCE');
   if(candidate.revision!==job.context_version)return fail('MEMORY_ADVANCED');
   const decision=AgentDecisionSchema.safeParse(job.result),response=row.messages.filter(message=>message.id.startsWith(job.id+':reply:'));
   if(!decision.success||row.guards.length!==1)return fail('INCOMPLETE_EVIDENCE');
   const handoff=['handoff','stop'].includes(decision.data.nextAction);
   if(guard.conversation_id!==session.id||guard.detail.jobId!==job.id||guard.detail.versionId!==target.versionId||
    (guard.detail.guardPassed?job.error_code!==null:job.error_code!=='POLICY_GUARD'||!guard.detail.guardViolations?.length||!handoff)||
    guard.detail.guardPassed&&(guard.detail.guardViolations?.length??0)>0||
    guard.detail.replyRepair!==undefined&&(guard.detail.modelGuardPassed!==false||!guard.detail.originalGuardViolations?.length)||
    job.state!==(handoff?'handoff':'completed')||session.state!==(handoff?decision.data.nextAction==='stop'?'stopped':'human':'automatic')||session.epoch!==job.epoch+(handoff?1:0)||
    response.length!==decision.data.bubbles.length||response.some((message,index)=>message.id!==job.id+':reply:'+index||message.text!==decision.data.bubbles[index]||message.actor!=='agent'||message.type!=='text'||message.conversation_id!==session.id||message.candidate_id!==candidate.id))return fail('INCOMPLETE_EVIDENCE');
   const byId=<T extends {id:string}>(items:T[])=>[...items].sort((a,b)=>a.id.localeCompare(b.id));
   if(!isDeepStrictEqual(byId(row.facts),byId(candidate.lead_state.facts))||!isDeepStrictEqual(byId(row.relations),byId(candidate.lead_state.relations)))return fail('INCOMPLETE_EVIDENCE');
   const usage=UsageSchema.safeParse(job.usage);
   // A claim may recover before any reservation; the sole paid reservation must match its effective attempt below.
   if(row.reservations.length!==1||job.attempts<1||!usage.success)return fail('AMBIGUOUS_LEDGER');
   const reserved=ledger.detail,{input_tokens:inputTokens,output_tokens:outputTokens,total_tokens:total}=usage.data;
   const reservationId='lab-budget:'+createHash('sha256').update(`${preflight.budget.gateId}:${job.id}:${job.attempts}`).digest('hex');
   if(ledger.id!==reservationId||ledger.conversation_id!==session.id||reserved.jobId!==job.id||reserved.gateId!==preflight.budget.gateId||reserved.attempt!==job.attempts||!reserved.settled||
    ('exactPayloadBound' in preflight.budget?(reserved.inputTokenBound!==preflight.budget.exactPayloadBound||reserved.reservedMicroUsd!==preflight.budget.reservationMicroUsd):reserved.reservedMicroUsd>preflight.budget.maxReservationMicroUsd)||reserved.reservedMicroUsd!==Math.ceil(reserved.inputTokenBound*2.5+1200*15)||
    inputTokens===undefined||outputTokens===undefined||inputTokens<=0||outputTokens<=0||outputTokens>1200||inputTokens>reserved.inputTokenBound||
    reserved.inputTokens!==inputTokens||reserved.outputTokens!==outputTokens||total!==undefined&&total!==inputTokens+outputTokens||
    reserved.costMicroUsd!==Math.ceil(inputTokens*2.5+outputTokens*15)||reserved.costMicroUsd>reserved.reservedMicroUsd)return fail('AMBIGUOUS_LEDGER');
   const data=TerminalAuditObservationSchema.parse({kind:'terminal-observation',observedAt:row.observed_at,objectiveAudit:'pending',humanReview:'pending',publicationEvidenceId:candidatePhase?null:row.publication_id,
    ...('protocol' in state?{protocol:state.protocol,jobDeadlineAtMs:new Date(job.deadline).getTime(),preparation:{attempt:job.attempts,inputTokenBound:reserved.inputTokenBound,reservedMicroUsd:reserved.reservedMicroUsd,reservationId:ledger.id}}:{}),
    binding:{runId:input.runId,turnId:input.turnId,actorUserId:plan.request.actorUserId,sessionId:preflight.sessionId,requestId:preflight.requestId,jobId:job.id,candidateId:candidate.id,target:plan.request.target},
    job,input:inbound,response,
    guard,memory:{basis:'current-row-at-job-revision',revision:candidate.revision,lead:candidate.lead_state,facts:row.facts,relations:row.relations},ledger,
    limitations:['provider-response-and-execution-not-retained','runtime-config-not-proven-by-ledger','memory-is-not-an-immutable-post-turn-snapshot','database-timestamps-are-not-commit-or-render-times','publication-ratings-not-revalidated']});
   return {success:true,data};
  }catch{return {success:false,error:{code:'READ_FAILED'}};}
 }
}
