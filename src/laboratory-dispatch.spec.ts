import { z } from 'zod';

export const LaboratoryDispatchInputSchema = z.object({
  jobId: z.string().min(1), attempt: z.number().int().positive(), contextVersion: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(), versionId: z.string().min(1),
}).strict();
export const LaboratoryDispatchDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), jobId: z.string(), attempt: z.number().int(), body: z.string(),
    contentHash: z.string(), reservationId: z.string(), inputTokenBound: z.number().int(), reservedMicroUsd: z.number().int(),
  }).strict(),
  z.object({ kind: z.literal('ignored'), reason: z.enum(['STALE_JOB', 'ALREADY_RESERVED']) }).strict(),
  z.object({ kind: z.literal('capability'), reason: z.enum(['AUDIO_REQUIRES_TEXT', 'UNSUPPORTED_MESSAGE']) }).strict(),
  z.object({ kind: z.literal('paused'), reason: z.enum(['LAB_BUDGET_NOT_CONFIGURED', 'LAB_BUDGET_SCOPE_MISMATCH', 'LAB_BUDGET_INPUT_TOO_LARGE', 'LAB_BUDGET_EXHAUSTED', 'CAMPAIGN_ADMISSION_INVALID', 'CAMPAIGN_CEILING_EXCEEDED']) }).strict(),
]);
export const LaboratoryDispatchErrorSchema = z.object({ code: z.enum([
  'INVALID_INPUT', 'NOT_LABORATORY', 'JOB_NOT_FOUND', 'INCONSISTENT_SNAPSHOT', 'KNOWLEDGE_UNAVAILABLE', 'DISPATCH_PREPARATION_FAILED',
]) }).strict();
export const LaboratoryDispatchResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: LaboratoryDispatchDataSchema }).strict(),
  z.object({ success: z.literal(false), error: LaboratoryDispatchErrorSchema }).strict(),
]);
export type LaboratoryDispatchInput = z.infer<typeof LaboratoryDispatchInputSchema>;
export type LaboratoryDispatchResult = z.infer<typeof LaboratoryDispatchResultSchema>;
export interface LaboratoryDispatchSpec { execute(raw: unknown): Promise<LaboratoryDispatchResult> }
