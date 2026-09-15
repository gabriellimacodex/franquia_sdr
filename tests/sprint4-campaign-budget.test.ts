import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';

const planner = new Sprint4CampaignPlanner();
const observedAt = '2026-09-14T00:27:41.000Z';
function fixture(m6Policy: 'separate' | 'defer' = 'separate') {
 const result = planner.execute({ runId: 'budget-example', actorUserId: 'admin-example', m6Policy,
  target: { versionId: 'draft-example', contentHash: 'c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959', model: 'gpt-5.4-2026-03-05' } });
 assert.ok(result.success);
 return { plan: result.data, asOf: '2026-09-14T00:28:00.000Z', maxSnapshotAgeMs: 60_000, controlMessageSlots: 2,
  ceilings: result.data.phases.flatMap(p => p.executions.flatMap(e => e.turns.map(t => ({ turnId: t.id, maxReservationMicroUsd: t.turn === 1 ? 70_000 : 100_000 })))),
  budgetSnapshot: { gateId: 'sprint3-continuous-20260910', limitMicroUsd: 1_000_000, accountedMicroUsd: 359_814, unsettledReservations: 0, observedAt },
  dailySnapshot: { actorUserId: 'admin-example', usedMessages: 54, observedAt }, consumption: [], historicalT1: null };
}

test('analyzes canonical 66+6 explicit ceilings without claiming their sum is spending or authorization', () => {
 const input = fixture(), before = JSON.stringify(input);
 const result = planner.analyzeBudget(input); assert.ok(result.success);
 assert.equal(result.data.readyToExecute, false);
 assert.equal(result.data.inputSourcesVerified, false);
 assert.equal(result.data.totalCeilingMicroUsd, 5_310_000);
 assert.equal(result.data.remainingCeilingMicroUsd, 5_310_000);
 assert.deepEqual(result.data.stages.map(s => [s.id, s.turnCount, s.ceilingMicroUsd]), [['R1', 33, 2_400_000], ['R2', 33, 2_400_000], ['M6', 6, 510_000]]);
 assert.equal(result.data.availableGlobalMicroUsd, 640_186);
 assert.equal(result.data.envelopeCoveredAtSnapshot, false);
 assert.equal(result.data.nextCeilingCoveredAtSnapshot, true);
 assert.equal(result.data.futureCostMicroUsd, null);
 assert.equal(result.data.minimumAdditionalSpendMicroUsd, null);
 assert.equal(result.data.unknownSecondTurnCount, 9);
 assert.equal(result.data.turns.length, 72);
 assert.deepEqual(result.data.turns.map(t => t.turnId), input.ceilings.map(c => c.turnId));
 assert.equal(JSON.stringify(input), before, 'the original immutable plan and inputs remain unchanged');
 const deferred = planner.analyzeBudget(fixture('defer')); assert.ok(deferred.success);
 assert.equal(deferred.data.totalCeilingMicroUsd, 4_800_000);
 assert.equal(deferred.data.turns.length, 66); assert.equal(deferred.data.unknownSecondTurnCount, 6);
});

test('requires exactly one explicit ceiling for every canonical turn, never omissions, duplicates or foreign IDs', () => {
 const input = fixture();
 for (const ceilings of [input.ceilings.slice(1), [...input.ceilings, input.ceilings[0]],
  input.ceilings.map((c, index) => index === 1 ? input.ceilings[0] : c),
  input.ceilings.map((c, index) => index === 0 ? { ...c, turnId: 'foreign-turn' } : c)]) {
  const result = planner.analyzeBudget({ ...input, ceilings });
  assert.equal(result.success, false);
 }
 const changedPlan = structuredClone(input.plan); changedPlan.phases[0].executions[0].turns[0].input = 'changed';
 assert.deepEqual(planner.analyzeBudget({ ...input, plan: changedPlan }), { success: false, error: { code: 'PLAN_MISMATCH' } });
 for (const maxReservationMicroUsd of [0, 28_239, 1_000_001, 70_000.5]) {
  assert.equal(planner.analyzeBudget({ ...input, ceilings: input.ceilings.map(c => ({ ...c, maxReservationMicroUsd })) }).success, false);
 }
});

