import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Queryable } from '../src/database.js';
import { SnapshotSchema } from '../src/engine.js';
import { snapshotHash } from '../src/versioning.js';
import { BootstrapIntentSchema, BootstrapReconciliationResultSchema, type BootstrapReconciler, type BootstrapReconciliationResult } from './sprint4-bootstrap.spec.js';

const scope = { tenantId: 'cognita-homologacao', brandId: 'sapore' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const Timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const Id = z.string().min(1);
const Evaluation = z.object({ id: Id, conversation_id: Id, created_at: Timestamp, detail: z.object({
 ownerUserId: Id, requestId: z.string().uuid(), versionId: Id, contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict() }).strict();
const Row = z.object({ observed_at: Timestamp, scope_ok: z.boolean(), read_only: z.boolean(), session_not_future: z.boolean(),
 session: z.object({ tenant_id: Id, brand_id: Id, id: Id, owner_user_id: Id, request_id: z.string().uuid(), candidate_id: Id,
  label: Id, scenario: Id, version_id: Id, created_at: Timestamp }).nullable(),
 conversation: z.object({ id: Id, candidate_id: Id, state: z.enum(['automatic', 'human', 'stopped']) }).nullable(),
 candidate: z.object({ id: Id, authorized_contact_id: Id }).nullable(), channel_kind: z.string().nullable(),
 version: z.object({ id: Id, content_hash: Id, model: Id, snapshot: z.unknown() }).nullable(),
 evaluations: z.array(z.unknown()),
}).strict();

const readSql = `WITH selected AS MATERIALIZED (
 SELECT * FROM sdr.lab_sessions
 WHERE tenant_id=$1 AND brand_id=$2 AND owner_user_id=$3 AND request_id=$4::uuid
)
SELECT to_jsonb(statement_timestamp()) AS observed_at,
 coalesce(current_setting('sdr.tenant_id',true)=$1 AND current_setting('sdr.brand_id',true)=$2,false) AS scope_ok,
 current_setting('transaction_read_only')='on' AS read_only,
 coalesce(l.created_at<=statement_timestamp(),true) AS session_not_future,
 to_jsonb(l) AS session,
 CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('id',c.id,'candidate_id',c.candidate_id,'state',c.state) END AS conversation,
 CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id',p.id,'authorized_contact_id',p.authorized_contact_id) END AS candidate,
 ch.kind AS channel_kind,
 CASE WHEN v.id IS NOT NULL THEN jsonb_build_object('id',v.id,'content_hash',v.content_hash,'model',v.model,'snapshot',v.snapshot) END AS version,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'conversation_id',e.conversation_id,'created_at',e.created_at,'detail',e.detail)),'[]'::jsonb)
  FROM sdr.events e WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.type='lab_evaluation_session_created'
   AND (e.conversation_id=l.id OR e.id='lab-evaluation:'||l.id
    OR (e.detail->>'ownerUserId'=$3 AND lower(e.detail->>'requestId')=$4::uuid::text))) AS evaluations
FROM (VALUES(1)) AS anchor(n)
LEFT JOIN selected l ON true
LEFT JOIN sdr.conversations c ON (c.tenant_id,c.brand_id,c.id)=(l.tenant_id,l.brand_id,l.id)
LEFT JOIN sdr.candidates p ON (p.tenant_id,p.brand_id,p.id)=(l.tenant_id,l.brand_id,l.candidate_id)
LEFT JOIN sdr.channels ch ON ch.phone_number_id=c.phone_number_id AND ch.tenant_id=l.tenant_id AND ch.brand_id=l.brand_id
LEFT JOIN sdr.versions v ON (v.tenant_id,v.brand_id,v.id)=(l.tenant_id,l.brand_id,l.version_id)`;

const failure = (code: 'INVALID_INPUT' | 'READ_FAILED' | 'EVIDENCE_MISMATCH'): BootstrapReconciliationResult => ({ success: false, error: { code } });

/** Caller supplies an already scoped READ ONLY transaction. No environment, credentials, locks or writes.
 * A not-found snapshot never proves a pending POST cannot commit and never licenses a retry.
 * evidenceRef identifies a validated in-memory read by digest; it is not a persisted artifact or signature.
 * Client intent and database clocks must be coherent. No skew adjustment is invented; an earlier creation fails closed.
 * Session state is observed now, not readiness or historical publication approval. */
export class Sprint4BootstrapReconciler implements BootstrapReconciler {
 constructor(private readonly tx: Queryable) {}
 async inspect(raw: unknown): Promise<BootstrapReconciliationResult> {
  let intent;
  try { const parsed = BootstrapIntentSchema.safeParse(raw); if (!parsed.success) return failure('INVALID_INPUT'); intent = parsed.data; }
  catch { return failure('INVALID_INPUT'); }
  try {
   const rows = (await this.tx.query(readSql, [scope.tenantId, scope.brandId, intent.actorUserId, intent.requestId])).rows;
   if (rows.length !== 1) return failure('READ_FAILED');
   const row = Row.parse(rows[0]);
   if (!row.scope_ok || !row.read_only) return failure('READ_FAILED');
   const observedAtMs = Date.parse(row.observed_at), intentHash = hash(intent);
   if (!Number.isSafeInteger(observedAtMs) || observedAtMs < intent.createdAtMs) return failure('EVIDENCE_MISMATCH');
   if (!row.session) {
    if (row.evaluations.length) return failure('EVIDENCE_MISMATCH');
    return { success: true, data: { kind: 'not-found', intentHash, observedAtMs } };
   }
   if (!row.conversation || !row.candidate || !row.version) return failure('EVIDENCE_MISMATCH');
   const createdAtMs = Date.parse(row.session.created_at);
   if (!Number.isSafeInteger(createdAtMs) || createdAtMs < intent.createdAtMs || !row.session_not_future) return failure('EVIDENCE_MISMATCH');
   if (row.conversation.id !== row.session.id || row.conversation.candidate_id !== row.session.candidate_id
    || row.candidate.id !== row.session.candidate_id || row.candidate.authorized_contact_id !== intent.actorUserId
    || row.channel_kind !== 'laboratory') return failure('EVIDENCE_MISMATCH');
   if (row.session.tenant_id !== scope.tenantId || row.session.brand_id !== scope.brandId || row.session.owner_user_id !== intent.actorUserId
    || row.session.request_id.toLowerCase() !== intent.requestId.toLowerCase() || row.session.label !== intent.label || row.session.scenario !== intent.scenario
    || row.session.version_id !== intent.target.versionId || row.version.id !== intent.target.versionId
    || row.version.content_hash !== intent.target.contentHash || row.version.model !== intent.target.model) return failure('EVIDENCE_MISMATCH');
   const snapshot = SnapshotSchema.safeParse(row.version.snapshot);
   if (!snapshot.success || snapshot.data.tenant.tenantId !== scope.tenantId || snapshot.data.tenant.brandId !== scope.brandId
    || snapshot.data.model !== intent.target.model || snapshotHash(snapshot.data) !== intent.target.contentHash) return failure('EVIDENCE_MISMATCH');
   if (intent.mode === 'evaluation') {
    const event = Evaluation.safeParse(row.evaluations[0]);
    if (row.evaluations.length !== 1 || !event.success || event.data.id !== 'lab-evaluation:' + row.session.id
     || event.data.created_at !== row.session.created_at
     || event.data.conversation_id !== row.session.id || event.data.detail.ownerUserId !== intent.actorUserId
     || event.data.detail.requestId.toLowerCase() !== intent.requestId.toLowerCase()
     || event.data.detail.versionId !== intent.target.versionId || event.data.detail.contentHash !== intent.target.contentHash) return failure('EVIDENCE_MISMATCH');
   } else if (row.evaluations.length) return failure('EVIDENCE_MISMATCH');
   const session = { id: row.session.id, candidateId: row.session.candidate_id, label: row.session.label,
    scenario: row.session.scenario, versionId: row.session.version_id, state: row.conversation.state };
   const evidenceRef = 'db-bootstrap:' + hash({ intentHash, observedAtMs, session: row.session, conversation: row.conversation,
    candidate: row.candidate, channelKind: row.channel_kind, version: { id: row.version.id, contentHash: row.version.content_hash, model: row.version.model }, evaluations: row.evaluations });
   return BootstrapReconciliationResultSchema.parse({ success: true, data: { kind: 'session-observed', observation: {
    kind: 'sprint4-session-observation-v1', intentHash, source: 'database-readonly', evidenceRef, observedAtMs, session,
   } } });
  } catch { return failure('READ_FAILED'); }
 }
}
