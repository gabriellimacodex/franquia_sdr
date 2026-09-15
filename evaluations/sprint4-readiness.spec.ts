import { z } from 'zod';

const Id = z.string().min(1).max(200), Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ReadinessCallerSchema = z.object({ tenantId: z.literal('cognita-homologacao'), brandId: z.literal('sapore'), actorUserId: Id }).strict();
export type ReadinessCaller = z.infer<typeof ReadinessCallerSchema>;
export const ReadinessInputSchema = ReadinessCallerSchema.extend({
  versionId: Id, contentHash: z.string().regex(/^[a-f0-9]{64}$/), model: z.literal('gpt-5.4-2026-03-05'), sessionId: Id.optional(),
}).strict();
export const ReadinessPendingSchema = z.enum([
  'EXACT_PAYLOAD_UNAVAILABLE', 'JOB_DEADLINE_UNAVAILABLE', 'RUNTIME_AND_N8N_NOT_VERIFIED',
  'PUBLICATION_AND_HUMAN_GATES_NOT_VERIFIED', 'CAPACITY_RECHECK_REQUIRED', 'REMAINING_CAMPAIGN_REVIEW_REQUIRED',
  'SESSION_NOT_PREPARED', 'SESSION_NOT_AUTOMATIC', 'ACTIVE_JOBS_PRESENT', 'UNSETTLED_RESERVATIONS_PRESENT',
  'POLICY_BUDGET_EXHAUSTED', 'ACTOR_DAILY_LIMIT_REACHED',
]);
export const ReadinessObservationSchema = z.object({
  kind: z.literal('readiness-observation'), observedAt: z.string().datetime({ offset: true }), binding: ReadinessInputSchema,
  membership: z.object({ role: z.literal('admin'), active: z.literal(true) }).strict(),
  version: z.object({ id: Id, contentHash: z.string(), model: z.literal('gpt-5.4-2026-03-05'), outputContract: z.enum(['legacy-v1', 'financial-v2']) }).strict(),
  session: z.object({ id: Id, state: z.enum(['automatic', 'human', 'stopped']), versionId: Id }).strict().nullable(),
  ledger: z.object({ gateId: z.literal('sprint3-continuous-20260910'), policyLimitMicroUsd: z.literal(1_000_000), runtimeLimitVerified: z.literal(false),
    accountedMicroUsd: Integer, remainingPolicyMicroUsd: Integer, reservationCount: Integer, unsettledReservations: Integer }).strict(),
  daily: z.object({ actorUserId: Id, limitMessages: z.literal(100), rollingWindowHours: z.literal(24), usedMessages: Integer, remainingMessages: Integer }).strict(),
  activeJobs: z.object({ scope: Integer, actor: Integer, session: Integer.nullable() }).strict(),
  exactPayloadBound: z.null(), nextJobDeadline: z.null(), pending: z.array(ReadinessPendingSchema),
}).strict();
export const ReadinessErrorSchema = z.object({ code: z.enum([
  'INVALID_INPUT', 'CALLER_MISMATCH', 'UNSAFE_READ_CONTEXT', 'ACTOR_NOT_ADMIN', 'VERSION_MISMATCH',
  'SESSION_NOT_FOUND', 'SESSION_MISMATCH', 'INVALID_LEDGER', 'READ_FAILED',
]) }).strict();
export const ReadinessResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), data: ReadinessObservationSchema }).strict(),
  z.object({ success: z.literal(false), error: ReadinessErrorSchema }).strict(),
]);
export type ReadinessResult = z.infer<typeof ReadinessResultSchema>;
/** Caller identity must come from the authenticated caller, never the input DTO.
 * This port does not authenticate a JWT, create sessions/jobs, prepare, reserve or authorize sending. */
export interface Sprint4ReadinessSpec { execute(raw: unknown): Promise<ReadinessResult> }