test('binds the financial envelope to the canonical plan and ceilings without pretending a hash proves authority', () => {
 const input = fixture(), result = planner.analyzeBudget(input); assert.ok(result.success);
 assert.deepEqual(result.data.binding.target, input.plan.request.target);
 assert.equal(result.data.binding.actorUserId, input.plan.request.actorUserId);
 assert.equal(result.data.binding.runId, input.plan.request.runId);
 assert.match(result.data.binding.planHash, /^[a-f0-9]{64}$/);
 assert.match(result.data.binding.envelopeHash, /^[a-f0-9]{64}$/);
 const reordered = planner.analyzeBudget({ ...input, ceilings: [...input.ceilings].reverse(), asOf: '2026-09-14T00:28:01.000Z' });
 assert.ok(reordered.success); assert.deepEqual(reordered.data.binding, result.data.binding);
 const changed = planner.analyzeBudget({ ...input, ceilings: input.ceilings.map(c => ({ ...c, maxReservationMicroUsd: c.maxReservationMicroUsd + 1 })) });
 assert.ok(changed.success); assert.notEqual(changed.data.binding.envelopeHash, result.data.binding.envelopeHash);
 assert.equal(changed.data.binding.planHash, result.data.binding.planHash);
 assert.equal(changed.data.readyToExecute, false, 'a different envelope is not an amendment to an admitted turn');
});

test('separates supplied settlements from retained unknown reservations without subtracting either twice from the global ledger', () => {
 const input = fixture();
 const result = planner.analyzeBudget({ ...input,
  budgetSnapshot: { ...input.budgetSnapshot, accountedMicroUsd: 434_814, unsettledReservations: 1 },
  consumption: [
   { turnId: input.ceilings[0].turnId, reservationId: 'reserve-1', evidenceRef: 'audit-1', observedAt,
    status: 'settled', reservedMicroUsd: 60_000, costMicroUsd: 10_000 },
   { turnId: input.ceilings[1].turnId, reservationId: 'reserve-2', evidenceRef: 'audit-2', observedAt,
    status: 'unknown', reservedMicroUsd: 65_000, costMicroUsd: null },
  ],
 }); assert.ok(result.success);
 assert.equal(result.data.reportedSettledCostMicroUsd, 10_000);
 assert.equal(result.data.retainedReservationsMicroUsd, 65_000);
 assert.equal(result.data.availableGlobalMicroUsd, 565_186, 'global accounted already includes these amounts');
 assert.equal(result.data.remainingCeilingMicroUsd, 5_140_000, 'already observed turns do not receive new hypothetical reservations');
 assert.equal(result.data.observedTurnCount, 2);
 assert.equal(result.data.nextUnobservedTurnId, input.ceilings[2].turnId, 'financial index only, not the controller next action');
 assert.ok(result.data.stopReasons.includes('UNSETTLED_RESERVATIONS'));
 assert.equal(result.data.readyToExecute, false);
});

test('rejects inconsistent consumption rather than fabricating completed progress or cheaper unknown usage', () => {
 const input = fixture();
 const first = { turnId: input.ceilings[0].turnId, reservationId: 'reserve-1', evidenceRef: 'audit-1', observedAt,
  status: 'settled', reservedMicroUsd: 60_000, costMicroUsd: 10_000 };
 const second = { ...first, turnId: input.ceilings[1].turnId, reservationId: 'reserve-2' };
 for (const consumption of [
  [first, first], [{ ...first, turnId: 'foreign-turn' }], [second], [first, { ...second, reservationId: first.reservationId }],
  [{ ...first, costMicroUsd: 60_001 }], [{ ...first, status: 'unknown', costMicroUsd: 1 }],
  [{ ...first, status: 'reserved', costMicroUsd: null }, second],
  [{ ...first, observedAt: '2026-09-14T00:28:01.000Z' }],
 ]) assert.equal(planner.analyzeBudget({ ...input, consumption }).success, false);
 assert.equal(planner.analyzeBudget({ ...input, consumption: [first], budgetSnapshot: { ...input.budgetSnapshot, accountedMicroUsd: 9_999 } }).success, false);
 assert.equal(planner.analyzeBudget({ ...input, consumption: [{ ...first, status: 'reserved', costMicroUsd: null }] }).success, false,
  'the global snapshot cannot omit an observed outstanding reservation');
 const exceeded = planner.analyzeBudget({ ...input, consumption: [{ ...first, reservedMicroUsd: 70_001 }] });
 assert.ok(exceeded.success); assert.ok(exceeded.data.stopReasons.includes('OBSERVED_CEILING_EXCEEDED'));
});

