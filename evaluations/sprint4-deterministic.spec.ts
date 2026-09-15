import { z } from 'zod';
import type { Snapshot } from '../src/versioning.js';

export const DeterministicInputSchema = z.object({ repetitions: z.literal(2) }).strict();
const EvidenceSchema = z.unknown().refine(value => value !== undefined, 'Evidence must be explicitly present');
export const DeterministicObservationSchema = z.object({ input: EvidenceSchema, observed: EvidenceSchema }).strict();
export type DeterministicObservation = z.infer<typeof DeterministicObservationSchema>;
/** Runs actual local product code with fictional inputs. Assertions throw on divergence. */
export interface DeterministicCase {
  id: string;
  expected: string;
  fixture: string;
  run(snapshot: Snapshot): DeterministicObservation | Promise<DeterministicObservation>;
}
export const DeterministicReportSchema = z.object({
  suite: z.literal('sprint4-deterministic'), execution: z.literal('measured'),
  environment: z.literal('local-fictional-no-model'),
  snapshotHash: z.string().length(64), model: z.literal('gpt-5.4-2026-03-05'),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  scenarioCount: z.literal(30), repeatCount: z.literal(2),
  results: z.array(z.object({
    id: z.string(), repetition: z.number().int().min(1).max(2),
    fixture: z.string(), expected: z.string(), durationMs: z.number().nonnegative(),
    status: z.enum(['passed', 'failed']), input: z.unknown().optional(),
    observed: z.unknown().optional(), error: z.string().optional(),
  })).length(60),
  criticalViolations: z.array(z.string()), humanAverage: z.null(),
  remoteCalls: z.literal(0), modelCalls: z.literal(0),
});
export type DeterministicReport = z.infer<typeof DeterministicReportSchema>;
export type DeterministicResult =
  | { ok: true; report: DeterministicReport }
  | { ok: false; error: 'INVALID_INPUT' | 'INVALID_CATALOG' | 'SNAPSHOT_MISMATCH' | 'RUN_FAILED' };
export interface DeterministicSuiteSpec { execute(input: unknown): Promise<DeterministicResult> }
