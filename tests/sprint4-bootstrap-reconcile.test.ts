import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { seedPilot, initialSnapshot } from '../src/seed.js';
import { Versioning, snapshotHash, type Snapshot } from '../src/versioning.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { BootstrapIntentSchema, BootstrapReconciliationResultSchema, type BootstrapIntent } from '../evaluations/sprint4-bootstrap.spec.js';
import { Sprint4BootstrapReconciler } from '../evaluations/sprint4-bootstrap-reconcile.js';

const scope = { tenantId: 'cognita-homologacao', brandId: 'sapore' };
const actor = { ...scope, userId: 'synthetic-reconcile-admin', role: 'admin' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(t: TestContext) {
 const pg = new PGlite({ extensions: { vector } });
 const db: Database = { query: (sql, params) => pg.query(sql, params), transaction: fn => pg.transaction(tx => fn(tx as Queryable)), close: () => pg.close() };
 t.after(() => db.close());
 for (const migration of ['001_sdr.sql', '002_versions.sql', '003_lab_sessions.sql']) await pg.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
 await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic reconciliation' }], adminUserIds: [actor.userId] });
 const draft = await new Versioning(db).saveDraft(scope, createFinancialDraftSnapshot(initialSnapshot(scope)), actor.userId);
 assert.ok(draft.ok);
 const planned = new Sprint4CampaignPlanner().execute({ runId: 'reconcile-fixture', actorUserId: actor.userId,
  target: { versionId: draft.value.versionId, contentHash: draft.value.contentHash, model: 'gpt-5.4-2026-03-05' } });
 assert.ok(planned.success);
 const intent = BootstrapIntentSchema.parse({ kind: 'sprint4-session-intent-v1', runId: planned.data.request.runId,
  executionId: planned.data.phases[0].executions[0].id, planHash: hash(planned.data), actorUserId: actor.userId,
  target: planned.data.request.target, requestId: randomUUID(), mode: 'evaluation', label: 'Synthetic lost creation ACK', scenario: 'free', createdAtMs: Date.now() });
 const created = await new LabSessions(db).createEvaluation(actor, { requestId: intent.requestId, label: intent.label,
  scenario: intent.scenario, versionId: intent.target.versionId, contentHash: intent.target.contentHash });
 assert.ok(created.ok);
 return { db, intent, session: created.value };
}

async function inspect(db: Database, intent: BootstrapIntent) {
 const calls: { sql: string; params?: unknown[] }[] = [];
 const result = await db.transaction(async tx => {
  await tx.query('SET TRANSACTION READ ONLY');
  await tx.query("SELECT set_config('sdr.tenant_id',$1,true),set_config('sdr.brand_id',$2,true)", [scope.tenantId, scope.brandId]);
  const read: Queryable = { query: async <T>(sql: string, params?: unknown[]) => { calls.push({ sql, params }); return tx.query<T>(sql, params); } };
  return new Sprint4BootstrapReconciler(read).inspect(intent);
 });
 return { result, calls };
}

test('reconciles an evaluation creation by its original identity using one scoped read-only SELECT and no dispatch', async t => {
 const f = await fixture(t), { result, calls } = await inspect(f.db, f.intent);
 assert.ok(result.success, JSON.stringify(result)); assert.equal(result.data.kind, 'session-observed');
 if (result.data.kind !== 'session-observed') return;
 assert.equal(BootstrapReconciliationResultSchema.safeParse(result).success, true);
 assert.deepEqual(result.data.observation.session, f.session);
 assert.equal(result.data.observation.intentHash, hash(BootstrapIntentSchema.parse(f.intent)));
 assert.equal(result.data.observation.source, 'database-readonly');
 assert.ok(Number.isSafeInteger(result.data.observation.observedAtMs));
 assert.ok(result.data.observation.observedAtMs >= f.intent.createdAtMs);
 assert.match(result.data.observation.evidenceRef, /^db-bootstrap:[a-f0-9]{64}$/);
 for (const field of ['snapshot', 'prompt', 'readyToExecute', 'ledger', 'receipt']) assert.equal(field in result.data.observation, false);
 assert.equal(calls.length, 1); assert.match(calls[0].sql.trim(), /^WITH /);
 assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE|FOR UPDATE|pg_advisory)\b/i);
 assert.deepEqual(calls[0].params, [scope.tenantId, scope.brandId, actor.userId, f.intent.requestId]);
 assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length, 0);
 assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length, 0);
 assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
});

