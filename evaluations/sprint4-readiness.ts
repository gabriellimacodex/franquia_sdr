import { z } from 'zod';
import type { Queryable } from '../src/database.js';
import { SnapshotSchema } from '../src/engine.js';
import { snapshotHash } from '../src/versioning.js';
import { ReadinessCallerSchema, ReadinessInputSchema, ReadinessObservationSchema, type ReadinessCaller, type ReadinessResult, type Sprint4ReadinessSpec } from './sprint4-readiness.spec.js';

const gateId = 'sprint3-continuous-20260910', policyLimitMicroUsd = 1_000_000;
const Count = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const Access = z.object({ scoped: z.boolean(), read_only: z.boolean(), admin_active: z.boolean() });
const Version = z.object({ id: z.string(), content_hash: z.string(), model: z.string(), snapshot: SnapshotSchema });
const Ledger = z.array(z.object({
  costMicroUsd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reservedMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), settled: z.boolean(),
}).refine(entry => entry.costMicroUsd <= entry.reservedMicroUsd && (entry.settled || entry.costMicroUsd === entry.reservedMicroUsd)));
const Row = z.object({
  scoped: z.boolean(), read_only: z.boolean(), admin_active: z.boolean(), observed_at: z.string(),
  version: z.unknown(),
  session: z.object({ id: z.string(), state: z.enum(['automatic', 'human', 'stopped']), versionId: z.string(), kind: z.string() }).nullable(),
  ledger: z.unknown(),
  daily: Count, active_scope: Count, active_actor: Count, active_session: Count.nullable(),
});

/** The caller owns an already scoped READ ONLY transaction. No lock is acquired here.
 * This is one statement's observation, not a reservation or a durable authority grant. */
const readSql = `WITH access AS (
 SELECT COALESCE(current_setting('sdr.tenant_id',true)=$1 AND current_setting('sdr.brand_id',true)=$2,false) AS scoped,
   current_setting('transaction_read_only')='on' AS read_only,
   EXISTS(SELECT 1 FROM sdr.memberships WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3 AND role='admin' AND active) AS admin_active
), permitted AS (SELECT * FROM access WHERE scoped AND read_only AND admin_active)
SELECT a.*,to_jsonb(statement_timestamp()) AS observed_at,
 (SELECT jsonb_build_object('id',id,'content_hash',content_hash,'model',model,'snapshot',snapshot)
  FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$4 AND EXISTS(SELECT 1 FROM permitted)) AS version,
 (SELECT jsonb_build_object('id',l.id,'state',c.state,'versionId',l.version_id,'kind',ch.kind)
  FROM sdr.lab_sessions l JOIN sdr.conversations c USING(tenant_id,brand_id,id)
  JOIN sdr.channels ch ON ch.tenant_id=c.tenant_id AND ch.brand_id=c.brand_id AND ch.phone_number_id=c.phone_number_id
  WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.owner_user_id=$3 AND l.id=$5 AND EXISTS(SELECT 1 FROM permitted)) AS session,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('costMicroUsd',detail->'costMicroUsd','reservedMicroUsd',detail->'reservedMicroUsd','settled',detail->'settled')),'[]'::jsonb)
  FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND type='lab_model_budget_reserved' AND detail->>'gateId'=$6 AND EXISTS(SELECT 1 FROM permitted)) AS ledger,
 (SELECT count(*)::text FROM sdr.messages m JOIN sdr.lab_sessions l ON (l.tenant_id,l.brand_id,l.id)=(m.tenant_id,m.brand_id,m.conversation_id)
  WHERE m.tenant_id=$1 AND m.brand_id=$2 AND l.owner_user_id=$3 AND m.actor='candidate' AND m.created_at>statement_timestamp()-interval '24 hours' AND EXISTS(SELECT 1 FROM permitted)) AS daily,
 (SELECT count(*)::text FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND state IN('pending','working','running','ready') AND EXISTS(SELECT 1 FROM permitted)) AS active_scope,
 (SELECT count(*)::text FROM sdr.jobs j JOIN sdr.lab_sessions l ON (l.tenant_id,l.brand_id,l.id)=(j.tenant_id,j.brand_id,j.conversation_id)
  WHERE j.tenant_id=$1 AND j.brand_id=$2 AND l.owner_user_id=$3 AND j.state IN('pending','working','running','ready') AND EXISTS(SELECT 1 FROM permitted)) AS active_actor,
 CASE WHEN $5::text IS NULL THEN NULL ELSE (SELECT count(*)::text FROM sdr.jobs j JOIN sdr.lab_sessions l ON (l.tenant_id,l.brand_id,l.id)=(j.tenant_id,j.brand_id,j.conversation_id)
  WHERE j.tenant_id=$1 AND j.brand_id=$2 AND l.owner_user_id=$3 AND l.id=$5 AND j.state IN('pending','working','running','ready') AND EXISTS(SELECT 1 FROM permitted)) END AS active_session
FROM access a`;

