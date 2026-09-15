import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSnapshot } from '../src/seed.js';
import { SnapshotSchema } from '../src/engine.js';
import { snapshotHash } from '../src/versioning.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';

test('financial v2 requires a new explicit snapshot while legacy hashes and model remain unchanged', () => {
  const original = initialSnapshot({ tenantId: 'tenant', brandId: 'sapore' });
  const before = structuredClone(original);
  const hash = snapshotHash(original);
  assert.equal(snapshotHash(SnapshotSchema.parse(original)), hash);
  assert.equal(Object.hasOwn(SnapshotSchema.parse(original), 'outputContract'), false);
  const next = createFinancialDraftSnapshot(original);
  assert.equal(next.outputContract, 'financial-v2');
  assert.notEqual(snapshotHash(next), hash);
  assert.deepEqual(original, before);
  assert.equal(next.model, original.model);
  assert.deepEqual(next.sources, original.sources);
  assert.deepEqual(next.tenant, original.tenant);
  assert.ok(next.prompt.includes('financialReply'));
  assert.ok(next.prompt.includes('bubbles=[]'));
  assert.deepEqual(createFinancialDraftSnapshot(next), next);
});
