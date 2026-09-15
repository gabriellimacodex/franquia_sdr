import type { Queryable, Scope } from './database.js';
import { CompletionSnapshotDataSchema, CompletionSnapshotInputSchema, type CompletionSnapshotResult, type CompletionSnapshotSpec } from './completion-snapshot.spec.js';

// Each materialized locking CTE consumes its predecessor before its own LockRows.
// scoped() MUST already have acquired the brand lock in an earlier statement: this
// statement's MVCC snapshot must be created after that lock has been acquired.
const readSql = `WITH scoped_identity AS MATERIALIZED (
  SELECT coalesce(current_setting('sdr.tenant_id',true)=$1 AND current_setting('sdr.brand_id',true)=$2,false) AS ok
), locked_job AS MATERIALIZED (
  SELECT j.* FROM sdr.jobs j CROSS JOIN scoped_identity s
  WHERE s.ok AND j.tenant_id=$1 AND j.brand_id=$2 AND j.id=$3 FOR UPDATE OF j
), locked_conversation AS MATERIALIZED (
  SELECT c.* FROM sdr.conversations c JOIN locked_job j ON c.id=j.conversation_id
  WHERE c.tenant_id=$1 AND c.brand_id=$2 FOR UPDATE OF c
), locked_candidate AS MATERIALIZED (
  SELECT p.* FROM sdr.candidates p JOIN locked_job j ON p.id=j.candidate_id
  JOIN locked_conversation c ON c.id=j.conversation_id
  WHERE p.tenant_id=$1 AND p.brand_id=$2 FOR UPDATE OF p
), pinned_version AS MATERIALIZED (
  SELECT v.snapshot FROM sdr.versions v JOIN locked_job j ON v.id=j.version_id
  JOIN locked_candidate p ON p.id=j.candidate_id WHERE v.tenant_id=$1 AND v.brand_id=$2
), candidate_messages AS MATERIALIZED (
  SELECT m.id,m.text,m.actor,m.conversation_id,m.provider_timestamp
  FROM sdr.messages m JOIN locked_candidate p ON p.id=m.candidate_id
  WHERE m.tenant_id=$1 AND m.brand_id=$2
)
SELECT (SELECT ok FROM scoped_identity) AS scope_matches,
  (SELECT to_jsonb(j) FROM locked_job j) AS job,
  (SELECT to_jsonb(c) FROM locked_conversation c) AS conversation,
  (SELECT to_jsonb(p) FROM locked_candidate p) AS candidate,
  (SELECT to_jsonb(v) FROM pinned_version v) AS version,
  coalesce((SELECT jsonb_agg(to_jsonb(m)) FROM candidate_messages m),'[]'::jsonb) AS messages`;

/** Private prototype: the caller owns the surrounding scoped transaction and all writes. */
export class CompletionSnapshot implements CompletionSnapshotSpec {
  constructor(private tx: Queryable, private scope: Scope, private now: () => Date = () => new Date()) {}
  async execute(raw: unknown): Promise<CompletionSnapshotResult> {
    const input = CompletionSnapshotInputSchema.safeParse(raw);
    if (!input.success) return { success: false, error: { code: 'INVALID_INPUT' } };
    try {
      const row = (await this.tx.query<Record<string, unknown>>(readSql, [this.scope.tenantId, this.scope.brandId, input.data.jobId])).rows[0];
      if (row.scope_matches !== true) return { success: false, error: { code: 'SCOPE_MISMATCH' } };
      if (row.job === null) return { success: false, error: { code: 'JOB_NOT_FOUND' } };
      const locked = CompletionSnapshotDataSchema.pick({ job: true, conversation: true, candidate: true }).safeParse({
        job: row.job, conversation: row.conversation, candidate: row.candidate,
      });
      if (!locked.success) return { success: false, error: { code: 'INCONSISTENT_SNAPSHOT' } };
      const { job, conversation, candidate } = locked.data;
      if (!['working', 'running'].includes(job.state) || job.context_version !== input.data.contextVersion
        || candidate.revision !== job.context_version || conversation.epoch !== job.epoch
        || conversation.state !== 'automatic' || job.deadline < this.now()) {
        return { success: false, error: { code: 'STALE_RESULT' } };
      }
      const { scope_matches: _matches, ...data } = row;
      const parsed = CompletionSnapshotDataSchema.safeParse(data);
      return parsed.success ? { success: true, data: parsed.data }
        : { success: false, error: { code: 'INCONSISTENT_SNAPSHOT' } };
    } catch {
      return { success: false, error: { code: 'READ_FAILED' } };
    }
  }
}
