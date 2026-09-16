import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { seedPilot } from '../src/seed.js';
import { createServer } from '../src/server.js';
import { testConfig } from './config.js';
import { Versioning, type Snapshot } from '../src/versioning.js';
import { LabSessions } from '../src/lab-sessions.js';

const scope = { tenantId: 'cognita-homologacao', brandId: 'sapore' };
async function database(): Promise<Database> {
  const pg = new PGlite({ extensions: { vector } });
  for (const file of ['001_sdr.sql', '002_versions.sql', '003_lab_sessions.sql', '004_candidate_reset.sql']) {
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  return { query: (sql, params) => pg.query(sql, params), transaction: fn => pg.transaction(tx => fn(tx as Queryable)), close: () => pg.close() };
}

test('admin evaluates the exact current draft without publishing it or changing ordinary sessions', async () => {
  const db = await database();
  const app = await createServer(db, { ...testConfig, EXECUTION_MODE: 'laboratory' }, { transport: async () => Response.json({ id: 'admin' }) });
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    await db.query("INSERT INTO sdr.memberships VALUES ('admin','cognita-homologacao','sapore','admin',true)");
    const active = (await db.query<{ version_id: string; snapshot: Snapshot }>(`SELECT a.version_id,v.snapshot
      FROM sdr.active_versions a JOIN sdr.versions v ON (v.tenant_id,v.brand_id,v.id)=(a.tenant_id,a.brand_id,a.version_id)`)).rows[0];
    const saved = await new Versioning(db).saveDraft(scope, { ...active.snapshot, prompt: active.snapshot.prompt + '\nCandidato fictício de avaliação.' }, 'admin');
    assert.ok(saved.ok);
    const headers = { authorization: 'Bearer admin' };
    const response = await app.inject({ method: 'POST', url: '/v1/lab/evaluation-sessions', headers,
      payload: { requestId: randomUUID(), label: 'Candidato não publicado', scenario: 'investment', versionId: saved.value.versionId, contentHash: saved.value.contentHash } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().versionId, saved.value.versionId);
    const normal = await app.inject({ method: 'POST', url: '/v1/lab/sessions', headers,
      payload: { requestId: randomUUID(), label: 'Versão pública', scenario: 'free' } });
    assert.equal(normal.statusCode, 200, normal.body);
    assert.equal(normal.json().versionId, active.version_id);
    assert.equal((await db.query<{ version_id: string }>('SELECT version_id FROM sdr.active_versions')).rows[0].version_id, active.version_id);
    assert.equal((await db.query('SELECT id FROM sdr.publication_events')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM sdr.jobs')).rows.length, 0);
    assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await app.close(); await db.close(); }
});

test('the evaluation-only route is unavailable outside laboratory execution mode', async () => {
  const db = await database();
  const app = await createServer(db, { ...testConfig, EXECUTION_MODE: 'whatsapp' });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/lab/evaluation-sessions', payload: {} });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, 'EVALUATION_LAB_ONLY');
    assert.equal((await db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 0);
  } finally { await app.close(); await db.close(); }
});

test('evaluation request id cannot be rebound to a different draft version', async () => {
  const db = await database();
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    await db.query("INSERT INTO sdr.memberships VALUES ('admin','cognita-homologacao','sapore','admin',true)");
    const snapshot = (await db.query<{ snapshot: Snapshot }>('SELECT snapshot FROM sdr.versions')).rows[0].snapshot;
    const versions = new Versioning(db), sessions = new LabSessions(db);
    const user = { ...scope, userId: 'admin', role: 'admin' };
    const first = await versions.saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nCandidato A.' }, user.userId);
    assert.ok(first.ok);
    const input = { requestId: randomUUID(), label: 'Mesmo identificador', scenario: 'free', versionId: first.value.versionId, contentHash: first.value.contentHash };
    const created = await sessions.createEvaluation(user, input);
    assert.ok(created.ok);
    assert.deepEqual(await sessions.createEvaluation(user, input), created);
    const second = await versions.saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nCandidato B.' }, user.userId);
    assert.ok(second.ok);
    const collision = await sessions.createEvaluation(user, { ...input, versionId: second.value.versionId, contentHash: second.value.contentHash });
    assert.deepEqual(collision, { ok: false, error: { code: 'REQUEST_CONFLICT' } });
    assert.equal((await db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 1);
  } finally { await db.close(); }
});

test('downgraded admin cannot send another message to an evaluation session', async () => {
  const db = await database();
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    await db.query("INSERT INTO sdr.memberships VALUES ('admin','cognita-homologacao','sapore','admin',true)");
    const snapshot = (await db.query<{ snapshot: Snapshot }>('SELECT snapshot FROM sdr.versions')).rows[0].snapshot;
    const saved = await new Versioning(db).saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nRascunho privado.' }, 'admin');
    assert.ok(saved.ok);
    const sessions = new LabSessions(db), user = { ...scope, userId: 'admin', role: 'admin' };
    const created = await sessions.createEvaluation(user, { requestId: randomUUID(), label: 'Acesso revogado', scenario: 'free', versionId: saved.value.versionId, contentHash: saved.value.contentHash });
    assert.ok(created.ok);
    await db.query("UPDATE sdr.memberships SET role='tester' WHERE user_id='admin'");
    const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text: 'Quero conhecer os valores.' });
    assert.deepEqual(sent, { ok: false, error: { code: 'FORBIDDEN' } });
    assert.equal((await db.query('SELECT id FROM sdr.messages')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM sdr.jobs')).rows.length, 0);
  } finally { await db.close(); }
});

test('normal creation cannot replay an evaluation request as an ordinary session', async () => {
  const db = await database();
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    await db.query("INSERT INTO sdr.memberships VALUES ('admin','cognita-homologacao','sapore','admin',true)");
    const snapshot = (await db.query<{ snapshot: Snapshot }>('SELECT snapshot FROM sdr.versions')).rows[0].snapshot;
    const saved = await new Versioning(db).saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nAvaliação separada.' }, 'admin');
    assert.ok(saved.ok);
    const sessions = new LabSessions(db), user = { ...scope, userId: 'admin', role: 'admin' };
    const input = { requestId: randomUUID(), label: 'Identidade da execução', scenario: 'free' };
    const created = await sessions.createEvaluation(user, { ...input, versionId: saved.value.versionId, contentHash: saved.value.contentHash });
    assert.ok(created.ok);
    const replay = await sessions.create(user, input);
    assert.deepEqual(replay, { ok: false, error: { code: 'REQUEST_CONFLICT' } });
    assert.equal((await db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 1);
  } finally { await db.close(); }
});

test('evaluation API reports malformed contracts as 400, consistent with normal sessions', async () => {
  const db = await database();
  const app = await createServer(db, { ...testConfig, EXECUTION_MODE: 'laboratory' }, { transport: async () => Response.json({ id: 'admin' }) });
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    await db.query("INSERT INTO sdr.memberships VALUES ('admin','cognita-homologacao','sapore','admin',true)");
    const response = await app.inject({ method: 'POST', url: '/v1/lab/evaluation-sessions', headers: { authorization: 'Bearer admin' }, payload: {} });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'INVALID_CONTRACT');
  } finally { await app.close(); await db.close(); }
});

