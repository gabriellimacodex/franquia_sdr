import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { scoped, type Database, type Queryable, type Scope } from '../src/database.js';
import { Versioning, snapshotHash, type Snapshot, type ValidationReport } from '../src/versioning.js';
import { evaluationTenant, evaluationSource } from '../evaluations/scenarios.js';
import { SYSTEM_PROMPT } from '../src/prompts.js';
import { createLeadState } from '../src/domain.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { testConfig } from './config.js';
import { Lab } from '../src/lab.js';

const scope = { tenantId: 'version-test', brandId: 'sapore' };
const snapshot: Snapshot = { tenant: { ...evaluationTenant, ...scope }, sources: [], prompt: SYSTEM_PROMPT, model: 'gpt-5.4-2026-03-05', briefingModel: 'gpt-5-mini' };
async function setup(): Promise<Database> {
  const pg = new PGlite({ extensions: { vector } });
  await pg.exec(await readFile(new URL('../migrations/001_sdr.sql', import.meta.url), 'utf8'));
  await pg.exec(await readFile(new URL('../migrations/002_versions.sql', import.meta.url), 'utf8'));
  await pg.exec(await readFile(new URL('../migrations/003_lab_sessions.sql', import.meta.url), 'utf8'));
  const db: Database = { query: (sql, params) => pg.query(sql, params), transaction: fn => pg.transaction(tx => fn(tx as Queryable)), close: () => pg.close() };
  await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2)', [scope.tenantId, scope.brandId]);
  await db.query("INSERT INTO sdr.memberships(user_id,tenant_id,brand_id,role) VALUES('admin',$1,$2,'admin'),('reviewer',$1,$2,'reviewer')", [scope.tenantId, scope.brandId]);
  await db.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,enabled) VALUES('fictional-phone',$1,$2,false)", [scope.tenantId, scope.brandId]);
  return db;
}

test('saving scoped drafts stores immutable snapshots and never activates the channel', async () => {
  const db = await setup();
  try {
    const service = new Versioning(db);
    const result = await service.saveDraft(scope, snapshot, 'admin');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.contentHash, snapshotHash(snapshot));
    const same = await service.saveDraft(scope, structuredClone(snapshot), 'admin');
    assert.equal(same.ok, true);
    if (same.ok) assert.equal(same.value.versionId, result.value.versionId);
    assert.equal((await service.saveDraft(scope, snapshot, 'reviewer')).ok, false);
    const rows = await scoped(db, scope, tx => tx.query<{ enabled: boolean }>('SELECT enabled FROM sdr.channels WHERE tenant_id=$1 AND brand_id=$2', [scope.tenantId, scope.brandId]));
    assert.equal(rows.rows[0].enabled, false);
    await assert.rejects(scoped(db, scope, tx => tx.query("UPDATE sdr.versions SET label='changed' WHERE tenant_id=$1 AND brand_id=$2", [scope.tenantId, scope.brandId])), /immutable/);
  } finally { await db.close(); }
});

test('restoring a historical snapshot creates a draft and cannot mutate or silently activate history', async () => {
  const db = await setup();
  try {
    const service = new Versioning(db);
    const first = await service.saveDraft(scope, snapshot, 'admin');
    const changed = await service.saveDraft(scope, { ...snapshot, prompt: SYSTEM_PROMPT + '\nAjuste fictício de teste.' }, 'admin');
    assert.equal(first.ok && changed.ok, true);
    if (!first.ok || !changed.ok) return;
    assert.notEqual(first.value.contentHash, changed.value.contentHash);
    const restored = await service.restoreDraft(scope, first.value.versionId, 'admin');
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.value.versionId, first.value.versionId);
    assert.equal(restored.value.restoredFromVersionId, first.value.versionId);
    const current = await service.getDraft(scope, 'admin');
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.value?.contentHash, first.value.contentHash);
    const active = await scoped(db, scope, tx => tx.query('SELECT * FROM sdr.active_versions WHERE tenant_id=$1 AND brand_id=$2', [scope.tenantId, scope.brandId]));
    assert.equal(active.rows.length, 0);
    assert.equal((await service.restoreDraft(scope, 'unknown-version', 'admin')).ok, false);
  } finally { await db.close(); }
});

