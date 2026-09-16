import test from 'node:test';
import assert from 'node:assert/strict';
import { financeCases } from '../evaluations/sprint4-deterministic-finance.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { initialSnapshot } from '../src/seed.js';
import { snapshotHash } from '../src/versioning.js';
import { DETERMINISTIC_HASH } from '../evaluations/sprint4-deterministic.js';

async function run(id: string) {
  const snapshot = createFinancialDraftSnapshot(initialSnapshot({ tenantId: 'cognita-homologacao', brandId: 'sapore' }));
  assert.equal(snapshotHash(snapshot), DETERMINISTIC_HASH);
  const before = structuredClone(snapshot), item = financeCases.find(item => item.id === id);
  assert.ok(item, `Missing deterministic case ${id}`);
  const result = await item.run(snapshot);
  assert.deepEqual(snapshot, before, 'A case must not mutate the pinned input snapshot');
  assert.ok(item.expected); assert.ok(item.fixture);
  assert.ok(result.input); assert.ok(result.observed);
  return result;
}

test('D01 runs real financial rendering and declared fact merge', async () => { await run('D01'); });
test('D02 rejects a fabricated capital quotation', async () => { await run('D02'); });
test('D03 rejects attribution to a different message ID', async () => { await run('D03'); });
test('D04 rejects a canonical message belonging to another tenant', async () => { await run('D04'); });
test('D05 rejects a canonical message belonging to another brand', async () => { await run('D05'); });
test('D06 rejects a canonical message belonging to another candidate', async () => { await run('D06'); });
test('D07 rejects a canonical message from another conversation', async () => { await run('D07'); });
test('D08 rejects assistant-authored capital as candidate evidence', async () => { await run('D08'); });
test('D09 rejects a monetary declaration available only in an old turn', async () => { await run('D09'); });
test('D11 excludes an expired source in real retrieval and rejects its reference', async () => { await run('D11'); });
test('D12 excludes an inactive canonical source despite a stale active index', async () => { await run('D12'); });
test('D13 excludes an unapproved canonical source despite an approved index', async () => { await run('D13'); });
test('D14 rejects a foreign-scope commercial source in retrieval and guard', async () => { await run('D14'); });
test('D15 rejects duplicated approved source identifiers', async () => { await run('D15'); });
test('D16 rejects converting candidate capital into a brand price in prose', async () => { await run('D16'); });
test('D17 rejects an unsupported working-capital coverage claim', async () => { await run('D17'); });
test('D18 rejects converting credit or third-party money into own available capital', async () => { await run('D18'); });
test('D19 rejects changing or summing a correctly quoted monetary value', async () => { await run('D19'); });
test('D20 merges compatible capital correction as a conflict without replacing history', async () => { await run('D20'); });
test('D21 rejects replacement of an incompatible or foreign-candidate fact', async () => { await run('D21'); });