test('reports dated balance and rolling same-actor capacity boundaries, stopping on stale or insufficient observations', () => {
 const input = fixture(), result = planner.analyzeBudget(input); assert.ok(result.success);
 assert.equal(result.data.daily.availableMessages, 46);
 assert.equal(result.data.daily.nextStageMessages, 33);
 assert.equal(result.data.daily.controlMessageSlots, 2);
 assert.equal(result.data.daily.nextStageFitsWindow, true);
 assert.equal(result.data.daily.allRemainingFitWindow, false);
 assert.deepEqual(result.data.snapshotTimes, { budget: observedAt, daily: observedAt });
 assert.ok(result.data.pending.includes('EXACT_PAYLOAD_AND_DEADLINE_UNAVAILABLE'));
 const exhausted = planner.analyzeBudget({ ...input, budgetSnapshot: { ...input.budgetSnapshot, accountedMicroUsd: 930_001 },
  dailySnapshot: { ...input.dailySnapshot, usedMessages: 66 } });
 assert.ok(exhausted.success);
 assert.ok(exhausted.data.stopReasons.includes('NEXT_CEILING_UNCOVERED'));
 assert.ok(exhausted.data.stopReasons.includes('ACTOR_WINDOW_INSUFFICIENT'));
 const boundary = planner.analyzeBudget({ ...input, budgetSnapshot: { ...input.budgetSnapshot, accountedMicroUsd: 930_000 },
  dailySnapshot: { ...input.dailySnapshot, usedMessages: 65 } });
 assert.ok(boundary.success); assert.equal(boundary.data.nextCeilingCoveredAtSnapshot, true);
 assert.equal(boundary.data.daily.nextStageFitsWindow, true); assert.equal(boundary.data.readyToExecute, false);
 const stale = planner.analyzeBudget({ ...input, asOf: '2026-09-14T00:28:41.001Z' });
 assert.ok(stale.success); assert.ok(stale.data.stopReasons.includes('SNAPSHOT_STALE'));
 assert.equal(planner.analyzeBudget({ ...input, asOf: '2026-09-14T00:27:40.999Z' }).success, false);
 assert.equal(planner.analyzeBudget({ ...input, dailySnapshot: { ...input.dailySnapshot, actorUserId: 'other-actor' } }).success, false);
 for (const budgetSnapshot of [{ ...input.budgetSnapshot, gateId: 'new-gate' }, { ...input.budgetSnapshot, limitMicroUsd: 2_000_000 }]) {
  assert.equal(planner.analyzeBudget({ ...input, budgetSnapshot }).success, false);
 }
});

test('binds the existing offline T1 artifact only as historical reference, leaving all T2 and actual future payloads unmeasured', async () => {
 const bytes = await readFile(new URL('../docs/sprints/SPRINT-04-META-T1-BOUNDS-20260911.json', import.meta.url));
 const data = JSON.parse(bytes.toString()).result.data;
 const historicalT1 = { artifactSha256: createHash('sha256').update(bytes).digest('hex'), kind: data.kind,
  contentHash: data.contentHash, model: data.model, localVersionId: data.localVersionId, observedAt: data.observedAt,
  samples: data.samples.map((s: { caseId: string; payloadBytes: number; inputTokenBound: number; reservedMicroUsd: number }) => ({
   caseId: s.caseId, payloadBytes: s.payloadBytes, inputTokenBound: s.inputTokenBound, reservedMicroUsd: s.reservedMicroUsd,
  })) };
 const input = fixture(), result = planner.analyzeBudget({ ...input, historicalT1 }); assert.ok(result.success);
 assert.equal(result.data.historicalT1?.referenceReservationSumMicroUsd, 3_672_854);
 assert.equal(result.data.historicalT1?.firstTurnCount, 63);
 assert.equal(result.data.historicalT1?.sourceVerified, false);
 assert.equal(result.data.historicalT1?.appliesToCurrentPayload, false);
 assert.equal(result.data.historicalT1?.artifactSha256, historicalT1.artifactSha256);
 assert.equal(result.data.historicalT1?.observedAt, '2026-09-11T23:03:27.303Z');
 assert.ok(result.data.turns.filter(t => t.turn === 2).every(t => t.historicalFirstTurn === null));
 assert.equal(result.data.turns.filter(t => t.historicalFirstTurn !== null).length, 63);
 assert.equal(result.data.turns[0].historicalFirstTurn?.reservedMicroUsd, 58_490);
 assert.equal(result.data.reportedSettledCostMicroUsd, 0, 'the offline reference is not consumption');
 assert.equal(result.data.totalCeilingMicroUsd, 5_310_000, 'explicit ceilings are never silently replaced with observed historical reservations');
 for (const reference of [
  { ...historicalT1, contentHash: 'f'.repeat(64) }, { ...historicalT1, model: 'different-model' },
  { ...historicalT1, samples: historicalT1.samples.slice(1) },
  { ...historicalT1, samples: historicalT1.samples.map((s: object, i: number) => i === 1 ? historicalT1.samples[0] : s) },
  { ...historicalT1, samples: historicalT1.samples.map((s: object, i: number) => i === 0 ? { ...s, inputTokenBound: 16_195 } : s) },
  { ...historicalT1, samples: historicalT1.samples.map((s: object, i: number) => i === 0 ? { ...s, reservedMicroUsd: 58_489 } : s) },
  { ...historicalT1, observedAt: '2026-09-15T00:00:00.000Z' },
 ]) assert.equal(planner.analyzeBudget({ ...input, historicalT1: reference }).success, false);
});

