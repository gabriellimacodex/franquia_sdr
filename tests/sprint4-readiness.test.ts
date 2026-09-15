import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Sprint4Readiness } from '../evaluations/sprint4-readiness.js';
import { ReadinessResultSchema } from '../evaluations/sprint4-readiness.spec.js';
import { testDatabase } from './db-helper.js';
import { initialSnapshot, seedPilot } from '../src/seed.js';
import { snapshotHash } from '../src/versioning.js';
import { LabSessions } from '../src/lab-sessions.js';

const caller = { tenantId: 'cognita-homologacao' as const, brandId: 'sapore' as const, actorUserId: 'fictional-admin' };
const request = { ...caller, versionId: 'fictional-version', contentHash: 'a'.repeat(64), model: 'gpt-5.4-2026-03-05' };

async function fixture() {
  const db = await testDatabase();
  const { versionId } = await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic only' }], adminUserIds: [caller.actorUserId] });
  const sessions = new LabSessions(db), actor = { ...caller, userId: caller.actorUserId, role: 'admin' };
  const created = await sessions.create(actor, { requestId: randomUUID(), label: 'Synthetic readiness', scenario: 'free' });
  assert.ok(created.ok);
  const input = { ...request, versionId, contentHash: snapshotHash(initialSnapshot({ tenantId: caller.tenantId, brandId: caller.brandId })), sessionId: created.value.id };
  const queries: string[] = [];
  const observe = (raw: unknown = input, readOnly = true, tenantId = caller.tenantId as string, brandId = caller.brandId as string) => db.transaction(async tx => {
    if (readOnly) await tx.query('SET TRANSACTION READ ONLY');
    await tx.query("SELECT set_config('sdr.tenant_id',$1,true),set_config('sdr.brand_id',$2,true)", [tenantId, brandId]);
    return new Sprint4Readiness({ query: (sql, params) => { queries.push(sql); return tx.query(sql, params); } }, caller).execute(raw);
  });
  const unchanged = async () => (await db.query(`SELECT jsonb_build_object(
    'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sdr.lab_sessions t),
    'candidates',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sdr.candidates t),
    'conversations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sdr.conversations t),
    'jobs',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sdr.jobs t),
    'messages',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sdr.messages t),
    'events',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sdr.events t),
    'memberships',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM sdr.memberships t),
    'versions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sdr.versions t)) AS data`)).rows[0];
  return { db, input, queries, observe, unchanged, sessions, actor, session: created.value };
}

test('invalid scope, model or caller-controlled authority cannot reach SQL', async () => {
  let queries = 0;
  const readiness = new Sprint4Readiness({ query: async () => { queries++; throw new Error('No SQL expected'); } }, caller);
  for (const input of [null, { ...request, tenantId: 'other-tenant' }, { ...request, brandId: 'other-brand' },
    { ...request, model: 'other-model' }, { ...request, adminActive: true }]) {
    assert.deepEqual(await readiness.execute(input), { success: false, error: { code: 'INVALID_INPUT' } });
  }
  assert.equal(queries, 0);
});

test('request actor must match the fixed authenticated caller before any SQL', async () => {
  let queries = 0;
  const readiness = new Sprint4Readiness({ query: async () => { queries++; throw new Error('No SQL expected'); } }, caller);
  assert.deepEqual(await readiness.execute({ ...request, actorUserId: 'other-admin' }), { success: false, error: { code: 'CALLER_MISMATCH' } });
  assert.equal(queries, 0);
});

test('the authenticated caller binding is fixed even if the caller later mutates its original object', async () => {
  let queries = 0;
  const identity = { ...caller };
  const readiness = new Sprint4Readiness({ query: async () => { queries++; throw new Error('No SQL expected'); } }, identity);
  identity.actorUserId = 'other-admin';
  assert.deepEqual(await readiness.execute({ ...request, actorUserId: identity.actorUserId }), { success: false, error: { code: 'CALLER_MISMATCH' } });
  assert.equal(queries, 0);
});

