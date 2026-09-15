import { z } from 'zod';

const id = z.string().min(1);
const date = z.preprocess(value => typeof value === 'string' ? new Date(value) : value, z.date());
const scope = { tenant_id: id, brand_id: id };
export const CompletionSnapshotInputSchema = z.object({ jobId: id, contextVersion: z.number().int() }).strict();
export const CompletionJobSchema = z.object({
  ...scope, id, conversation_id: id, candidate_id: id, trigger_message_id: id, version_id: id,
  context_version: z.number().int(), epoch: z.number().int(), state: id, attempts: z.number().int(),
  result: z.unknown(), context: z.unknown(), usage: z.unknown(), error_code: z.string().nullable(),
  created_at: date, available_at: date, deadline: date, lease_until: date.nullable(), completed_at: date.nullable(),
}).passthrough();
export const CompletionConversationSchema = z.object({
  ...scope, id, candidate_id: id, phone_number_id: id, state: id, epoch: z.number().int(),
  execution_id: z.string().nullable(), control_fingerprint: z.string().nullable(),
  last_inbound_at: date.nullable(), updated_at: date,
}).passthrough();
export const CompletionCandidateSchema = z.object({
  ...scope, id, contact_id: id, authorized_contact_id: id, label: z.string(),
  lead_state: z.unknown(), revision: z.number().int(), updated_at: date,
}).passthrough();
export const CompletionSnapshotDataSchema = z.object({
  job: CompletionJobSchema, conversation: CompletionConversationSchema, candidate: CompletionCandidateSchema,
  version: z.object({ snapshot: z.unknown() }).strict(),
  messages: z.array(z.object({ id, text: z.string(), actor: id, conversation_id: id, provider_timestamp: date }).strict()),
}).strict();
export const CompletionSnapshotErrorSchema = z.object({ code: z.enum([
  'INVALID_INPUT', 'SCOPE_MISMATCH', 'JOB_NOT_FOUND', 'STALE_RESULT', 'INCONSISTENT_SNAPSHOT', 'READ_FAILED',
]) }).strict();
export const CompletionSnapshotResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: CompletionSnapshotDataSchema }).strict(),
  z.object({ success: z.literal(false), error: CompletionSnapshotErrorSchema }).strict(),
]);
export type CompletionSnapshotResult = z.infer<typeof CompletionSnapshotResultSchema>;
export interface CompletionSnapshotSpec { execute(raw: unknown): Promise<CompletionSnapshotResult> }
