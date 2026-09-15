import { z } from 'zod';
import { AgentDecisionSchema, LeadFactSchema, LeadStateSchema, RelationProposalSchema } from '../src/domain.js';
import { UsageSchema } from '../src/usage.js';
import { CampaignTargetSchema } from './sprint4-campaign.spec.js';
import { PreparationMeasurementSchema } from './sprint4-controller.spec.js';

const Id=z.string().min(1),Integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const DateText=z.string().datetime({offset:true});
export const TerminalAuditInputSchema=z.object({runId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),turnId:Id}).strict();
export const AuditMessageSchema=z.object({id:Id,conversation_id:Id,candidate_id:Id,actor:Id,type:Id,text:z.string(),created_at:DateText}).strict();
export const AuditJobSchema=z.object({id:Id,conversation_id:Id,candidate_id:Id,trigger_message_id:Id,version_id:Id,
 state:Id,context_version:Integer,epoch:Integer,attempts:Integer,error_code:z.string().nullable(),result:z.unknown(),usage:z.unknown(),
 created_at:DateText,completed_at:DateText.nullable(),deadline:DateText}).strict();
export const AuditGuardSchema=z.object({id:Id,conversation_id:Id,created_at:DateText,detail:z.object({jobId:Id,versionId:Id,guardPassed:z.boolean(),
 guardViolations:z.array(Id).optional(),modelGuardPassed:z.boolean().optional(),originalGuardViolations:z.array(Id).optional(),replyRepair:Id.optional()})}).strict();
export const AuditReservationSchema=z.object({id:Id,conversation_id:Id,created_at:DateText,detail:z.object({gateId:Id,jobId:Id,attempt:Integer,
 inputTokenBound:Integer.min(4096).max(272000),reservedMicroUsd:Integer,costMicroUsd:Integer,settled:z.boolean(),inputTokens:Integer.optional(),outputTokens:Integer.optional()}).strict()}).strict();
export const LegacyTerminalAuditObservationSchema=z.object({
 kind:z.literal('terminal-observation'),observedAt:DateText,objectiveAudit:z.literal('pending'),humanReview:z.literal('pending'),publicationEvidenceId:Id.nullable(),
 binding:z.object({runId:Id,turnId:Id,actorUserId:Id,sessionId:Id,requestId:z.string().uuid(),jobId:Id,candidateId:Id,target:CampaignTargetSchema}).strict(),
 job:AuditJobSchema.extend({state:z.enum(['completed','handoff']),result:AgentDecisionSchema,usage:UsageSchema,completed_at:DateText}),
 input:AuditMessageSchema,response:z.array(AuditMessageSchema),guard:AuditGuardSchema,
 memory:z.object({basis:z.literal('current-row-at-job-revision'),revision:Integer,lead:LeadStateSchema,
  facts:z.array(LeadFactSchema),relations:z.array(RelationProposalSchema)}).strict(),
 ledger:AuditReservationSchema,
 limitations:z.tuple([z.literal('provider-response-and-execution-not-retained'),z.literal('runtime-config-not-proven-by-ledger'),z.literal('memory-is-not-an-immutable-post-turn-snapshot'),z.literal('database-timestamps-are-not-commit-or-render-times'),z.literal('publication-ratings-not-revalidated')]),
}).strict();
export const AdmissionTerminalAuditObservationSchema=LegacyTerminalAuditObservationSchema.extend({
 protocol:z.literal('sprint4-admission-v2'),jobDeadlineAtMs:Integer,preparation:PreparationMeasurementSchema,
}).strict();
export const TerminalAuditObservationSchema=z.union([AdmissionTerminalAuditObservationSchema,LegacyTerminalAuditObservationSchema]);
export const TerminalAuditErrorSchema=z.object({code:z.enum(['INVALID_INPUT','INTENT_NOT_FOUND','INVALID_INTENT','UNSAFE_READ_CONTEXT','BINDING_MISMATCH','NOT_TERMINAL','TERMINAL_FAILURE','MEMORY_ADVANCED','INCOMPLETE_EVIDENCE','AMBIGUOUS_LEDGER','READ_FAILED'])}).strict();
export const TerminalAuditResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:TerminalAuditObservationSchema}).strict(),
 z.object({success:z.literal(false),error:TerminalAuditErrorSchema}).strict(),
]);
export type TerminalAuditResult=z.infer<typeof TerminalAuditResultSchema>;
export interface Sprint4TerminalAuditSpec {execute(raw:unknown):Promise<TerminalAuditResult>}