// These records simulate trusted recorder input in an ephemeral database. They are NOT model measurements.
const reportFixture = (suiteType: ValidationReport['suiteType'], execution: ValidationReport['execution'] = 'synthetic'): ValidationReport => ({ suiteType, execution, scenarioCount: 32, repeatCount: 2, criticalViolations: [], humanAverage: suiteType === 'conversation' ? 4.5 : null, evidenceRefs: ['urn:local-unit-test:simulated-validation-record'], model: suiteType === 'conversation' ? snapshot.model : null });

test('publication gates the exact approved hash, rejects synthetic quality and invalidates changed content', async () => {
  const db = await setup();
  try {
    const service = new Versioning(db);
    const saved = await service.saveDraft(scope, snapshot, 'admin');
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const hash = saved.value.contentHash;
    assert.deepEqual(await service.publish(scope, 'admin', hash), { ok: false, error: { code: 'VALIDATION_REQUIRED' } });
    for (const suite of ['deterministic', 'conversation'] as const) assert.equal((await service.recordValidation(scope, hash, reportFixture(suite), 'admin')).ok, true);
    assert.deepEqual(await service.publish(scope, 'admin', hash), { ok: false, error: { code: 'QUALITY_GATE_FAILED' } });
    // Positive test simulates the authenticated recorder attesting real execution; no external calls occur.
    for (const suite of ['deterministic', 'conversation'] as const) assert.equal((await service.recordValidation(scope, hash, reportFixture(suite, 'measured'), 'admin')).ok, true);
    assert.deepEqual(await service.publish(scope, 'admin', '0'.repeat(64)), { ok: false, error: { code: 'APPROVAL_HASH_MISMATCH' } });
    const published = await service.publish(scope, 'admin', hash);
    assert.equal(published.ok, true);
    const channel = await db.query<{ enabled: boolean }>("SELECT enabled FROM sdr.channels WHERE phone_number_id='fictional-phone'");
    assert.equal(channel.rows[0].enabled, false);
    const changed = await service.saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nMudança fictícia posterior.' }, 'admin');
    assert.equal(changed.ok, true);
    if (changed.ok) assert.deepEqual(await service.publish(scope, 'admin', changed.value.contentHash), { ok: false, error: { code: 'VALIDATION_REQUIRED' } });
    await service.restoreDraft(scope, saved.value.versionId, 'admin');
    await service.recordValidation(scope, hash, { ...reportFixture('conversation', 'measured'), criticalViolations: ['simulated-regression'] }, 'admin');
    assert.deepEqual(await service.publish(scope, 'admin', hash), { ok: false, error: { code: 'QUALITY_GATE_FAILED' } });
    const events = await scoped(db, scope, tx => tx.query('SELECT * FROM sdr.publication_events WHERE tenant_id=$1 AND brand_id=$2', [scope.tenantId, scope.brandId]));
    assert.equal(events.rows.length, 1);
  } finally { await db.close(); }
});

test('each quality threshold and trusted-recorder authorization independently blocks publication', async () => {
  const db = await setup();
  try {
    const service = new Versioning(db);
    const saved = await service.saveDraft(scope, snapshot, 'admin');
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const hash = saved.value.contentHash;
    await service.recordValidation(scope, hash, reportFixture('deterministic', 'measured'), 'admin');
    for (const change of [{ scenarioCount: 29 }, { repeatCount: 1 }, { humanAverage: 3.9 }, { criticalViolations: ['simulated-critical'] }, { execution: 'synthetic' as const }]) {
      assert.equal((await service.recordValidation(scope, hash, { ...reportFixture('conversation', 'measured'), ...change }, 'admin')).ok, true);
      const state = await service.validationState(scope, hash, 'admin');
      assert.equal(state.ok, true);
      if (state.ok) assert.equal(state.value.ready, false);
      assert.deepEqual(await service.publish(scope, 'admin', hash), { ok: false, error: { code: 'QUALITY_GATE_FAILED' } });
    }
    assert.deepEqual(await service.recordValidation(scope, hash, reportFixture('conversation', 'measured'), 'reviewer'), { ok: false, error: { code: 'FORBIDDEN' } });
    assert.deepEqual(await service.recordValidation(scope, hash, { ...reportFixture('conversation', 'measured'), model: 'other-model' }, 'admin'), { ok: false, error: { code: 'REPORT_MODEL_MISMATCH' } });
    await assert.rejects(scoped(db, scope, tx => tx.query("UPDATE sdr.validation_runs SET report='{}' WHERE tenant_id=$1 AND brand_id=$2", [scope.tenantId, scope.brandId])), /immutable/);
  } finally { await db.close(); }
});