test('an existing request with mismatched pins, label or scenario is a conflict, never a false absence', async t => {
 const f = await fixture(t);
 for (const changed of [
  { ...f.intent, target: { ...f.intent.target, versionId: 'other-version' } },
  { ...f.intent, target: { ...f.intent.target, contentHash: 'b'.repeat(64) } },
  { ...f.intent, label: 'different label' }, { ...f.intent, scenario: 'human' as const },
 ]) {
  const { result, calls } = await inspect(f.db, changed);
  assert.deepEqual(result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } });
  assert.equal(calls.length, 1);
 }
 assert.equal((await f.db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 1);
});

test('an unobserved exact owner/request returns only a bound not-found observation, never another owner session or retry permission', async t => {
 const f = await fixture(t);
 for (const intent of [{ ...f.intent, actorUserId: 'another-owner' }, { ...f.intent, requestId: randomUUID() }]) {
  const { result, calls } = await inspect(f.db, intent);
  assert.ok(result.success, JSON.stringify(result)); assert.equal(result.data.kind, 'not-found');
  if (result.data.kind !== 'not-found') continue;
  assert.equal(result.data.intentHash, hash(BootstrapIntentSchema.parse(intent)));
  assert.ok(result.data.observedAtMs >= intent.createdAtMs);
  assert.deepEqual(Object.keys(result.data).sort(), ['intentHash', 'kind', 'observedAtMs']);
  assert.equal(JSON.stringify(result).includes(f.session.id), false); assert.equal(calls.length, 1);
 }
});

test('evaluation reconciliation requires one intact historical creation marker with every binding preserved', async t => {
 const f = await fixture(t);
 const event = (await f.db.query<{ id: string; detail: Record<string, unknown> }>("SELECT id,detail FROM sdr.events WHERE type='lab_evaluation_session_created'")).rows[0];
 const mutations = [
  { id: event.id, type: 'not-an-evaluation', detail: event.detail },
  { id: 'wrong-evaluation-id', type: 'lab_evaluation_session_created', detail: event.detail },
  ...[{ ownerUserId: 'another-owner' }, { requestId: randomUUID() }, { versionId: 'another-version' }, { contentHash: 'b'.repeat(64) }]
   .map(change => ({ id: event.id, type: 'lab_evaluation_session_created', detail: { ...event.detail, ...change } })),
 ];
 for (const changed of mutations) {
  await f.db.query('UPDATE sdr.events SET id=$2,type=$3,detail=$4 WHERE id=$1', [event.id, changed.id, changed.type, JSON.stringify(changed.detail)]);
  try { assert.deepEqual((await inspect(f.db, f.intent)).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } }); }
  finally { await f.db.query('UPDATE sdr.events SET id=$2,type=$3,detail=$4 WHERE id=$1', [changed.id, event.id, 'lab_evaluation_session_created', JSON.stringify(event.detail)]); }
 }
 await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($1,$2,$3,$4,'lab_evaluation_session_created',$5)",
  ['duplicate-evaluation', scope.tenantId, scope.brandId, f.session.id, JSON.stringify(event.detail)]);
 assert.deepEqual((await inspect(f.db, f.intent)).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } });
});

test('matching metadata cannot substitute for the actual immutable snapshot hash, scope and model', async t => {
 const f = await fixture(t);
 const original = (await f.db.query<{ snapshot: Snapshot }>('SELECT snapshot FROM sdr.versions WHERE id=$1', [f.intent.target.versionId])).rows[0].snapshot;
 const snapshots = [{ ...original, prompt: original.prompt + '\nAltered snapshot.' },
  { ...original, tenant: { ...original.tenant, tenantId: 'foreign-tenant-for-negative-test' } },
  { ...original, model: 'wrong-snapshot-model' }];
 for (const [index, snapshot] of snapshots.entries()) {
  // Intentionally invalid stored model: compute its canonical digest without asserting schema validity.
  const target = { ...f.intent.target, versionId: 'negative-snapshot-' + index, contentHash: index === 0 ? 'b'.repeat(64) : snapshotHash(snapshot as Snapshot) };
  await f.db.query('INSERT INTO sdr.versions(tenant_id,brand_id,id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$4,$5,$6,$7)',
   [scope.tenantId, scope.brandId, target.versionId, 'Synthetic corrupt metadata', JSON.stringify(snapshot), target.contentHash, target.model]);
  await f.db.query('UPDATE sdr.lab_sessions SET version_id=$2 WHERE id=$1', [f.session.id, target.versionId]);
  await f.db.query("UPDATE sdr.events SET detail=detail||$2::jsonb WHERE id=$1", ['lab-evaluation:' + f.session.id, JSON.stringify({ versionId: target.versionId, contentHash: target.contentHash })]);
  assert.deepEqual((await inspect(f.db, { ...f.intent, target })).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } });
 }
});