test('one real read-only scoped query observes facts without preparing, authorizing or mutating', async () => {
  const f = await fixture();
  try {
    const before = await f.unchanged(), result = await f.observe();
    assert.ok(result.success);
    assert.equal(ReadinessResultSchema.safeParse(result).success, true);
    assert.equal(result.data.kind, 'readiness-observation');
    assert.deepEqual(result.data.membership, { role: 'admin', active: true });
    assert.deepEqual(result.data.version, { id: f.input.versionId, contentHash: f.input.contentHash, model: request.model, outputContract: 'legacy-v1' });
    assert.deepEqual(result.data.session, { id: f.session.id, state: 'automatic', versionId: f.input.versionId });
    assert.deepEqual(result.data.ledger, { gateId: 'sprint3-continuous-20260910', policyLimitMicroUsd: 1_000_000, runtimeLimitVerified: false, accountedMicroUsd: 0, remainingPolicyMicroUsd: 1_000_000, reservationCount: 0, unsettledReservations: 0 });
    assert.deepEqual(result.data.daily, { actorUserId: caller.actorUserId, limitMessages: 100, rollingWindowHours: 24, usedMessages: 0, remainingMessages: 100 });
    assert.deepEqual(result.data.activeJobs, { scope: 0, actor: 0, session: 0 });
    assert.equal(result.data.exactPayloadBound, null); assert.equal(result.data.nextJobDeadline, null);
    for (const code of ['EXACT_PAYLOAD_UNAVAILABLE', 'JOB_DEADLINE_UNAVAILABLE', 'RUNTIME_AND_N8N_NOT_VERIFIED', 'PUBLICATION_AND_HUMAN_GATES_NOT_VERIFIED', 'CAPACITY_RECHECK_REQUIRED', 'REMAINING_CAMPAIGN_REVIEW_REQUIRED']) assert.ok(result.data.pending.includes(code as typeof result.data.pending[number]));
    assert.equal(f.queries.length, 1); assert.match(f.queries[0], /^WITH /);
    assert.doesNotMatch(f.queries[0], /\b(?:INSERT|UPDATE|DELETE|SET|pg_advisory)\b/);
    for (const hidden of ['"snapshot"', '"prompt"', '"context"', '"readyToExecute"', '"healthy"', '"Preflight"']) assert.equal(JSON.stringify(result).includes(hidden), false);
    assert.deepEqual(await f.unchanged(), before);
  } finally { await f.db.close(); }
});

test('unsafe transactions or absent, downgraded and revoked real admins return only a denial', async () => {
  const f = await fixture();
  try {
    for (const [readOnly, tenantId, brandId] of [[false, caller.tenantId, caller.brandId], [true, 'foreign-tenant', caller.brandId], [true, caller.tenantId, 'foreign-brand']] as const) {
      assert.deepEqual(await f.observe(f.input, readOnly, tenantId, brandId), { success: false, error: { code: 'UNSAFE_READ_CONTEXT' } });
    }
    for (const membership of [{ role: 'tester', active: true }, { role: 'reviewer', active: true }, { role: 'admin', active: false }]) {
      await f.db.query('UPDATE sdr.memberships SET role=$2,active=$3 WHERE user_id=$1', [caller.actorUserId, membership.role, membership.active]);
      assert.deepEqual(await f.observe(), { success: false, error: { code: 'ACTOR_NOT_ADMIN' } });
    }
    await f.db.query('DELETE FROM sdr.memberships WHERE user_id=$1', [caller.actorUserId]);
    assert.deepEqual(await f.observe(), { success: false, error: { code: 'ACTOR_NOT_ADMIN' } });
  } finally { await f.db.close(); }
});