test('saving a draft indexes its approved snapshot sources before validation can run', async () => {
  const db = await setup();
  try {
    const service = new Versioning(db);
    const result = await service.saveDraft(scope, { ...snapshot, sources: [{ ...evaluationSource, ...scope, validFrom: '2020-01-01T00:00:00.000Z' }] }, 'admin');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const chunks = await scoped(db, scope, tx => tx.query<{ content: string }>('SELECT content FROM sdr.knowledge_chunks WHERE tenant_id=$1 AND brand_id=$2 AND version_id=$3', [scope.tenantId, scope.brandId, result.value.versionId]));
    assert.equal(chunks.rows.length, 1);
    assert.equal(chunks.rows[0].content, evaluationSource.content);
  } finally { await db.close(); }
});

test('publishing invalidates only undispatched work from the previous scoped version and rejects its late facts', async () => {
  const db = await setup();
  try {
    const service = new Versioning(db);
    const previous = await service.saveDraft(scope, snapshot, 'admin');
    assert.equal(previous.ok, true);
    if (!previous.ok) return;
    for (const suite of ['deterministic', 'conversation'] as const) await service.recordValidation(scope, previous.value.contentHash, reportFixture(suite, 'measured'), 'admin');
    assert.equal((await service.publish(scope, 'admin', previous.value.contentHash)).ok, true);
    const next = await service.saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nNova versão fictícia.' }, 'admin');
    assert.equal(next.ok, true);
    if (!next.ok) return;
    for (const suite of ['deterministic', 'conversation'] as const) await service.recordValidation(scope, next.value.contentHash, reportFixture(suite, 'measured'), 'admin');

    async function seedJobs(target: Scope, phone: string, versionId: string, label: string, states: string[]) {
      await scoped(db, target, async tx => {
        const lead = createLeadState(target.tenantId, target.brandId, label + '-lead');
        await tx.query('INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state) VALUES($1,$2,$3,$1,$1,$1,$4)', [lead.leadId, target.tenantId, target.brandId, JSON.stringify(lead)]);
        await tx.query('INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) VALUES($1,$2,$3,$4,$5)', [label + '-conversation', target.tenantId, target.brandId, lead.leadId, phone]);
        await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($1,$2,$3,$4,$5,'candidate','text','Meu nome é Ana.',now())", [label + '-message', target.tenantId, target.brandId, label + '-conversation', lead.leadId]);
        for (const state of states) await tx.query('INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state) VALUES($1,$2,$3,$4,$5,$1,0,0,$6,$7)', [phone + ':' + label + '-' + state, target.tenantId, target.brandId, label + '-conversation', lead.leadId, versionId, state]);
      });
    }
    const invalidate = ['pending', 'working', 'running', 'ready'];
    const preserve = ['dispatching', 'dispatched', 'sent', 'stale', 'handoff'];
    await seedJobs(scope, 'fictional-phone', previous.value.versionId, 'old', [...invalidate, ...preserve]);
    await seedJobs(scope, 'fictional-phone', next.value.versionId, 'current', ['pending']);
    await db.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,kind) VALUES('lab-test',$1,$2,'laboratory')",[scope.tenantId,scope.brandId]);
    await seedJobs(scope,'lab-test',previous.value.versionId,'pinned-lab',['pending']);
    for (const [target, phone] of [[{ ...scope, brandId: 'other-brand' }, 'other-brand-phone'], [{ ...scope, tenantId: 'other-tenant' }, 'other-tenant-phone']] as const) {
      await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2)', [target.tenantId, target.brandId]);
      await db.query('INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id) VALUES($1,$2,$3)', [phone, target.tenantId, target.brandId]);
      await scoped(db, target, tx => tx.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$1,$4,$5,$6)', [previous.value.versionId, target.tenantId, target.brandId, JSON.stringify({ ...snapshot, tenant: { ...snapshot.tenant, ...target } }), previous.value.contentHash, snapshot.model]));
      await seedJobs(target, phone, previous.value.versionId, phone, ['pending']);
    }
    assert.equal((await service.publish(scope, 'admin', '0'.repeat(64))).ok, false);
    assert.equal((await db.query<{ state: string }>("SELECT state FROM sdr.jobs WHERE id='fictional-phone:old-running'")).rows[0].state, 'running');
    assert.equal((await service.publish(scope, 'admin', next.value.contentHash)).ok, true);
    const jobs = (await db.query<{ id: string; state: string; error_code: string | null }>('SELECT id,state,error_code FROM sdr.jobs')).rows;
    assert.equal(jobs.find(job=>job.id==='lab-test:pinned-lab-pending')?.state,'pending');
    for (const state of invalidate) assert.deepEqual(jobs.find(job => job.id === 'fictional-phone:old-' + state), { id: 'fictional-phone:old-' + state, state: 'stale', error_code: 'VERSION_CHANGED' });
    for (const state of preserve) assert.equal(jobs.find(job => job.id === 'fictional-phone:old-' + state)?.state, state);
    assert.equal(jobs.find(job => job.id === 'fictional-phone:current-pending')?.state, 'pending');
    assert.ok(jobs.filter(job => job.id.startsWith('other-')).every(job => job.state === 'pending'));
    const engine = new Engine(new Store(db), testConfig, async () => { throw new Error('Unexpected network call'); });
    const completion = await engine.complete({ jobId: 'fictional-phone:old-running', contextVersion: 0, result: { bubbles: ['Em qual cidade você pretende abrir?'], proposals: [{ field: 'name', value: { kind: 'text', text: 'Ana' }, evidence: { messageId: 'old-message', quote: 'Meu nome é Ana.' }, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: null }], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null } });
    assert.deepEqual(completion, { accepted: false, reason: 'STALE_RESULT' });
    assert.equal((await db.query('SELECT * FROM sdr.facts')).rows.length, 0);
    assert.equal((await service.publish(scope, 'admin', next.value.contentHash)).ok, true);
    assert.equal((await db.query<{ state: string }>("SELECT state FROM sdr.jobs WHERE id='fictional-phone:current-pending'")).rows[0].state, 'pending');
  } finally { await db.close(); }
});