test('evaluation creation trusts active scoped membership, not a caller-provided admin role', async () => {
  const db = await database();
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    for (const role of ['tester', 'reviewer', 'admin']) {
      await db.query('INSERT INTO sdr.memberships VALUES ($1,$2,$3,$4,$5)', [role, scope.tenantId, scope.brandId, role, role !== 'admin']);
    }
    const sessions = new LabSessions(db);
    const input = { requestId: randomUUID(), label: 'Negativa de acesso', scenario: 'free', versionId: 'unknown', contentHash: 'a'.repeat(64) };
    for (const userId of ['tester', 'reviewer', 'admin', 'missing']) {
      assert.deepEqual(await sessions.createEvaluation({ ...scope, userId, role: 'admin' }, input), { ok: false, error: { code: 'FORBIDDEN' } });
    }
    assert.equal((await db.query('SELECT id FROM sdr.candidates')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 0);
  } finally { await db.close(); }
});

test('evaluation rejects wrong hashes, obsolete drafts and extra version input on the normal route', async () => {
  const db = await database();
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    await db.query("INSERT INTO sdr.memberships VALUES ('admin','cognita-homologacao','sapore','admin',true)");
    const snapshot = (await db.query<{ snapshot: Snapshot }>('SELECT snapshot FROM sdr.versions')).rows[0].snapshot;
    const versions = new Versioning(db), sessions = new LabSessions(db), user = { ...scope, userId: 'admin', role: 'admin' };
    const first = await versions.saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nCandidato anterior.' }, user.userId);
    assert.ok(first.ok);
    const input = { requestId: randomUUID(), label: 'Hash fixo', scenario: 'investment', versionId: first.value.versionId, contentHash: first.value.contentHash };
    assert.deepEqual(await sessions.createEvaluation(user, { ...input, contentHash: '0'.repeat(64) }), { ok: false, error: { code: 'EVALUATION_DRAFT_MISMATCH' } });
    const next = await versions.saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nCandidato seguinte.' }, user.userId);
    assert.ok(next.ok);
    assert.deepEqual(await sessions.createEvaluation(user, input), { ok: false, error: { code: 'EVALUATION_DRAFT_MISMATCH' } });
    assert.deepEqual(await sessions.create(user, input), { ok: false, error: { code: 'INVALID_CONTRACT' } });
    assert.equal((await db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM sdr.jobs')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM sdr.publication_events')).rows.length, 0);
  } finally { await db.close(); }
});