test('a found session must retain its laboratory channel and candidate/conversation/owner links', async t => {
 const f = await fixture(t);
 const other = await new LabSessions(f.db).create(actor, { requestId: randomUUID(), label: 'Other synthetic candidate', scenario: 'free' });
 assert.ok(other.ok);
 const channel = (await f.db.query<{ phone_number_id: string }>('SELECT phone_number_id FROM sdr.conversations WHERE id=$1', [f.session.id])).rows[0].phone_number_id;
 const whatsapp = (await f.db.query<{ phone_number_id: string }>("SELECT phone_number_id FROM sdr.channels WHERE kind='whatsapp' LIMIT 1")).rows[0].phone_number_id;
 const mutations = [
  { sql: 'UPDATE sdr.conversations SET candidate_id=$2 WHERE id=$1', id: f.session.id, bad: other.value.candidateId, good: f.session.candidateId },
  { sql: 'UPDATE sdr.lab_sessions SET candidate_id=$2 WHERE id=$1', id: f.session.id, bad: other.value.candidateId, good: f.session.candidateId },
  { sql: 'UPDATE sdr.lab_sessions SET candidate_id=$2 WHERE id=$1', id: f.session.id, bad: randomUUID(), good: f.session.candidateId },
  { sql: 'UPDATE sdr.candidates SET authorized_contact_id=$2 WHERE id=$1', id: f.session.candidateId, bad: 'wrong-owner', good: actor.userId },
  { sql: 'UPDATE sdr.conversations SET phone_number_id=$2 WHERE id=$1', id: f.session.id, bad: whatsapp, good: channel },
 ];
 for (const mutation of mutations) {
  await f.db.query(mutation.sql, [mutation.id, mutation.bad]);
  try { assert.deepEqual((await inspect(f.db, f.intent)).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } }); }
  finally { await f.db.query(mutation.sql, [mutation.id, mutation.good]); }
 }
});

test('creation evidence must follow the intent, precede observation and share the exact evaluation transaction timestamp', async t => {
 const f = await fixture(t);
 const original = (await f.db.query<{ session_at: string; event_at: string }>(`SELECT to_jsonb(l.created_at) AS session_at,to_jsonb(e.created_at) AS event_at
  FROM sdr.lab_sessions l JOIN sdr.events e ON e.id='lab-evaluation:'||l.id WHERE l.id=$1`, [f.session.id])).rows[0];
 const future = new Date(Date.now() + 86_400_000).toISOString(), earlier = new Date(f.intent.createdAtMs - 86_400_000).toISOString();
 for (const [sessionAt, eventAt] of [[future, future], [original.session_at, future], [earlier, earlier],
  [original.session_at, new Date(Date.parse(original.session_at) + 1).toISOString()]]) {
  await f.db.query('UPDATE sdr.lab_sessions SET created_at=$2 WHERE id=$1', [f.session.id, sessionAt]);
  await f.db.query('UPDATE sdr.events SET created_at=$2 WHERE id=$1', ['lab-evaluation:' + f.session.id, eventAt]);
  try { assert.deepEqual((await inspect(f.db, f.intent)).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } }); }
  finally {
   await f.db.query('UPDATE sdr.lab_sessions SET created_at=$2 WHERE id=$1', [f.session.id, original.session_at]);
   await f.db.query('UPDATE sdr.events SET created_at=$2 WHERE id=$1', ['lab-evaluation:' + f.session.id, original.event_at]);
  }
 }
});