test('the lab reports latest validation status by content hash even after an older publication', async () => {
  const db = await setup();
  try {
    const service = new Versioning(db), lab = new Lab(db);
    const saved = await service.saveDraft(scope, snapshot, 'admin');
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    const status = async (id: string) => (await lab.versions(scope)).versions.find(version => version.id === id)?.testStatus;
    assert.equal(await status(saved.value.versionId), 'untested');
    for (const suite of ['deterministic', 'conversation'] as const) await service.recordValidation(scope, saved.value.contentHash, reportFixture(suite, 'measured'), 'admin');
    assert.equal(await status(saved.value.versionId), 'passed');
    assert.equal((await service.publish(scope, 'admin', saved.value.contentHash)).ok, true);
    await service.recordValidation(scope, saved.value.contentHash, { ...reportFixture('conversation', 'measured'), criticalViolations: ['simulated-new-failure'] }, 'admin');
    assert.equal(await status(saved.value.versionId), 'failed');
    const validation = await service.validationState(scope, saved.value.contentHash, 'admin');
    assert.equal(validation.ok, true);
    if (validation.ok) assert.equal(validation.value.ready, false);
    const changed = await service.saveDraft(scope, { ...snapshot, prompt: snapshot.prompt + '\nSem testes para este novo hash.' }, 'admin');
    assert.equal(changed.ok, true);
    if (changed.ok) assert.equal(await status(changed.value.versionId), 'untested');
    const historical = await scoped(db, scope, tx => tx.query<{ test_status: string }>('SELECT test_status FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3', [scope.tenantId, scope.brandId, saved.value.versionId]));
    assert.equal(historical.rows[0].test_status, 'untested');
  } finally { await db.close(); }
});
