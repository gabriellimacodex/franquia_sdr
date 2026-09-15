import { z } from 'zod';
import { CampaignPlanSchema, CampaignTargetSchema } from './sprint4-campaign.spec.js';

const Id = z.string().min(1).max(200), Money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value))), Stage = z.enum(['R1', 'R2', 'M6']);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const HistoricalReservation = z.object({ inputTokenBound: Money.min(4096).max(272000), reservedMicroUsd: Money.min(28_240).max(698_000) }).strict();
const HistoricalT1 = z.object({ artifactSha256: Hash, kind: z.literal('offline-first-turn-preparation'),
 contentHash: Hash, model: CampaignTargetSchema.shape.model, localVersionId: Id, observedAt: Timestamp,
 samples: z.array(HistoricalReservation.extend({ caseId: z.string().regex(/^C(?:0[1-9]|[12][0-9]|30)$/), payloadBytes: Money.min(1) }).strict()).length(30),
}).strict();
const ConsumptionBase = z.object({ turnId: Id, reservationId: Id, evidenceRef: Id, observedAt: Timestamp,
 reservedMicroUsd: Money.min(1).max(1_000_000) }).strict();
const Consumption = z.discriminatedUnion('status', [
 ConsumptionBase.extend({ status: z.literal('settled'), costMicroUsd: Money.min(1) }).strict(),
 ConsumptionBase.extend({ status: z.enum(['reserved', 'unknown']), costMicroUsd: z.null() }).strict(),
]);
export const CampaignBudgetStopReasonSchema = z.enum(['UNSETTLED_RESERVATIONS', 'OBSERVED_CEILING_EXCEEDED',
 'NEXT_CEILING_UNCOVERED', 'ACTOR_WINDOW_INSUFFICIENT', 'SNAPSHOT_STALE']);
export type CampaignBudgetStopReason = z.infer<typeof CampaignBudgetStopReasonSchema>;
export const CampaignBudgetInputSchema = z.object({
 plan: CampaignPlanSchema, asOf: Timestamp, maxSnapshotAgeMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 controlMessageSlots: z.number().int().min(1).max(100),
 ceilings: z.array(z.object({ turnId: Id, maxReservationMicroUsd: Money.min(28_240).max(1_000_000) }).strict()).max(72),
 budgetSnapshot: z.object({ gateId: z.literal('sprint3-continuous-20260910'), limitMicroUsd: z.literal(1_000_000),
  accountedMicroUsd: Money.max(1_000_000), unsettledReservations: Money, observedAt: Timestamp }).strict(),
 dailySnapshot: z.object({ actorUserId: Id, usedMessages: z.number().int().min(0).max(100), observedAt: Timestamp }).strict(),
 consumption: z.array(Consumption).max(72), historicalT1: HistoricalT1.nullable(),
}).strict();
export type CampaignBudgetInput = z.infer<typeof CampaignBudgetInputSchema>;
export const CampaignBudgetReportSchema = z.object({
 kind: z.literal('sprint4-budget-analysis'), readyToExecute: z.literal(false), inputSourcesVerified: z.literal(false),
 binding: z.object({ runId: Id, actorUserId: Id, target: CampaignTargetSchema,
  planHash: Hash, envelopeHash: Hash }).strict(),
 asOf: Timestamp, requiresLiveRecheck: z.literal(true),
 turns: z.array(z.object({ turnId: Id, stage: Stage, turn: z.union([z.literal(1), z.literal(2)]), maxReservationMicroUsd: Money,
  historicalFirstTurn: HistoricalReservation.nullable() }).strict()),
 historicalT1: z.object({ artifactSha256: Hash, contentHash: Hash, localVersionId: Id, observedAt: Timestamp,
  sourceVerified: z.literal(false), appliesToCurrentPayload: z.literal(false), firstTurnCount: Money,
  referenceReservationSumMicroUsd: Money }).strict().nullable(),
 stages: z.array(z.object({ id: Stage, turnCount: Money, ceilingMicroUsd: Money }).strict()),
 totalCeilingMicroUsd: Money, remainingCeilingMicroUsd: Money, availableGlobalMicroUsd: Money,
 reportedSettledCostMicroUsd: Money, retainedReservationsMicroUsd: Money, observedTurnCount: Money, nextUnobservedTurnId: Id.nullable(),
 stopReasons: z.array(CampaignBudgetStopReasonSchema),
 snapshotTimes: z.object({ budget: Timestamp, daily: Timestamp }).strict(),
 daily: z.object({ actorUserId: Id, limitMessages: z.literal(100), rollingWindowHours: z.literal(24),
  availableMessages: Money, nextStageMessages: Money, controlMessageSlots: Money,
  nextStageFitsWindow: z.boolean(), allRemainingFitWindow: z.boolean() }).strict(),
 pending: z.array(z.enum(['EXACT_PAYLOAD_AND_DEADLINE_UNAVAILABLE', 'REAL_AUTHORITY_AND_PINS_NOT_VERIFIED',
  'OBJECTIVE_AND_HUMAN_GATES_NOT_VERIFIED', 'RUNTIME_AND_N8N_NOT_VERIFIED', 'CONTROLLER_ORDER_AND_AUDIT_REQUIRED'])),
 envelopeCoveredAtSnapshot: z.boolean(), nextCeilingCoveredAtSnapshot: z.boolean().nullable(),
 unknownSecondTurnCount: Money, futureCostMicroUsd: z.null(), minimumAdditionalSpendMicroUsd: z.null(),
}).strict();
export type CampaignBudgetReport = z.infer<typeof CampaignBudgetReportSchema>;
export const CampaignBudgetErrorSchema = z.object({ code: z.enum(['INVALID_INPUT', 'PLAN_MISMATCH', 'CEILING_MISMATCH',
 'CONSUMPTION_MISMATCH', 'SNAPSHOT_MISMATCH', 'HISTORICAL_REFERENCE_MISMATCH', 'ANALYSIS_FAILED']) }).strict();
export const CampaignBudgetResultSchema = z.discriminatedUnion('success', [
 z.object({ success: z.literal(true), data: CampaignBudgetReportSchema }).strict(),
 z.object({ success: z.literal(false), error: CampaignBudgetErrorSchema }).strict(),
]);
export type CampaignBudgetResult = z.infer<typeof CampaignBudgetResultSchema>;
/** Pure projection of caller-supplied observations; never authenticates, prepares, reserves or sends. */
export interface CampaignBudgetAnalyzerSpec { analyzeBudget(raw: unknown): CampaignBudgetResult }
