import { DeterministicInputSchema, DeterministicObservationSchema, DeterministicReportSchema, type DeterministicReport, type DeterministicCase, type DeterministicResult, type DeterministicSuiteSpec } from './sprint4-deterministic.spec.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { initialSnapshot } from '../src/seed.js';
import { snapshotHash } from '../src/versioning.js';

export const DETERMINISTIC_HASH = snapshotHash(createFinancialDraftSnapshot(initialSnapshot({ tenantId: 'cognita-homologacao', brandId: 'sapore' })));

export class DeterministicSuite implements DeterministicSuiteSpec {
  constructor(private readonly cases: readonly DeterministicCase[]) {}
  async execute(_input: unknown): Promise<DeterministicResult> {
    if (!DeterministicInputSchema.safeParse(_input).success) return { ok: false, error: 'INVALID_INPUT' };
    const ids = this.cases.map(item => item.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(Array.from({ length: 30 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`))) {
      return { ok: false, error: 'INVALID_CATALOG' };
    }
    try {
      const snapshot = createFinancialDraftSnapshot(initialSnapshot({ tenantId: 'cognita-homologacao', brandId: 'sapore' }));
      if (snapshotHash(snapshot) !== DETERMINISTIC_HASH || snapshot.model !== 'gpt-5.4-2026-03-05') return { ok: false, error: 'SNAPSHOT_MISMATCH' };
      const startedAt = new Date().toISOString();
      const results: DeterministicReport['results'] = [];
      for (const repetition of [1, 2]) for (const item of [...this.cases].sort((a, b) => a.id.localeCompare(b.id))) {
        const started = performance.now();
        try {
          const observation = DeterministicObservationSchema.parse(await item.run(structuredClone(snapshot)));
          results.push({ id: item.id, repetition, fixture: item.fixture, expected: item.expected, status: 'passed', input: observation.input, observed: observation.observed, durationMs: performance.now() - started });
        } catch (error) {
          results.push({ id: item.id, repetition, fixture: item.fixture, expected: item.expected, status: 'failed', error: error instanceof Error ? error.message : 'Case threw a non-Error value', durationMs: performance.now() - started });
        }
      }
      const report = DeterministicReportSchema.parse({
        suite: 'sprint4-deterministic', execution: 'measured', environment: 'local-fictional-no-model',
        snapshotHash: snapshotHash(snapshot), model: snapshot.model, startedAt, finishedAt: new Date().toISOString(),
        scenarioCount: 30, repeatCount: 2, results,
        criticalViolations: results.filter(row => row.status === 'failed').map(row => `${row.id}/R${row.repetition}`),
        humanAverage: null, remoteCalls: 0, modelCalls: 0,
      });
      return { ok: true, report };
    } catch { return { ok: false, error: 'RUN_FAILED' }; }
  }
}
