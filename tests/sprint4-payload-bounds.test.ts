import test from 'node:test';
import assert from 'node:assert/strict';
import { Sprint4PayloadBounds } from '../evaluations/sprint4-payload-bounds.js';
import { initialSnapshot } from '../src/seed.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { snapshotHash } from '../src/versioning.js';

const snapshot = createFinancialDraftSnapshot(initialSnapshot({ tenantId: 'cognita-homologacao', brandId: 'sapore' }));
const input = { snapshot, expectedContentHash: snapshotHash(snapshot), publicApiUrl: 'https://sdr-api.cognitaai.com.br' };

test('thirty real first-turn preparations are measured offline without pretending to know later model context or cost', async () => {
  const result = await new Sprint4PayloadBounds().execute(input);
  assert.ok(result.success);
  assert.equal(result.data.samples.length, 30); assert.equal(new Set(result.data.samples.map(sample => sample.caseId)).size, 30);
  assert.equal(result.data.contentHash, input.expectedContentHash); assert.equal(result.data.readyToExecute, false);
  assert.equal(result.data.remoteVersionVerified, false);
  assert.deepEqual(result.data.unknownSecondTurnCases, ['C01', 'C02', 'C03']);
  for (const sample of result.data.samples) {
    assert.ok(sample.payloadBytes > 0); assert.equal(sample.inputTokenBound, sample.payloadBytes + 4096);
    assert.equal(sample.reservedMicroUsd, Math.ceil(sample.inputTokenBound * 2.5 + 1200 * 15));
    assert.match(sample.payloadSha256, /^[a-f0-9]{64}$/); assert.match(sample.outputSchemaHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(result.data.modelCalls, 0); assert.equal(result.data.reservationsCreated, 0);
  assert.equal(result.data.publicationsCreated, 0); assert.equal(result.data.validationReportsCreated, 0);
  assert.equal(result.data.activeFixtureJobs, 0, 'prepared fixture jobs must not be reclaimed when their leases expire');
  assert.equal(result.data.campaignCostMicroUsd, null); assert.equal(result.data.additionalMoneyRequiredMicroUsd, null);
});

test('offline measurement rejects hash, scope, model and URL mismatches without accepting runtime credentials', async () => {
  const service = new Sprint4PayloadBounds();
  const mismatch = await service.execute({ ...input, expectedContentHash: 'a'.repeat(64) });
  assert.equal(mismatch.success, false); if (!mismatch.success) assert.equal(mismatch.error.code, 'HASH_MISMATCH');
  for (const invalid of [
    {}, { ...input, publicApiUrl: 'https://another.example' }, { ...input, DATABASE_URL: 'not-accepted' },
    { ...input, snapshot: { ...snapshot, model: 'other-model' } },
    { ...input, snapshot: initialSnapshot({ tenantId: 'cognita-homologacao', brandId: 'sapore' }) },
    { ...input, snapshot: { ...snapshot, tenant: { ...snapshot.tenant, tenantId: 'other' } } },
  ]) {
    const result = await service.execute(invalid); assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, 'INVALID_INPUT');
  }
});