test('version identity and own laboratory session must match; foreign or missing targets disclose no facts', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.observe({ ...f.input, versionId: 'missing-version' }), { success: false, error: { code: 'VERSION_MISMATCH' } });
    assert.deepEqual(await f.observe({ ...f.input, contentHash: 'b'.repeat(64) }), { success: false, error: { code: 'VERSION_MISMATCH' } });
    const foreign = await f.sessions.create({ ...f.actor, userId: 'other-admin' }, { requestId: randomUUID(), label: 'Private foreign session', scenario: 'free' });
    assert.ok(foreign.ok);
    for (const sessionId of [foreign.value.id, 'missing-session']) assert.deepEqual(await f.observe({ ...f.input, sessionId }), { success: false, error: { code: 'SESSION_NOT_FOUND' } });
    const changed = initialSnapshot({ tenantId: caller.tenantId, brandId: caller.brandId }); changed.prompt += '\nSynthetic second version.';
    const changedHash = snapshotHash(changed);
    await f.db.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$4,$5,$6,$7)', ['another-pinned-version', caller.tenantId, caller.brandId, 'Synthetic', JSON.stringify(changed), changedHash, request.model]);
    assert.deepEqual(await f.observe({ ...f.input, versionId: 'another-pinned-version', contentHash: changedHash }), { success: false, error: { code: 'SESSION_MISMATCH' } });
    await f.db.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$4,$5,$6,$7)', ['corrupted-version', caller.tenantId, caller.brandId, 'Synthetic corrupt hash', JSON.stringify(changed), 'b'.repeat(64), request.model]);
    assert.deepEqual(await f.observe({ ...f.input, versionId: 'corrupted-version', contentHash: 'b'.repeat(64) }), { success: false, error: { code: 'VERSION_MISMATCH' } });
  } finally { await f.db.close(); }
});

test('ledger retains pending reserves and daily capacity counts only this actor in the rolling window', async () => {
  const f = await fixture();
  try {
    for (const userId of [caller.actorUserId, 'other-admin']) {
      const session = await f.sessions.create({ ...f.actor, userId }, { requestId: randomUUID(), label: 'Synthetic second session', scenario: 'free' }); assert.ok(session.ok);
      const sent = await f.sessions.send({ ...f.actor, userId }, session.value.id, { requestId: randomUUID(), text: 'Quero conhecer a franquia.' }); assert.ok(sent.ok);
    }
    const sent = await f.sessions.send(f.actor, f.session.id, { requestId: randomUUID(), text: 'Em qual cidade existe disponibilidade?' }); assert.ok(sent.ok);
    await f.db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp,created_at) VALUES('old-message',$1,$2,$3,$4,'candidate','text','Private old text',now(),now()-interval '25 hours'),('agent-message',$1,$2,$3,$4,'agent','text','Private agent text',now(),now())", [caller.tenantId, caller.brandId, f.session.id, f.session.candidateId]);
    for (const [id, gate, cost, reserve, settled] of [['settled', 'sprint3-continuous-20260910', 800, 50000, true], ['pending', 'sprint3-continuous-20260910', 50000, 50000, false], ['other-gate', 'unrelated-gate', 200000, 200000, false]] as const) {
      await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($1,$2,$3,$4,'lab_model_budget_reserved',$5)", [id, caller.tenantId, caller.brandId, f.session.id, JSON.stringify({ gateId: gate, costMicroUsd: cost, reservedMicroUsd: reserve, settled, privateUnusedField: 'Private ledger detail' })]);
    }
    const before = await f.unchanged(), result = await f.observe(); assert.ok(result.success);
    assert.deepEqual(result.data.ledger, { gateId: 'sprint3-continuous-20260910', policyLimitMicroUsd: 1_000_000, runtimeLimitVerified: false, accountedMicroUsd: 50800, remainingPolicyMicroUsd: 949200, reservationCount: 2, unsettledReservations: 1 });
    assert.equal(result.data.daily.usedMessages, 2); assert.equal(result.data.daily.remainingMessages, 98);
    assert.deepEqual(result.data.activeJobs, { scope: 3, actor: 2, session: 1 });
    assert.ok(result.data.pending.includes('UNSETTLED_RESERVATIONS_PRESENT')); assert.ok(result.data.pending.includes('ACTIVE_JOBS_PRESENT'));
    assert.equal(JSON.stringify(result).includes('Private'), false); assert.equal(JSON.stringify(result).includes('other-admin'), false);
    assert.deepEqual(await f.unchanged(), before);
  } finally { await f.db.close(); }
});

