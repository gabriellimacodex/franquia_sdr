import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';
import { initialSnapshot, seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Engine } from '../src/engine.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { FINANCIAL_OUTPUT_JSON_SCHEMA } from '../src/financial-reply.js';
import { snapshotHash } from '../src/versioning.js';

async function fixture(v2 = true) {
  const db = await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  const original = await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Fictício' }] });
  const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
  const snapshot = createFinancialDraftSnapshot(initialSnapshot({ tenantId: user.tenantId, brandId: user.brandId }));
  const versionId = 'local-v2-fixture';
  // Ephemeral test setup only; does not record measured validation or bypass a remote gate.
  await db.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$4,$5,$6,$7)', [versionId, user.tenantId, user.brandId, 'Local test fixture', JSON.stringify(snapshot), snapshotHash(snapshot), snapshot.model]);
  await db.query('INSERT INTO sdr.knowledge_chunks(tenant_id,brand_id,version_id,id,title,content,approved,active,valid_from,valid_until,metadata) SELECT tenant_id,brand_id,$1,id,title,content,approved,active,valid_from,valid_until,metadata FROM sdr.knowledge_chunks WHERE version_id=$2', [versionId, original.versionId]);
  if (v2) await db.query('UPDATE sdr.active_versions SET version_id=$1', [versionId]);
  const created = await sessions.create(user, { requestId: randomUUID(), label: 'Financeiro fictício', scenario: 'investment' }); assert.ok(created.ok);
  const text = 'Tenho R$ 260 mil de recursos próprios disponíveis e pretendo abrir em três meses. Júlia participa da decisão, mas não aporta dinheiro. Esse investimento inclui capital de giro?';
  const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text }); assert.ok(sent.ok); assert.ok(sent.value.jobId);
  const channel = await store.scopeForJob(sent.value.jobId), job = await store.claim(channel); assert.ok(job);
  const evidence = { messageId: job.trigger_message_id, quote: text };
  const result = { bubbles: [], proposals: [{ field: 'capital_available', value: { kind: 'number_range', min: 260000, max: 260000, unit: 'BRL' }, evidence, attribution: 'candidate', capitalOrigin: 'own', relationId: null, replacesFactId: null }], relations: [], referral: null, sourceRefs: [snapshot.sources[0].id], nextAction: 'continue', handoffReason: null,
    financialReply: { capitalEvidence: evidence, investmentSourceId: snapshot.sources[0].id, followUp: 'experience' } };
  const engine = new Engine(store, testConfig, async () => Response.json({ accepted: true }));
  return { db, store, sessions, user, job, channel, engine, result, sessionId: created.value.id, originalVersionId: original.versionId, versionId };
}

test('a pinned v2 job renders structured finance and persists only declared capital, independent of active version', async () => {
  const f = await fixture();
  try {
    await f.db.query('UPDATE sdr.active_versions SET version_id=$1', [f.originalVersionId]);
    const prepared = await f.engine.prepare(f.channel, f.job);
    assert.deepEqual(prepared.outputSchema, FINANCIAL_OUTPUT_JSON_SCHEMA);
    assert.equal(prepared.configVersion, f.versionId);
    assert.ok(prepared.instructions.includes('financialReply'));
    await f.engine.dispatch(f.channel, f.job);
    const callback = { jobId: f.job.id, contextVersion: f.job.context_version, configVersion: f.versionId, result: f.result };
    assert.deepEqual(await f.engine.complete(callback), { accepted: true });
    const detail = await f.sessions.detail(f.user, f.sessionId); assert.ok(detail.ok);
    assert.equal(detail.value.session.state, 'automatic');
    const bubbles = detail.value.messages.filter(message => message.actor === 'agent').map(message => String(message.text));
    assert.equal(bubbles.length, 2);
    assert.match(bubbles[0], /Você informou R\$ 260\.000,00/);
    assert.match(bubbles[0], /R\$ 250 mil a R\$ 280 mil/);
    const facts = (await f.db.query<{ data: { status: string, confirmedBy: string | null, attribution: string } }>('SELECT data FROM sdr.facts WHERE candidate_id=$1', [f.job.candidate_id])).rows;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].data.status, 'declared'); assert.equal(facts[0].data.confirmedBy, null); assert.equal(facts[0].data.attribution, 'candidate');
    assert.deepEqual(await f.engine.complete(callback), { accepted: false, reason: 'STALE_RESULT' });
    assert.equal((await f.db.query('SELECT * FROM sdr.deliveries')).rows.length, 0);
  } finally { await f.db.close(); }
});

test('callbacks cannot select or downgrade the output contract of the immutable job version', async () => {
  for (const v2 of [true, false]) {
    const f = await fixture(v2);
    try {
      await f.engine.dispatch(f.channel, f.job);
      const { financialReply: _financialReply, ...legacy } = { ...f.result, bubbles: ['Obrigado.'], proposals: [] };
      const mismatched = v2 ? legacy : f.result;
      await assert.rejects(f.engine.complete({ jobId: f.job.id, contextVersion: f.job.context_version, result: mismatched }), /OUTPUT_CONTRACT_MISMATCH/);
      const detail = await f.sessions.detail(f.user, f.sessionId); assert.ok(detail.ok);
      assert.equal(detail.value.session.state, 'automatic');
      assert.equal(detail.value.messages.filter(message => message.actor === 'agent').length, 0);
      assert.equal((await f.db.query('SELECT * FROM sdr.facts WHERE candidate_id=$1', [f.job.candidate_id])).rows.length, 0);
      const valid = v2 ? f.result : legacy;
      assert.deepEqual(await f.engine.complete({ jobId: f.job.id, contextVersion: f.job.context_version, result: valid }), { accepted: true });
    } finally { await f.db.close(); }
  }
});

test('a forged v2 monetary proposal is blocked before either facts or unsafe messages are persisted', async () => {
  const f = await fixture();
  try {
    await f.engine.dispatch(f.channel, f.job);
    const result = { ...f.result, proposals: [{ ...f.result.proposals[0], value: { kind: 'number_range', min: 999000, max: 999000, unit: 'BRL' } }] };
    assert.deepEqual(await f.engine.complete({ jobId: f.job.id, contextVersion: f.job.context_version, result }), { accepted: true });
    const detail = await f.sessions.detail(f.user, f.sessionId); assert.ok(detail.ok);
    assert.equal(detail.value.session.state, 'human');
    assert.equal((await f.db.query('SELECT * FROM sdr.facts WHERE candidate_id=$1', [f.job.candidate_id])).rows.length, 0);
    assert.equal(detail.value.messages.filter(message => message.actor === 'agent').some(message => /999|260|250/.test(String(message.text))), false);
    const job = (await f.db.query<{ error_code: string }>('SELECT error_code FROM sdr.jobs WHERE id=$1', [f.job.id])).rows[0];
    assert.equal(job.error_code, 'POLICY_GUARD');
  } finally { await f.db.close(); }
});
