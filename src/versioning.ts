import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scoped, type Database, type Queryable, type Scope } from './database.js';
import { SnapshotSchema } from './engine.js';
import { attempt, ServiceError, type Result } from './security.js';
import { indexVersionKnowledge } from './knowledge.js';

export type Snapshot = z.infer<typeof SnapshotSchema>;
export interface Draft { versionId: string; contentHash: string; snapshot: Snapshot; restoredFromVersionId: string | null }
export const ValidationReportSchema = z.object({
  suiteType: z.enum(['deterministic', 'conversation']), execution: z.enum(['measured', 'synthetic']),
  scenarioCount: z.number().int().nonnegative(), repeatCount: z.number().int().nonnegative(),
  criticalViolations: z.array(z.string()), humanAverage: z.number().min(1).max(5).nullable(),
  evidenceRefs: z.array(z.string().min(1)).min(1), model: z.string().min(1).nullable(),
}).strict();
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export interface ValidationState { ready: boolean; reasons: string[]; validationIds: string[] }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
export function snapshotHash(snapshot: Snapshot): string { return createHash('sha256').update(canonical(snapshot)).digest('hex'); }

export async function readValidationState(tx: Queryable, scope: Scope, contentHash: string, model: string): Promise<ValidationState> {
  const rows = (await tx.query<{ id: string; suite_type: string; report: unknown }>(`SELECT DISTINCT ON (suite_type) id,suite_type,report FROM sdr.validation_runs
    WHERE tenant_id=$1 AND brand_id=$2 AND content_hash=$3 ORDER BY suite_type,sequence DESC`, [scope.tenantId, scope.brandId, contentHash])).rows;
  const reasons: string[] = [];
  for (const suite of ['deterministic', 'conversation']) {
    const row = rows.find(item => item.suite_type === suite);
    if (!row) { reasons.push('missing_' + suite); continue; }
    const parsed = ValidationReportSchema.safeParse(row.report);
    if (!parsed.success) { reasons.push('invalid_' + suite); continue; }
    const report = parsed.data;
    if (report.execution !== 'measured') reasons.push('synthetic_' + suite);
    if (report.scenarioCount < 30) reasons.push('insufficient_scenarios_' + suite);
    if (report.repeatCount < 2) reasons.push('insufficient_repeats_' + suite);
    if (report.criticalViolations.length) reasons.push('critical_violation_' + suite);
    if (suite === 'conversation' && (report.humanAverage === null || report.humanAverage < 4)) reasons.push('human_rating_below_threshold');
    if (suite === 'conversation' && report.model !== model) reasons.push('model_mismatch');
  }
  return { ready: reasons.length === 0, reasons, validationIds: rows.map(row => row.id) };
}

