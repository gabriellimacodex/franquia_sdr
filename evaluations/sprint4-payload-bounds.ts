import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { PayloadBoundsInputSchema, type FirstTurnBound, type PayloadBoundsResult, type PayloadBoundsSpec } from './sprint4-payload-bounds.spec.js';
import { SPRINT4_CASES } from './sprint4-campaign.spec.js';
import { snapshotHash, Versioning } from '../src/versioning.js';
import { seedPilot } from '../src/seed.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import type { Database, Queryable } from '../src/database.js';
import { testConfig } from '../tests/config.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class Sprint4PayloadBounds implements PayloadBoundsSpec {
  async execute(raw: unknown): Promise<PayloadBoundsResult> {
    const parsed = PayloadBoundsInputSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: { code: 'INVALID_INPUT', message: 'Invalid offline bound input' } };
    if (snapshotHash(parsed.data.snapshot) !== parsed.data.expectedContentHash) return { success: false, error: { code: 'HASH_MISMATCH', message: 'Snapshot content hash mismatch' } };
    // An ephemeral database only. No production URL, DB adapter or credentials are accepted.
    const pg = new PGlite({ extensions: { vector } });
    const db: Database = { query: (sql, params) => pg.query(sql, params), transaction: fn => pg.transaction(tx => fn(tx as Queryable)), close: () => pg.close() };
    try {
      for (const file of ['001_sdr.sql', '002_versions.sql', '003_lab_sessions.sql']) {
        await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
      }
      const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'offline-campaign-admin', role: 'admin' };
      const initial = await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Offline fixture' }], adminUserIds: [user.userId] });
      const saved = await new Versioning(db).saveDraft(user, parsed.data.snapshot, user.userId);
      if (!saved.ok || saved.value.contentHash !== parsed.data.expectedContentHash) throw new Error('Offline draft mismatch');
      const sessions = new LabSessions(db), store = new Store(db);
      let calls = 0;
      const engine = new Engine(store, { ...testConfig, EXECUTION_MODE: 'laboratory', PUBLIC_API_URL: parsed.data.publicApiUrl }, async () => {
        calls++; throw new Error('Offline preparation forbids all transport calls');
      });
      const samples: FirstTurnBound[] = [];
      for (const item of SPRINT4_CASES) {
        const created = await sessions.createEvaluation(user, { requestId: randomUUID(), label: 'Offline ' + item.caseId, scenario: 'free', versionId: saved.value.versionId, contentHash: saved.value.contentHash });
        if (!created.ok) throw new Error('Offline session creation failed');
        const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text: item.inputs[0] });
        if (!sent.ok || !sent.value.jobId) throw new Error('Matrix contains an unprepared control turn');
        const channel = await store.scopeForJob(sent.value.jobId), job = await store.claim(channel);
        if (!job || job.id !== sent.value.jobId || channel.kind !== 'laboratory') throw new Error('Offline claim mismatch');
        // prepare only: never dispatch, complete, reserve, validate or publish.
        const payload = await engine.prepare(channel, job);
        if (payload.configVersion !== saved.value.versionId || payload.model !== parsed.data.snapshot.model
          || payload.context.messages.length !== 1 || payload.context.messages[0].text !== item.inputs[0]
          || payload.context.lead.facts.length || payload.context.lead.relations.length || payload.context.lead.referral !== null) throw new Error('Offline first-turn context mismatch');
        const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
        const inputTokenBound = payloadBytes + 4096;
        samples.push({ caseId: item.caseId, payloadBytes, payloadSha256: digest(payload), inputTokenBound,
          reservedMicroUsd: Math.ceil(inputTokenBound * 2.5 + 1200 * 15),
          sourceIds: payload.context.sources.map(source => source.id), outputSchemaHash: digest(payload.outputSchema) });
        // Test-fixture cleanup, not a model result: do not reclaim an earlier 15s lease
        // when the offline machine is slow. There is no reservation to release.
        await db.query("UPDATE sdr.jobs SET state='stale',error_code='OFFLINE_PREPARATION_ONLY' WHERE id=$1", [job.id]);
      }
      const counts = (await db.query<{ reservations: number; publications: number; validations: number; active_jobs: number; active_version: string }>(`SELECT
        (SELECT count(*)::int FROM sdr.events WHERE type='lab_model_budget_reserved') AS reservations,
        (SELECT count(*)::int FROM sdr.publication_events) AS publications,
        (SELECT count(*)::int FROM sdr.validation_runs) AS validations,
        (SELECT count(*)::int FROM sdr.jobs WHERE state IN ('pending','working','running','ready')) AS active_jobs,
        (SELECT version_id FROM sdr.active_versions) AS active_version`)).rows[0];
      if (calls || counts.reservations || counts.publications || counts.validations || counts.active_jobs || counts.active_version !== initial.versionId) throw new Error('Offline invariants failed');
      return { success: true, data: { kind: 'offline-first-turn-preparation', readyToExecute: false,
        contentHash: saved.value.contentHash, model: parsed.data.snapshot.model, localVersionId: saved.value.versionId,
        remoteVersionVerified: false, observedAt: new Date().toISOString(), samples, unknownSecondTurnCases: ['C01', 'C02', 'C03'],
        modelCalls: 0, reservationsCreated: 0, publicationsCreated: 0, validationReportsCreated: 0, activeFixtureJobs: counts.active_jobs,
        campaignCostMicroUsd: null, additionalMoneyRequiredMicroUsd: null } };
    } catch {
      return { success: false, error: { code: 'OFFLINE_PREPARATION_FAILED', message: 'Offline preparation failed; no campaign is authorized' } };
    } finally { await db.close(); }
  }
}
