import { createHash } from 'node:crypto';
import type { CampaignPlannerSpec } from './sprint4-campaign.spec.js';
import { CampaignBudgetInputSchema, CampaignBudgetReportSchema, type CampaignBudgetResult, type CampaignBudgetStopReason } from './sprint4-campaign-budget.spec.js';

/** Financial projection only. Caller-supplied evidence references and hashes are not proof of remote authority. */
export function analyzeCampaignBudget(raw: unknown, validatePlan: CampaignPlannerSpec['validate']): CampaignBudgetResult {
 try {
  const parsed = CampaignBudgetInputSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: { code: 'INVALID_INPUT' } };
  const input = parsed.data, valid = validatePlan(input.plan);
  if (!valid.success) return { success: false, error: { code: 'PLAN_MISMATCH' } };
  const snapshotTimes = { budget: input.budgetSnapshot.observedAt, daily: input.dailySnapshot.observedAt };
  const ages = Object.values(snapshotTimes).map(time => Date.parse(input.asOf) - Date.parse(time));
  if (input.dailySnapshot.actorUserId !== valid.data.request.actorUserId || ages.some(age => age < 0)) {
   return { success: false, error: { code: 'SNAPSHOT_MISMATCH' } };
  }
  const reference = input.historicalT1, samples = new Map(reference?.samples.map(sample => [sample.caseId, sample]));
  if (reference && (reference.contentHash !== valid.data.request.target.contentHash
   || Date.parse(reference.observedAt) > Date.parse(input.asOf) || samples.size !== 30
   || valid.data.request.cases.some(item => !samples.has(item.caseId))
   || reference.samples.some(sample => sample.payloadBytes + 4096 !== sample.inputTokenBound
    || Math.ceil(sample.inputTokenBound * 2.5 + 1200 * 15) !== sample.reservedMicroUsd))) {
   return { success: false, error: { code: 'HISTORICAL_REFERENCE_MISMATCH' } };
  }
  const ceilings = new Map(input.ceilings.map(item => [item.turnId, item.maxReservationMicroUsd]));
  const turns = valid.data.phases.flatMap(phase => phase.executions.flatMap(execution => execution.turns.map(turn => ({
   turnId: turn.id, stage: phase.id === 'm6-published' ? 'M6' as const : execution.repetition,
   turn: turn.turn, maxReservationMicroUsd: ceilings.get(turn.id) ?? 0,
   historicalFirstTurn: turn.turn === 1 && samples.has(execution.caseId)
    ? { inputTokenBound: samples.get(execution.caseId)!.inputTokenBound, reservedMicroUsd: samples.get(execution.caseId)!.reservedMicroUsd } : null,
  }))));
  if (ceilings.size !== input.ceilings.length || ceilings.size !== turns.length || turns.some(turn => !ceilings.has(turn.turnId))) {
   return { success: false, error: { code: 'CEILING_MISMATCH' } };
  }
  const stages = (['R1', 'R2', 'M6'] as const).map(id => {
   const group = turns.filter(turn => turn.stage === id);
   return { id, turnCount: group.length, ceilingMicroUsd: group.reduce((sum, turn) => sum + turn.maxReservationMicroUsd, 0) };
  }).filter(stage => stage.turnCount > 0);
  const totalCeilingMicroUsd = stages.reduce((sum, stage) => sum + stage.ceilingMicroUsd, 0);
  const availableGlobalMicroUsd = input.budgetSnapshot.limitMicroUsd - input.budgetSnapshot.accountedMicroUsd;
  // This prefix describes accounting, not objective acceptance or permission to advance the controller.
  const observed = new Set(input.consumption.map(item => item.turnId));
  const remaining = turns.filter(turn => !observed.has(turn.turnId));
  const remainingCeilingMicroUsd = remaining.reduce((sum, turn) => sum + turn.maxReservationMicroUsd, 0);
  const reportedSettledCostMicroUsd = input.consumption.reduce((sum, item) => sum + (item.status === 'settled' ? item.costMicroUsd : 0), 0);
  const retainedReservationsMicroUsd = input.consumption.reduce((sum, item) => sum + (item.status === 'settled' ? 0 : item.reservedMicroUsd), 0);
  const unsettled = input.consumption.filter(item => item.status !== 'settled');
  if (observed.size !== input.consumption.length || new Set(input.consumption.map(item => item.reservationId)).size !== input.consumption.length
   || input.consumption.some((item, index) => item.turnId !== turns[index]?.turnId
    || (item.status === 'settled' && item.costMicroUsd > item.reservedMicroUsd)
    || (item.status !== 'settled' && index !== input.consumption.length - 1)
    || Date.parse(item.observedAt) > Math.min(Date.parse(input.budgetSnapshot.observedAt), Date.parse(input.dailySnapshot.observedAt)))
   || reportedSettledCostMicroUsd + retainedReservationsMicroUsd > input.budgetSnapshot.accountedMicroUsd
   || unsettled.length > input.budgetSnapshot.unsettledReservations) return { success: false, error: { code: 'CONSUMPTION_MISMATCH' } };
  const stopReasons: CampaignBudgetStopReason[] = [];
  if (input.budgetSnapshot.unsettledReservations > 0) stopReasons.push('UNSETTLED_RESERVATIONS');
  if (input.consumption.some(item => item.reservedMicroUsd > ceilings.get(item.turnId)!)) stopReasons.push('OBSERVED_CEILING_EXCEEDED');
  const nextCeilingCoveredAtSnapshot = remaining[0] ? remaining[0].maxReservationMicroUsd <= availableGlobalMicroUsd : null;
  const availableMessages = 100 - input.dailySnapshot.usedMessages;
  const nextStageMessages = remaining.filter(turn => turn.stage === remaining[0]?.stage).length;
  const nextStageFitsWindow = nextStageMessages + input.controlMessageSlots <= availableMessages;
  if (nextCeilingCoveredAtSnapshot === false) stopReasons.push('NEXT_CEILING_UNCOVERED');
  if (!nextStageFitsWindow) stopReasons.push('ACTOR_WINDOW_INSUFFICIENT');
  if (ages.some(age => age > input.maxSnapshotAgeMs)) stopReasons.push('SNAPSHOT_STALE');
  const planHash = createHash('sha256').update(JSON.stringify(valid.data)).digest('hex');
  const envelopeHash = createHash('sha256').update(JSON.stringify({ planHash, ceilings: turns.map(({ turnId, maxReservationMicroUsd }) => ({ turnId, maxReservationMicroUsd })) })).digest('hex');
  return { success: true, data: CampaignBudgetReportSchema.parse({
   kind: 'sprint4-budget-analysis', readyToExecute: false, inputSourcesVerified: false, asOf: input.asOf, requiresLiveRecheck: true,
   binding: { runId: valid.data.request.runId, actorUserId: valid.data.request.actorUserId, target: valid.data.request.target, planHash, envelopeHash },
   turns, stages, totalCeilingMicroUsd, remainingCeilingMicroUsd, availableGlobalMicroUsd,
   historicalT1: reference ? { artifactSha256: reference.artifactSha256, contentHash: reference.contentHash,
    localVersionId: reference.localVersionId, observedAt: reference.observedAt, sourceVerified: false, appliesToCurrentPayload: false,
    firstTurnCount: turns.filter(turn => turn.historicalFirstTurn !== null).length,
    referenceReservationSumMicroUsd: turns.reduce((sum, turn) => sum + (turn.historicalFirstTurn?.reservedMicroUsd ?? 0), 0) } : null,
   reportedSettledCostMicroUsd, retainedReservationsMicroUsd, observedTurnCount: observed.size, nextUnobservedTurnId: remaining[0]?.turnId ?? null,
   stopReasons, snapshotTimes,
   daily: { actorUserId: valid.data.request.actorUserId, limitMessages: 100, rollingWindowHours: 24, availableMessages,
    nextStageMessages, controlMessageSlots: input.controlMessageSlots, nextStageFitsWindow,
    allRemainingFitWindow: remaining.length + input.controlMessageSlots <= availableMessages },
   pending: ['EXACT_PAYLOAD_AND_DEADLINE_UNAVAILABLE', 'REAL_AUTHORITY_AND_PINS_NOT_VERIFIED', 'OBJECTIVE_AND_HUMAN_GATES_NOT_VERIFIED',
    'RUNTIME_AND_N8N_NOT_VERIFIED', 'CONTROLLER_ORDER_AND_AUDIT_REQUIRED'],
   envelopeCoveredAtSnapshot: remainingCeilingMicroUsd <= availableGlobalMicroUsd,
   nextCeilingCoveredAtSnapshot,
   unknownSecondTurnCount: turns.filter(turn => turn.turn === 2).length, futureCostMicroUsd: null, minimumAdditionalSpendMicroUsd: null,
  }) };
 } catch { return { success: false, error: { code: 'ANALYSIS_FAILED' } }; }
}