export class Versioning {
  constructor(private db: Database) {}
  private authorized<T>(scope: Scope, actorId: string, action: (tx: Queryable) => Promise<T>): Promise<Result<T>> {
    return attempt(() => scoped(this.db, scope, async tx => {
      const membership = (await tx.query<{ role: string }>('SELECT role FROM sdr.memberships WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3 AND active', [scope.tenantId, scope.brandId, actorId])).rows[0];
      if (membership?.role !== 'admin') throw new ServiceError('FORBIDDEN', 403);
      return action(tx);
    }));
  }
  private async save(tx: Queryable, scope: Scope, raw: unknown, actorId: string, restoredFromVersionId: string | null): Promise<Draft> {
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new ServiceError('INVALID_SNAPSHOT');
    const snapshot = parsed.data;
    if (snapshot.tenant.tenantId !== scope.tenantId || snapshot.tenant.brandId !== scope.brandId) throw new ServiceError('SCOPE_MISMATCH', 403);
    const contentHash = snapshotHash(snapshot);
    await tx.query(`INSERT INTO sdr.versions(tenant_id,brand_id,id,label,snapshot,content_hash,model)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,brand_id,content_hash) DO NOTHING`, [scope.tenantId, scope.brandId, randomUUID(), `draft-${contentHash.slice(0, 12)}`, JSON.stringify(snapshot), contentHash, snapshot.model]);
    const version = (await tx.query<{ id: string }>('SELECT id FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND content_hash=$3', [scope.tenantId, scope.brandId, contentHash])).rows[0];
    const indexed = await indexVersionKnowledge(tx, scope, version.id);
    if (!indexed.ok) throw new ServiceError('KNOWLEDGE_INDEX_FAILED', 409);
    await tx.query(`INSERT INTO sdr.drafts(tenant_id,brand_id,version_id,snapshot,content_hash,restored_from_version_id,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,brand_id) DO UPDATE SET
      version_id=EXCLUDED.version_id,snapshot=EXCLUDED.snapshot,content_hash=EXCLUDED.content_hash,
      restored_from_version_id=EXCLUDED.restored_from_version_id,updated_by=EXCLUDED.updated_by,updated_at=now()`, [scope.tenantId, scope.brandId, version.id, JSON.stringify(snapshot), contentHash, restoredFromVersionId, actorId]);
    return { versionId: version.id, contentHash, snapshot, restoredFromVersionId };
  }
  saveDraft(scope: Scope, snapshot: unknown, actorId: string): Promise<Result<Draft>> {
    return this.authorized(scope, actorId, tx => this.save(tx, scope, snapshot, actorId, null));
  }
  restoreDraft(scope: Scope, versionId: string, actorId: string): Promise<Result<Draft>> {
    return this.authorized(scope, actorId, async tx => {
      const version = (await tx.query<{ snapshot: unknown }>('SELECT snapshot FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3', [scope.tenantId, scope.brandId, versionId])).rows[0];
      if (!version) throw new ServiceError('VERSION_NOT_FOUND', 404);
      return this.save(tx, scope, version.snapshot, actorId, versionId);
    });
  }
  private async draft(tx: Queryable, scope: Scope): Promise<Draft | null> {
    const row = (await tx.query<{ version_id: string; snapshot: unknown; content_hash: string; restored_from_version_id: string | null }>('SELECT * FROM sdr.drafts WHERE tenant_id=$1 AND brand_id=$2 FOR UPDATE', [scope.tenantId, scope.brandId])).rows[0];
    if (!row) return null;
    const parsed = SnapshotSchema.safeParse(row.snapshot);
    if (!parsed.success || parsed.data.tenant.tenantId !== scope.tenantId || parsed.data.tenant.brandId !== scope.brandId || snapshotHash(parsed.data) !== row.content_hash) throw new ServiceError('INVALID_DRAFT', 409);
    return { versionId: row.version_id, snapshot: parsed.data, contentHash: row.content_hash, restoredFromVersionId: row.restored_from_version_id };
  }
  getDraft(scope: Scope, actorId: string): Promise<Result<Draft | null>> { return this.authorized(scope, actorId, tx => this.draft(tx, scope)); }
  /** Trusted recorder only. Do not expose arbitrary report ingestion through a public API.
   * The authenticated recorder attests execution/evidence; this service verifies the publication
   * policy, not whether external model outputs or a human rating are scientifically valid. */
  recordValidation(scope: Scope, contentHash: string, raw: unknown, actorId: string): Promise<Result<{ validationId: string }>> {
    return this.authorized(scope, actorId, async tx => {
      const parsed = ValidationReportSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError('INVALID_REPORT');
      const report = parsed.data;
      const version = (await tx.query<{ model: string }>('SELECT model FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND content_hash=$3', [scope.tenantId, scope.brandId, contentHash])).rows[0];
      if (!version) throw new ServiceError('HASH_NOT_FOUND', 404);
      if (report.suiteType === 'conversation' && report.model !== version.model) throw new ServiceError('REPORT_MODEL_MISMATCH');
      const validationId = randomUUID();
      await tx.query('INSERT INTO sdr.validation_runs(id,tenant_id,brand_id,content_hash,suite_type,report,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7)', [validationId, scope.tenantId, scope.brandId, contentHash, report.suiteType, JSON.stringify(report), actorId]);
      return { validationId };
    });
  }
  validationState(scope: Scope, contentHash: string, actorId: string): Promise<Result<ValidationState>> {
    return this.authorized(scope, actorId, async tx => {
      const version = (await tx.query<{ model: string }>('SELECT model FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND content_hash=$3', [scope.tenantId, scope.brandId, contentHash])).rows[0];
      if (!version) throw new ServiceError('HASH_NOT_FOUND', 404);
      return readValidationState(tx, scope, contentHash, version.model);
    });
  }
  publish(scope: Scope, actorId: string, approvedHash: string): Promise<Result<{ versionId: string; contentHash: string; publicationId: string }>> {
    return this.authorized(scope, actorId, async tx => {
      const draft = await this.draft(tx, scope);
      if (!draft) throw new ServiceError('DRAFT_NOT_FOUND', 404);
      if (approvedHash !== draft.contentHash) throw new ServiceError('APPROVAL_HASH_MISMATCH', 409);
      const version = (await tx.query<{ model: string }>('SELECT model FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND content_hash=$4', [scope.tenantId, scope.brandId, draft.versionId, draft.contentHash])).rows[0];
      if (!version) throw new ServiceError('INVALID_DRAFT', 409);
      const validation = await readValidationState(tx, scope, draft.contentHash, version.model);
      if (!validation.ready) throw new ServiceError(validation.reasons.some(reason => reason.startsWith('missing_')) ? 'VALIDATION_REQUIRED' : 'QUALITY_GATE_FAILED', 409);
      const previous = (await tx.query<{ version_id: string }>('SELECT version_id FROM sdr.active_versions WHERE tenant_id=$1 AND brand_id=$2 FOR UPDATE', [scope.tenantId, scope.brandId])).rows[0];
      const publicationId = randomUUID();
      await tx.query('INSERT INTO sdr.publication_events(id,tenant_id,brand_id,version_id,previous_version_id,content_hash,approved_by,validation_run_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [publicationId, scope.tenantId, scope.brandId, draft.versionId, previous?.version_id ?? null, draft.contentHash, actorId, JSON.stringify(validation.validationIds)]);
      await tx.query('INSERT INTO sdr.active_versions(tenant_id,brand_id,version_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,brand_id) DO UPDATE SET version_id=EXCLUDED.version_id', [scope.tenantId, scope.brandId, draft.versionId]);
      if (previous && previous.version_id !== draft.versionId) {
        await tx.query("UPDATE sdr.jobs SET state='stale',error_code='VERSION_CHANGED' WHERE tenant_id=$1 AND brand_id=$2 AND version_id=$3 AND state IN ('pending','working','running','ready') AND conversation_id IN (SELECT c.id FROM sdr.conversations c JOIN sdr.channels ch ON ch.phone_number_id=c.phone_number_id WHERE c.tenant_id=$1 AND c.brand_id=$2 AND ch.kind='whatsapp')", [scope.tenantId, scope.brandId, previous.version_id]);
      }
      return { versionId: draft.versionId, contentHash: draft.contentHash, publicationId };
    });
  }
}