test('a financially observed full prefix still cannot declare the campaign approved or issue another turn', () => {
 const input = fixture();
 const result = planner.analyzeBudget({ ...input, budgetSnapshot: { ...input.budgetSnapshot, accountedMicroUsd: 431_814 },
  consumption: input.ceilings.map((ceiling, index) => ({ turnId: ceiling.turnId, reservationId: `reserve-${index}`,
   evidenceRef: `audit-${index}`, observedAt, status: 'settled', reservedMicroUsd: 60_000, costMicroUsd: 1_000 })) });
 assert.ok(result.success); assert.equal(result.data.observedTurnCount, 72);
 assert.equal(result.data.reportedSettledCostMicroUsd, 72_000); assert.equal(result.data.retainedReservationsMicroUsd, 0);
 assert.equal(result.data.remainingCeilingMicroUsd, 0); assert.equal(result.data.nextUnobservedTurnId, null);
 assert.equal(result.data.nextCeilingCoveredAtSnapshot, null); assert.equal(result.data.readyToExecute, false);
 assert.ok(result.data.pending.includes('OBJECTIVE_AND_HUMAN_GATES_NOT_VERIFIED'));
});

test('the calculation uses supplied time only, performs no fetch and returns sanitized errors for invalid input', () => {
 const input = fixture(), originalFetch = globalThis.fetch, originalNow = Date.now;
 try {
  globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
  Date.now = () => { throw new Error('unexpected wall clock'); };
  assert.ok(planner.analyzeBudget(input).success);
  assert.equal(planner.analyzeBudget({ ...input, unknown: 'must not be accepted' }).success, false);
  assert.equal(planner.analyzeBudget({ ...input, controlMessageSlots: 0 }).success, false);
  const poisoned = Object.defineProperty({}, 'plan', { get() { throw new Error('private-error-value'); } });
  assert.deepEqual(planner.analyzeBudget(poisoned), { success: false, error: { code: 'ANALYSIS_FAILED' } });
 } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test('rejects impossible timezone offsets in every analysis, snapshot, consumption and historical timestamp', () => {
 const input = fixture(), impossible = '2026-09-14T01:00:00+99:99';
 assert.ok(Number.isNaN(Date.parse(impossible)));
 const consumption = [{ turnId: input.ceilings[0].turnId, reservationId: 'reserve-time', evidenceRef: 'audit-time',
  observedAt, status: 'settled', reservedMicroUsd: 60_000, costMicroUsd: 10_000 }];
 const historicalT1 = { artifactSha256: 'e'.repeat(64), kind: 'offline-first-turn-preparation',
  contentHash: input.plan.request.target.contentHash, model: input.plan.request.target.model,
  localVersionId: 'timestamp-fixture-only', observedAt,
  samples: input.plan.request.cases.map(c => ({ caseId: c.caseId, payloadBytes: 10_000, inputTokenBound: 14_096, reservedMicroUsd: 53_240 })) };
 const valid = { ...input, consumption, historicalT1 };
 assert.ok(planner.analyzeBudget(valid).success, 'the fixture must be valid before corrupting only a timestamp');
 assert.ok(planner.analyzeBudget({ ...valid, asOf: '2026-09-13T21:28:00-03:00' }).success);
 for (const [field, changed] of [
  ['asOf', { ...valid, asOf: impossible }],
  ['budgetSnapshot', { ...valid, budgetSnapshot: { ...valid.budgetSnapshot, observedAt: impossible } }],
  ['dailySnapshot', { ...valid, dailySnapshot: { ...valid.dailySnapshot, observedAt: impossible } }],
  ['consumption', { ...valid, consumption: [{ ...consumption[0], observedAt: impossible }] }],
  ['historicalT1', { ...valid, historicalT1: { ...historicalT1, observedAt: impossible } }],
 ] as const) {
  const result = planner.analyzeBudget(changed);
  assert.equal(result.success, false, field);
  if (!result.success) assert.equal(result.error.code, 'INVALID_INPUT');
 }
});
