import { z } from 'zod';
import { SnapshotSchema } from '../src/engine.js';

export const PayloadBoundsInputSchema = z.object({
  snapshot: SnapshotSchema.refine(value => value.outputContract === 'financial-v2'
    && value.tenant.tenantId === 'cognita-homologacao' && value.tenant.brandId === 'sapore'),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  publicApiUrl: z.literal('https://sdr-api.cognitaai.com.br'),
}).strict();
export interface FirstTurnBound {
  caseId: string; payloadBytes: number; payloadSha256: string;
  inputTokenBound: number; reservedMicroUsd: number; sourceIds: string[]; outputSchemaHash: string;
}
export interface PayloadBoundsReport {
  kind: 'offline-first-turn-preparation'; readyToExecute: false;
  contentHash: string; model: 'gpt-5.4-2026-03-05'; localVersionId: string; remoteVersionVerified: false;
  observedAt: string; samples: FirstTurnBound[]; unknownSecondTurnCases: ['C01', 'C02', 'C03'];
  modelCalls: 0; reservationsCreated: 0; publicationsCreated: 0; validationReportsCreated: 0; activeFixtureJobs: number;
  campaignCostMicroUsd: null; additionalMoneyRequiredMicroUsd: null;
}
export type PayloadBoundsResult = { success: true; data: PayloadBoundsReport }
  | { success: false; error: { code: 'INVALID_INPUT' | 'HASH_MISMATCH' | 'OFFLINE_PREPARATION_FAILED'; message: string } };
export interface PayloadBoundsSpec { execute(raw: unknown): Promise<PayloadBoundsResult> }