export class Sprint4Readiness implements Sprint4ReadinessSpec {
  private readonly caller: ReadinessCaller;
  constructor(private readonly tx: Queryable, caller: ReadinessCaller) { this.caller = { ...caller }; }
  async execute(raw: unknown): Promise<ReadinessResult> {
    const input = ReadinessInputSchema.safeParse(raw), caller = ReadinessCallerSchema.safeParse(this.caller);
    if (!input.success) return { success: false, error: { code: 'INVALID_INPUT' } };
    if (!caller.success || input.data.tenantId !== caller.data.tenantId || input.data.brandId !== caller.data.brandId || input.data.actorUserId !== caller.data.actorUserId) {
      return { success: false, error: { code: 'CALLER_MISMATCH' } };
    }
    try {
      const binding = input.data;
      const rawRow = (await this.tx.query(readSql, [binding.tenantId, binding.brandId, binding.actorUserId, binding.versionId, binding.sessionId ?? null, gateId])).rows[0];
      const access = Access.parse(rawRow);
      if (!access.scoped || !access.read_only) return { success: false, error: { code: 'UNSAFE_READ_CONTEXT' } };
      if (!access.admin_active) return { success: false, error: { code: 'ACTOR_NOT_ADMIN' } };
      const row = Row.parse(rawRow);
      const parsedVersion = Version.safeParse(row.version);
      if (!parsedVersion.success) return { success: false, error: { code: 'VERSION_MISMATCH' } };
      const version = parsedVersion.data, snapshot = version.snapshot;
      if (snapshot.tenant.tenantId !== binding.tenantId || snapshot.tenant.brandId !== binding.brandId || snapshot.model !== binding.model || version.id !== binding.versionId || version.model !== binding.model || version.content_hash !== binding.contentHash || snapshotHash(snapshot) !== binding.contentHash) {
        return { success: false, error: { code: 'VERSION_MISMATCH' } };
      }
      if (binding.sessionId && !row.session) return { success: false, error: { code: 'SESSION_NOT_FOUND' } };
      if (row.session && (row.session.id !== binding.sessionId || row.session.kind !== 'laboratory' || row.session.versionId !== binding.versionId)) return { success: false, error: { code: 'SESSION_MISMATCH' } };
      const parsedLedger = Ledger.safeParse(row.ledger);
      if (!parsedLedger.success) return { success: false, error: { code: 'INVALID_LEDGER' } };
      const ledger = parsedLedger.data, accountedMicroUsd = ledger.reduce((sum, entry) => sum + entry.costMicroUsd, 0);
      if (!Number.isSafeInteger(accountedMicroUsd)) return { success: false, error: { code: 'INVALID_LEDGER' } };
      const data = ReadinessObservationSchema.parse({
        kind: 'readiness-observation', observedAt: row.observed_at, binding,
        membership: { role: 'admin', active: true },
        version: { id: version.id, contentHash: version.content_hash, model: snapshot.model, outputContract: snapshot.outputContract ?? 'legacy-v1' },
        session: row.session && { id: row.session.id, state: row.session.state, versionId: row.session.versionId },
        ledger: { gateId, policyLimitMicroUsd, runtimeLimitVerified: false, accountedMicroUsd, remainingPolicyMicroUsd: Math.max(0, policyLimitMicroUsd - accountedMicroUsd), reservationCount: ledger.length, unsettledReservations: ledger.filter(entry => !entry.settled).length },
        daily: { actorUserId: binding.actorUserId, limitMessages: 100, rollingWindowHours: 24, usedMessages: row.daily, remainingMessages: Math.max(0, 100 - row.daily) },
        activeJobs: { scope: row.active_scope, actor: row.active_actor, session: row.active_session },
        exactPayloadBound: null, nextJobDeadline: null,
        pending: ['EXACT_PAYLOAD_UNAVAILABLE', 'JOB_DEADLINE_UNAVAILABLE', 'RUNTIME_AND_N8N_NOT_VERIFIED', 'PUBLICATION_AND_HUMAN_GATES_NOT_VERIFIED', 'CAPACITY_RECHECK_REQUIRED', 'REMAINING_CAMPAIGN_REVIEW_REQUIRED'],
      });
      if (data.ledger.unsettledReservations > 0) data.pending.push('UNSETTLED_RESERVATIONS_PRESENT');
      if (data.activeJobs.scope > 0) data.pending.push('ACTIVE_JOBS_PRESENT');
      if (!data.session) data.pending.push('SESSION_NOT_PREPARED');
      else if (data.session.state !== 'automatic') data.pending.push('SESSION_NOT_AUTOMATIC');
      if (data.ledger.remainingPolicyMicroUsd === 0) data.pending.push('POLICY_BUDGET_EXHAUSTED');
      if (data.daily.remainingMessages === 0) data.pending.push('ACTOR_DAILY_LIMIT_REACHED');
      return { success: true, data };
    } catch {
      return { success: false, error: { code: 'READ_FAILED' } };
    }
  }
}
