import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AdmissionEvidenceSchema, type CampaignJournal } from './sprint4-controller.spec.js';
import { AdmissionTerminalAuditObservationSchema, TerminalAuditErrorSchema, type Sprint4TerminalAuditSpec } from './sprint4-terminal-audit.spec.js';
import { CampaignPlanSchema } from './sprint4-campaign.spec.js';

const Hash=z.string().regex(/^[a-f0-9]{64}$/),Id=z.string().min(1).max(200);
/** Compare validated ISO timestamps without discarding PostgreSQL fractional seconds. */
export function compareEvidenceTimestamps(left:string,right:string):number {
 const instant=(value:string)=>{
  const fraction=value.match(/\.(\d+)(?=Z$|[+-]\d{2}:?\d{2}$)/)?.[1]??'';
  const whole=Date.parse(fraction?value.replace('.'+fraction,''):value);
  if(!Number.isSafeInteger(whole))throw new Error('INVALID_EVIDENCE_TIMESTAMP');
  return {whole,fraction};
 };
 const a=instant(left),b=instant(right);
 if(a.whole!==b.whole)return a.whole<b.whole?-1:1;
 const precision=Math.max(a.fraction.length,b.fraction.length),af=a.fraction.padEnd(precision,'0'),bf=b.fraction.padEnd(precision,'0');
 return af===bf?0:af<bf?-1:1;
}
export const TerminalArtifactPayloadSchema=z.object({
 kind:z.literal('sprint4-terminal-artifact-v1'),planHash:Hash,admission:AdmissionEvidenceSchema,
 observation:AdmissionTerminalAuditObservationSchema,
 rawArtifact:z.object({status:z.literal('unavailable'),reason:z.literal('not-retained-by-runtime')}).strict(),
}).strict().refine(value=>{
 const a=value.admission,o=value.observation,b=o.binding;
 return a.turnId===b.turnId&&a.actorUserId===b.actorUserId&&a.sessionId===b.sessionId&&a.requestId===b.requestId&&
  JSON.stringify(a.target)===JSON.stringify(b.target)&&o.job.id===b.jobId&&o.job.conversation_id===b.sessionId&&
  o.job.candidate_id===b.candidateId&&o.job.version_id===b.target.versionId&&o.memory.lead.leadId===b.candidateId&&
  o.memory.lead.tenantId===a.tenantId&&o.memory.lead.brandId===a.brandId&&
  o.input.id===b.sessionId+':'+b.requestId&&o.job.trigger_message_id===o.input.id&&o.input.actor==='candidate'&&o.input.type==='text'&&
  o.input.conversation_id===b.sessionId&&o.input.candidate_id===b.candidateId&&o.response.length===o.job.result.bubbles.length&&
  o.response.every((m,i)=>m.id===b.jobId+':reply:'+i&&m.text===o.job.result.bubbles[i]&&m.actor==='agent'&&m.type==='text'&&m.conversation_id===b.sessionId&&m.candidate_id===b.candidateId)&&
  o.ledger.conversation_id===b.sessionId&&o.ledger.detail.jobId===b.jobId&&o.ledger.detail.gateId===a.budget.gateId&&
  o.preparation.reservationId===o.ledger.id&&o.preparation.attempt===o.ledger.detail.attempt&&o.preparation.attempt===o.job.attempts&&
  o.preparation.reservedMicroUsd===o.ledger.detail.reservedMicroUsd&&o.preparation.inputTokenBound===o.ledger.detail.inputTokenBound&&
  o.memory.revision===o.job.context_version&&o.guard.conversation_id===b.sessionId&&o.guard.detail.jobId===b.jobId&&o.guard.detail.versionId===b.target.versionId;
},'Artifact binding mismatch').refine(value=>{
 const o=value.observation,observed=Date.parse(o.observedAt),created=Date.parse(o.job.created_at),completed=Date.parse(o.job.completed_at),deadline=Date.parse(o.job.deadline);
 const dates=[o.input.created_at,o.ledger.created_at,o.guard.created_at,...o.response.map(m=>m.created_at)];
 return [observed,created,completed,deadline,...dates.map(t=>Date.parse(t))].every(Number.isSafeInteger)&&created>=value.admission.observedAtMs&&
  compareEvidenceTimestamps(o.job.completed_at,o.job.created_at)>=0&&compareEvidenceTimestamps(o.observedAt,o.job.completed_at)>=0&&
  o.jobDeadlineAtMs===deadline&&dates.every(t=>Date.parse(t)>=value.admission.observedAtMs&&compareEvidenceTimestamps(t,o.observedAt)<=0);
},'Artifact chronology mismatch');
export const terminalEvidenceHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const TerminalArtifactSchema=z.object({ref:z.string().regex(/^terminal-sha256:[a-f0-9]{64}$/),sha256:Hash,payload:TerminalArtifactPayloadSchema}).strict()
 .refine(value=>value.sha256===terminalEvidenceHash(value.payload)&&value.ref==='terminal-sha256:'+value.sha256,'Artifact digest mismatch');
export type TerminalArtifact=z.infer<typeof TerminalArtifactSchema>;
export const EvidenceStorageInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('read'),runId:Id,turnId:Id}).strict(),
 z.object({action:z.literal('archive-once'),artifact:TerminalArtifactSchema}).strict(),
 z.object({action:z.literal('close')}).strict(),
]);
export const EvidenceStorageResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('read'),artifact:TerminalArtifactSchema.nullable()}).strict(),
  z.object({kind:z.literal('archived'),duplicate:z.boolean()}).strict(),
  z.object({kind:z.literal('closed')}).strict(),
 ])}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','UNSAFE_STORAGE','CORRUPT_STATE','STATE_CONFLICT','STORAGE_FAILURE','CLOSED'])}).strict()}).strict(),
]);
export type EvidenceStorageResult=z.infer<typeof EvidenceStorageResultSchema>;
export interface EvidenceStorageSpec {execute(raw:unknown):Promise<EvidenceStorageResult>}
export const EvidenceCaptureInputSchema=z.object({plan:CampaignPlanSchema,turnId:Id}).strict();
export const EvidenceCaptureResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:z.object({kind:z.literal('awaiting-review'),source:z.enum(['captured','archive']),artifact:TerminalArtifactSchema}).strict()}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','INVALID_PLAN','INTENT_NOT_FOUND','EVIDENCE_MISMATCH','AUDIT_FAILED','STORAGE_FAILED','DEPENDENCY_FAILED']),auditCode:TerminalAuditErrorSchema.shape.code.optional()}).strict()}).strict(),
]);
export type EvidenceCaptureResult=z.infer<typeof EvidenceCaptureResultSchema>;
export interface EvidenceCaptureSpec {execute(raw:unknown):Promise<EvidenceCaptureResult>}
export interface EvidenceCaptureDependencies {journal:Pick<CampaignJournal,'read'>;audit:Sprint4TerminalAuditSpec;storage:EvidenceStorageSpec}
