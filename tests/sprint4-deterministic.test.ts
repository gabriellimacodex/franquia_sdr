import test from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicSuite } from '../evaluations/sprint4-deterministic.js';

test('deterministic evidence refuses an incomplete or duplicate catalog before executing it', async () => {
  let called = 0;
  const repeated = { id: 'D01', fixture: 'test-only', expected: 'not run', run() { called++; return { input: null, observed: null }; } };
  for (const cases of [[], [repeated], Array.from({ length: 30 }, () => repeated)]) {
    assert.deepEqual(await new DeterministicSuite(cases).execute({ repetitions: 2 }), { ok: false, error: 'INVALID_CATALOG' });
  }
  assert.equal(called, 0);
});

test('missing evidence and metadata spoofing cannot be recorded as passing observations', async () => {
  const cases = Array.from({ length: 30 }, (_, i) => ({
    id: `D${String(i + 1).padStart(2, '0')}`, fixture: 'runner-unit-test-only', expected: 'evidence required',
    run() {
      if (i === 0) return { input: undefined, observed: undefined };
      if (i === 1) return { input: null, observed: null, id: 'D99', status: 'passed', repetition: 1 };
      return { input: null, observed: null };
    },
  }));
  // @ts-expect-error Deliberately violates the typed port to test runtime rejection of absent evidence.
  const result = await new DeterministicSuite(cases).execute({ repetitions: 2 }); assert.ok(result.ok);
  assert.deepEqual(result.report.criticalViolations, ['D01/R1', 'D02/R1', 'D01/R2', 'D02/R2']);
  assert.equal(result.report.results.some(row => row.id === 'D99'), false);
});

test('a caller cannot reduce repetitions or inject extra suite options', async () => {
  for (const input of [{ repetitions: 1 }, { repetitions: 2, approve: true }, null]) {
    assert.deepEqual(await new DeterministicSuite([]).execute(input), { ok: false, error: 'INVALID_INPUT' });
  }
});

test('runner measures two isolated repetitions and records failures without fabricating approval', async () => {
  const cases = Array.from({ length: 30 }, (_, i) => ({
    id: `D${String(i + 1).padStart(2, '0')}`, fixture: 'runner-unit-test-only', expected: 'unit assertion',
    run(snapshot: { prompt: string }) {
      assert.ok(snapshot.prompt.includes('financialReply'));
      snapshot.prompt = 'mutation must not reach the next case';
      if (i === 1) throw new Error('intentional unit divergence');
      return { input: i, observed: 'unit fixture only' };
    },
  }));
  const result = await new DeterministicSuite(cases).execute({ repetitions: 2 });
  assert.ok(result.ok);
  assert.equal(result.report.results.length, 60);
  assert.deepEqual(result.report.criticalViolations, ['D02/R1', 'D02/R2']);
  assert.equal(result.report.results.filter(row => row.status === 'passed').length, 58);
  assert.ok(result.report.results.every(row => row.durationMs >= 0));
  assert.equal(result.report.snapshotHash, 'c655e440fef8dddf5dd855a42d1299a59044b2c598e986bf5a4b1b7c1d9cb959');
  assert.equal(result.report.humanAverage, null);
});