test('malformed, overflowed or released-pending ledger amounts fail closed rather than creating apparent capacity', async () => {
  const f = await fixture();
  try {
    const base = { gateId: 'sprint3-continuous-20260910', costMicroUsd: 50000, reservedMicroUsd: 50000, settled: false };
    await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES('bad-ledger',$1,$2,$3,'lab_model_budget_reserved',$4)", [caller.tenantId, caller.brandId, f.session.id, JSON.stringify(base)]);
    for (const detail of [{ ...base, costMicroUsd: -1 }, { ...base, costMicroUsd: 1.5 }, { ...base, costMicroUsd: '50000' },
      { ...base, costMicroUsd: null }, { ...base, costMicroUsd: 1 }, { ...base, costMicroUsd: 50001, settled: true },
      { ...base, settled: null }, { ...base, costMicroUsd: Number.MAX_SAFE_INTEGER + 1, reservedMicroUsd: Number.MAX_SAFE_INTEGER + 1 }]) {
      await f.db.query('UPDATE sdr.events SET detail=$1 WHERE id=$2', [JSON.stringify(detail), 'bad-ledger']);
      assert.deepEqual(await f.observe(), { success: false, error: { code: 'INVALID_LEDGER' } });
    }
    const huge = { ...base, costMicroUsd: Number.MAX_SAFE_INTEGER, reservedMicroUsd: Number.MAX_SAFE_INTEGER };
    await f.db.query('UPDATE sdr.events SET detail=$1 WHERE id=$2', [JSON.stringify(huge), 'bad-ledger']);
    await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES('overflow-ledger',$1,$2,$3,'lab_model_budget_reserved',$4)", [caller.tenantId, caller.brandId, f.session.id, JSON.stringify(base)]);
    assert.deepEqual(await f.observe(), { success: false, error: { code: 'INVALID_LEDGER' } });
  } finally { await f.db.close(); }
});

test('missing or paused session and exhausted policy capacity remain explicit pending facts', async () => {
  const f = await fixture();
  try {
    const { sessionId: _sessionId, ...withoutSession } = f.input;
    const absent = await f.observe(withoutSession); assert.ok(absent.success);
    assert.equal(absent.data.session, null); assert.equal(absent.data.activeJobs.session, null);
    assert.ok(absent.data.pending.includes('SESSION_NOT_PREPARED'));
    await f.db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) SELECT 'daily-'||n,$1,$2,$3,$4,'candidate','text','Synthetic capacity',now() FROM generate_series(1,101) n", [caller.tenantId, caller.brandId, f.session.id, f.session.candidateId]);
    await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES('full-ledger',$1,$2,$3,'lab_model_budget_reserved',$4)", [caller.tenantId, caller.brandId, f.session.id, JSON.stringify({ gateId: 'sprint3-continuous-20260910', costMicroUsd: 1000001, reservedMicroUsd: 1000001, settled: true })]);
    for (const state of ['human', 'stopped']) {
      await f.db.query('UPDATE sdr.conversations SET state=$2 WHERE id=$1', [f.session.id, state]);
      const before = await f.unchanged(), result = await f.observe(); assert.ok(result.success);
      assert.equal(result.data.session?.state, state); assert.ok(result.data.pending.includes('SESSION_NOT_AUTOMATIC'));
      assert.equal(result.data.daily.usedMessages, 101); assert.equal(result.data.daily.remainingMessages, 0);
      assert.equal(result.data.ledger.accountedMicroUsd, 1000001); assert.equal(result.data.ledger.remainingPolicyMicroUsd, 0);
      assert.ok(result.data.pending.includes('POLICY_BUDGET_EXHAUSTED')); assert.ok(result.data.pending.includes('ACTOR_DAILY_LIMIT_REACHED'));
      assert.deepEqual(await f.unchanged(), before);
    }
  } finally { await f.db.close(); }
});

