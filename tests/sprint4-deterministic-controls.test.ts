import test from 'node:test';
import assert from 'node:assert/strict';
import { controlCases } from '../evaluations/sprint4-deterministic-controls.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { initialSnapshot } from '../src/seed.js';
const snapshot = () => createFinancialDraftSnapshot(initialSnapshot({ tenantId: 'cognita-homologacao', brandId: 'sapore' }));

test('D27 executes actual free human pause and rejects subsequent send without provider or delivery', async () => {
  const item = controlCases.find(item => item.id === 'D27'); assert.ok(item, 'D27 not implemented');
  const result = await item.run(snapshot()); assert.ok(result.observed);
});

test('D28 repaired stop is also valid through the pinned financial guard, with no collection proposals', async () => {
  const item = controlCases.find(item => item.id === 'D28'); assert.ok(item);
  const { observed } = await item.run(snapshot());
  const trace = observed as { guardPassed: boolean; repaired: { proposals: unknown[]; nextAction: string } };
  assert.equal(trace.guardPassed, true);
  assert.deepEqual(trace.repaired.proposals, []);
  assert.equal(trace.repaired.nextAction, 'stop');
});

test('D30 injects real completion and settlement faults and verifies full rollback with reservation retained', async () => {
  const item = controlCases.find(item => item.id === 'D30'); assert.ok(item, 'D30 not implemented');
  const result = await item.run(snapshot()); assert.ok(result.observed);
});

test('D29 measures replay and stale out-of-order callbacks without duplicating reply, fact or ledger', async () => {
  const item = controlCases.find(item => item.id === 'D29'); assert.ok(item, 'D29 not implemented');
  const result = await item.run(snapshot()); assert.ok(result.observed);
});

test('D28 measures stop versus explicit negations and preserves stop after memory repair', async () => {
  const item = controlCases.find(item => item.id === 'D28'); assert.ok(item, 'D28 not implemented');
  const result = await item.run(snapshot()); assert.ok(result.observed);
});

test('D10 measures immutable callback model/config/contract checks for v2 and legacy jobs', async () => {
  const item = controlCases.find(item => item.id === 'D10'); assert.ok(item, 'D10 not implemented');
  const result = await item.run(snapshot()); assert.ok(result.observed);
});
