import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';
import { initialSnapshot, seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Engine } from '../src/engine.js';

test('completion grounds the QA capital recap in the canonical trigger and persists its declared facts', async () => {
  const db = await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Fictional tester' }] });
    const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
    const created = await sessions.create(user, { requestId: randomUUID(), label: 'Capital fictício', scenario: 'investment' }); assert.ok(created.ok);
    const text = 'Tenho R$ 260 mil de recursos próprios disponíveis e pretendo abrir em três meses. Júlia participa da decisão, mas não aporta dinheiro. Esse investimento inclui capital de giro?';
    const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text }); assert.ok(sent.ok); assert.ok(sent.value.jobId);
    const channel = await store.scopeForJob(sent.value.jobId);
    await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1', [sent.value.jobId]);
    const job = await store.claim(channel); assert.ok(job);
    const engine = new Engine(store, testConfig, async () => Response.json({ accepted: true }));
    await engine.dispatch(channel, job);
    const bubbles = [
      'Perfeito, Clara — com R$ 260 mil próprios e meta de abertura em 3 meses, já consigo te posicionar melhor no perfil inicial.',
      'Sobre o giro: hoje a referência aprovada é “O investimento de referência para a Sapore Açaí é de R$ 250 mil a R$ 280 mil.” A composição desse valor, incluindo giro, ainda precisa de validação. Você já separou alguma reserva além desses R$ 260 mil ou esse é o total do projeto?',
    ];
    const callback = { jobId: job.id, contextVersion: job.context_version, result: { bubbles, proposals: [{ field: 'capital_available', value: { kind: 'number_range', min: 260000, max: 260000, unit: 'BRL' }, evidence: { messageId: job.trigger_message_id, quote: text }, attribution: 'candidate', capitalOrigin: 'own', relationId: null, replacesFactId: null }], relations: [], referral: null, sourceRefs: [initialSnapshot({tenantId:user.tenantId,brandId:user.brandId}).sources[0].id], nextAction: 'continue', handoffReason: null } };
    assert.equal((await engine.complete(callback)).accepted, true);
    const finished = (await db.query<{ state: string, error_code: string | null }>('SELECT state,error_code FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    assert.deepEqual(finished, { state: 'completed', error_code: null });
    const detail = await sessions.detail(user, created.value.id); assert.ok(detail.ok);
    assert.equal(detail.value.session.state, 'automatic');
    assert.deepEqual(detail.value.messages.filter(message => message.actor === 'agent').map(message => message.text), bubbles);
    const facts = (await db.query<{ data: { status: string, confirmedBy: string | null } }>('SELECT data FROM sdr.facts WHERE candidate_id=$1', [job.candidate_id])).rows;
    assert.equal(facts.length, 1); assert.equal(facts[0].data.status, 'declared'); assert.equal(facts[0].data.confirmedBy, null);
    assert.equal((await engine.complete(callback)).accepted, false);
    assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length, 0);
  } finally { await db.close(); }
});

test('informal WhatsApp capital recap persists the declared fact instead of handing off', async () => {
  const db = await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Fictional tester' }] });
    const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
    const created = await sessions.create(user, { requestId: randomUUID(), label: 'Capital informal', scenario: 'investment' }); assert.ok(created.ok);
    const text = 'Estou cmo 500k';
    const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text }); assert.ok(sent.ok); assert.ok(sent.value.jobId);
    const channel = await store.scopeForJob(sent.value.jobId);
    await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1', [sent.value.jobId]);
    const job = await store.claim(channel); assert.ok(job);
    const engine = new Engine(store, testConfig, async () => Response.json({ accepted: true }));
    await engine.dispatch(channel, job);
    const bubbles = [
      'Perfeito — anotei R$ 500 mil disponíveis. Esse é o valor que você declarou, não o preço da franquia.',
      'A origem desse capital é própria, de crédito ou mista?',
    ];
    const callback = { jobId: job.id, contextVersion: job.context_version, result: { bubbles, proposals: [{ field: 'capital_available', value: { kind: 'number_range', min: 500000, max: 500000, unit: 'BRL' }, evidence: { messageId: job.trigger_message_id, quote: text }, attribution: 'candidate', capitalOrigin: 'own', relationId: null, replacesFactId: null }], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null } };
    assert.equal((await engine.complete(callback)).accepted, true);
    const finished = (await db.query<{ state: string, error_code: string | null }>('SELECT state,error_code FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    assert.deepEqual(finished, { state: 'completed', error_code: null });
    const detail = await sessions.detail(user, created.value.id); assert.ok(detail.ok);
    assert.equal(detail.value.session.state, 'automatic');
    const facts = (await db.query<{ data: { field: string, value: { min: number } } }>('SELECT data FROM sdr.facts WHERE candidate_id=$1', [job.candidate_id])).rows;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].data.field, 'capital_available');
    assert.equal(facts[0].data.value.min, 500000);
  } finally { await db.close(); }
});