test('colliding session, candidate, message and version IDs in other tenants or brands cannot contaminate observations', async () => {
  const f = await fixture();
  try {
    await f.db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES('collision',$1,$2,$3,$4,'candidate','text','Own synthetic text',now())", [caller.tenantId, caller.brandId, f.session.id, f.session.candidateId]);
    for (const [tenant, brand, label] of [['foreign-tenant', caller.brandId, 'tenant'], [caller.tenantId, 'foreign-brand', 'brand']]) {
      const p = [tenant, brand, 'foreign-channel-' + label];
      await f.db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$3)', p);
      await f.db.query("INSERT INTO sdr.channels(tenant_id,brand_id,phone_number_id,kind) VALUES($1,$2,$3,'laboratory')", p);
      const s = [tenant, brand, caller.tenantId, caller.brandId];
      await f.db.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) SELECT id,$1,$2,label,snapshot,content_hash,model FROM sdr.versions WHERE tenant_id=$3 AND brand_id=$4', s);
      await f.db.query('INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state) SELECT id,$1,$2,contact_id,authorized_contact_id,label,lead_state FROM sdr.candidates WHERE tenant_id=$3 AND brand_id=$4', s);
      await f.db.query("INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id,state) SELECT id,$1,$2,candidate_id,$5,'human' FROM sdr.conversations WHERE tenant_id=$3 AND brand_id=$4", [...s, p[2]]);
      await f.db.query('INSERT INTO sdr.lab_sessions(tenant_id,brand_id,id,owner_user_id,request_id,candidate_id,label,scenario,version_id) SELECT $1,$2,id,owner_user_id,request_id,candidate_id,label,scenario,version_id FROM sdr.lab_sessions WHERE tenant_id=$3 AND brand_id=$4', s);
      await f.db.query('INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) SELECT id,$1,$2,conversation_id,candidate_id,actor,type,text,provider_timestamp FROM sdr.messages WHERE tenant_id=$3 AND brand_id=$4', s);
      await f.db.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id) VALUES($1,$2,$3,$4,$5,'collision',0,0,$6)", ['foreign-job-' + label, tenant, brand, f.session.id, f.session.candidateId, f.input.versionId]);
      await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($1,$2,$3,$4,'lab_model_budget_reserved',$5)", ['foreign-ledger-' + label, tenant, brand, f.session.id, JSON.stringify({ gateId: 'sprint3-continuous-20260910', costMicroUsd: 999999, reservedMicroUsd: 999999, settled: false })]);
      await f.db.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) SELECT $1,tenant_id,brand_id,label,snapshot,$2,model FROM sdr.versions WHERE tenant_id=$3 AND brand_id=$4', ['foreign-only-' + label, 'b'.repeat(64), tenant, brand]);
      assert.deepEqual(await f.observe({ ...f.input, versionId: 'foreign-only-' + label, contentHash: 'b'.repeat(64) }), { success: false, error: { code: 'VERSION_MISMATCH' } });
    }
    const before = await f.unchanged(), result = await f.observe(); assert.ok(result.success);
    assert.equal(result.data.version.id, f.input.versionId); assert.equal(result.data.session?.state, 'automatic');
    assert.equal(result.data.daily.usedMessages, 1); assert.deepEqual(result.data.activeJobs, { scope: 0, actor: 0, session: 0 });
    assert.equal(result.data.ledger.accountedMicroUsd, 0); assert.equal(result.data.ledger.unsettledReservations, 0);
    assert.equal(JSON.stringify(result).includes('foreign-'), false); assert.deepEqual(await f.unchanged(), before);
  } finally { await f.db.close(); }
});
