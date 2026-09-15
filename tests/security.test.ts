import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, tokenMatches } from '../src/security.js';

test('webhook validates the original bytes, rejecting edited JSON and missing signatures', () => {
  const raw = Buffer.from('{ "message": "ação" }');
  const secret = 'only-a-synthetic-test-secret';
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifySignature(raw, signature, secret), true);
  assert.equal(verifySignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), signature, secret), false);
  assert.equal(verifySignature(raw, undefined, secret), false);
  assert.equal(verifySignature(raw, 'short', secret), false);
  assert.equal(tokenMatches('Bearer '+secret, secret), true);
  assert.equal(tokenMatches('Bearer undefined', undefined), false);
});