test('normal-route existence keeps its old pin after active changes and pause, without manufacturing publication approval', async t => {
 const f = await fixture(t);
 const target = (await f.db.query<{ versionId: string; contentHash: string; model: string }>(`SELECT v.id AS "versionId",v.content_hash AS "contentHash",v.model
  FROM sdr.active_versions a JOIN sdr.versions v ON (v.tenant_id,v.brand_id,v.id)=(a.tenant_id,a.brand_id,a.version_id)
  WHERE a.tenant_id=$1 AND a.brand_id=$2`, [scope.tenantId, scope.brandId])).rows[0];
 const intent = BootstrapIntentSchema.parse({ ...f.intent, requestId: randomUUID(), mode: 'published', label: 'Synthetic normal route', target, createdAtMs: Date.now() });
 const created = await new LabSessions(f.db).create(actor, { requestId: intent.requestId, label: intent.label, scenario: intent.scenario });
 assert.ok(created.ok);
 await f.db.query('UPDATE sdr.active_versions SET version_id=$3 WHERE tenant_id=$1 AND brand_id=$2', [scope.tenantId, scope.brandId, f.intent.target.versionId]);
 await f.db.query('UPDATE sdr.memberships SET active=false WHERE user_id=$1', [actor.userId]);
 for (const state of ['human', 'stopped']) {
  await f.db.query('UPDATE sdr.conversations SET state=$2 WHERE id=$1', [created.value.id, state]);
  const { result } = await inspect(f.db, intent);
  assert.ok(result.success); assert.equal(result.data.kind, 'session-observed');
  if (result.data.kind !== 'session-observed') continue;
  assert.deepEqual(result.data.observation.session, { ...created.value, state });
  assert.equal('publicationApproved' in result.data.observation, false);
 }
 assert.equal((await f.db.query('SELECT id FROM sdr.publication_events')).rows.length, 0);
 for (const changed of [{ ...intent, mode: 'evaluation' as const }, { ...f.intent, mode: 'published' as const }]) {
  assert.deepEqual((await inspect(f.db, changed)).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } });
 }
});

test('malformed input, unsafe read contexts and dependency failures fail closed without leaking error details', async t => {
 const f = await fixture(t);
 let calls = 0;
 const failing: Queryable = { query: async () => { calls++; throw new Error('synthetic-private-connection-detail'); } };
 const reconciler = new Sprint4BootstrapReconciler(failing);
 for (const raw of [null, { ...f.intent, requestId: 'not-uuid' }, { get kind() { throw new Error('private-accessor'); } }]) {
  assert.deepEqual(await reconciler.inspect(raw), { success: false, error: { code: 'INVALID_INPUT' } });
 }
 assert.equal(calls, 0);
 assert.deepEqual(await reconciler.inspect(f.intent), { success: false, error: { code: 'READ_FAILED' } }); assert.equal(calls, 1);
 assert.deepEqual(await new Sprint4BootstrapReconciler(f.db).inspect(f.intent), { success: false, error: { code: 'READ_FAILED' } });
 for (const context of [{ readOnly: false, tenantId: scope.tenantId }, { readOnly: true, tenantId: 'foreign-tenant-negative-test' }]) {
  const result = await f.db.transaction(async tx => {
   if (context.readOnly) await tx.query('SET TRANSACTION READ ONLY');
   await tx.query("SELECT set_config('sdr.tenant_id',$1,true),set_config('sdr.brand_id',$2,true)", [context.tenantId, scope.brandId]);
   return new Sprint4BootstrapReconciler(tx).inspect(f.intent);
  });
  assert.deepEqual(result, { success: false, error: { code: 'READ_FAILED' } });
 }
});

test('a creation marker moved to another session or detached from an exact request cannot be hidden by joins', async t => {
 const f = await fixture(t);
 const other = await new LabSessions(f.db).create(actor, { requestId: randomUUID(), label: 'Synthetic marker target', scenario: 'free' });
 assert.ok(other.ok);
 await f.db.query('UPDATE sdr.events SET conversation_id=$2 WHERE id=$1', ['lab-evaluation:' + f.session.id, other.value.id]);
 assert.deepEqual((await inspect(f.db, f.intent)).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } });
 await f.db.query('UPDATE sdr.events SET conversation_id=$2 WHERE id=$1', ['lab-evaluation:' + f.session.id, f.session.id]);
 const missing = { ...f.intent, requestId: randomUUID() };
 await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($1,$2,$3,$4,'lab_evaluation_session_created',$5)",
  ['synthetic-orphan-marker', scope.tenantId, scope.brandId, other.value.id, JSON.stringify({ ownerUserId: actor.userId, requestId: missing.requestId, versionId: missing.target.versionId, contentHash: missing.target.contentHash })]);
 assert.deepEqual((await inspect(f.db, missing)).result, { success: false, error: { code: 'EVIDENCE_MISMATCH' } });
});
