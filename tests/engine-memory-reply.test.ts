import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';
import { seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Engine } from '../src/engine.js';
import type { AgentDecision, LeadState } from '../src/domain.js';

test('laboratory correction persists conflict and publishes an honest reply atomically', async () => {
  const db = await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Fictional tester' }] });
    const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
    const created = await sessions.create(user, { requestId: randomUUID(), label: 'Correção fictícia', scenario: 'correction' });
    assert.ok(created.ok);
    const engine = new Engine(store, testConfig, async () => Response.json({ accepted: true }));
    let previousId: string | null = null;
    for (const city of ['Vila Aurora', 'Vila Horizonte']) {
      const text = previousId ? `Corrigindo: a cidade é ${city}.` : `Quero abrir em ${city}.`;
      const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text });
      assert.ok(sent.ok); assert.ok(sent.value.jobId);
      const channel = await store.scopeForJob(sent.value.jobId);
      await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1', [sent.value.jobId]);
      const job = await store.claim(channel); assert.ok(job);
      await engine.dispatch(channel, job);
      const result: AgentDecision = { bubbles: previousId ? ['Perfeito — atualizo para Vila Horizonte.', 'Você mesma administra a loja e Caio participa da decisão; em quanto tempo pretende abrir?'] : ['Entendi. Quem vai administrar a loja?'], proposals: [{ field: 'city', value: { kind: 'text', text: city }, evidence: { messageId: job.trigger_message_id, quote: text }, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: previousId }], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null };
      const callback = { jobId: job.id, contextVersion: job.context_version, result };
      assert.equal((await engine.complete(callback)).accepted, true);
      const state: LeadState = (await db.query<{ lead_state: LeadState }>('SELECT lead_state FROM sdr.candidates WHERE id=$1', [created.value.candidateId])).rows[0].lead_state;
      if (previousId) {
        assert.deepEqual(state.facts.map(fact => fact.status), ['declared', 'conflict']);
        const detail = await sessions.detail(user, created.value.id); assert.ok(detail.ok);
        assert.equal(detail.value.session.state, 'automatic');
        const replies = detail.value.messages.filter(message => message.actor === 'agent').slice(-2);
        assert.match(String(replies[0].text), /registrada para revisão/);
        assert.doesNotMatch(String(replies[0].text), /atualizo/);
        assert.equal(replies[1].text, result.bubbles[1]);
        assert.equal((await engine.complete(callback)).accepted, false);
        assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length, 0);
      }
      previousId = state.facts[0].id;
    }
  } finally { await db.close(); }
});

test('a correction preserves the first-bubble operating and decision answer, memory and replay safety', async () => {
  const db = await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Fictional tester' }] });
    const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
    const created = await sessions.create(user, { requestId: randomUUID(), label: 'Memória fictícia Marina', scenario: 'correction' });
    assert.ok(created.ok);
    const providerCalls: string[] = [];
    const engine = new Engine(store, testConfig, async url => { providerCalls.push(String(url)); return Response.json({ accepted: true }); });
    const completeTurn = async (text: string, decision: (messageId: string) => AgentDecision) => {
      const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text });
      assert.ok(sent.ok); assert.ok(sent.value.jobId);
      const channel = await store.scopeForJob(sent.value.jobId);
      const job = await store.claim(channel); assert.ok(job); assert.equal(job.id, sent.value.jobId);
      await engine.dispatch(channel, job);
      const callback = { jobId: job.id, contextVersion: job.context_version, result: decision(job.trigger_message_id) };
      assert.equal((await engine.complete(callback)).accepted, true);
      return { job, callback };
    };
    const profile = 'Sou Marina Teste, de Vila Aurora. Eu vou administrar a loja e meu irmão Caio participa da decisão.';
    await completeTurn(profile, messageId => ({
      bubbles: ['Entendi, Marina. Em quanto tempo pretende abrir?'],
      proposals: ([['name', 'Marina Teste'], ['city', 'Vila Aurora'], ['operating_role', 'A própria candidata vai administrar a loja'], ['decision_role', 'A candidata decide junto com o irmão Caio']] as const).map(([field, text]) => ({ field, value: { kind: 'text', text }, evidence: { messageId, quote: profile }, attribution: 'candidate', capitalOrigin: null, relationId: field === 'decision_role' ? 'rel-caio' : null, replacesFactId: null })),
      relations: [{ id: 'rel-caio', name: 'Caio', role: 'family', evidence: { messageId, quote: profile } }],
      referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null,
    }));
    const readState = async () => (await db.query<{ lead_state: LeadState }>('SELECT lead_state FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3', [user.tenantId, user.brandId, created.value.candidateId])).rows[0].lead_state;
    const readFacts = () => db.query<{ id: string; data: LeadState['facts'][number]; updated_at: Date }>('SELECT id,data,updated_at FROM sdr.facts WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3 ORDER BY id', [user.tenantId, user.brandId, created.value.candidateId]);
    const before = await readState(), originalRows = (await readFacts()).rows;
    assert.equal(before.facts.length, 4); assert.equal(before.relations.length, 1);
    assert.ok(before.facts.every(fact => fact.status === 'declared' && fact.confirmedBy === null));
    const previousCity = before.facts.find(fact => fact.field === 'city'); assert.ok(previousCity);
    const correction = 'Corrigindo: a cidade é Vila Horizonte, não Vila Aurora. Antes de avançar, quem vai administrar a loja e quem participa da decisão?';
    const independentAnswer = 'Você, Marina, administra a loja, e Caio participa da decisão.';
    const completed = await completeTurn(correction, messageId => ({
      bubbles: ['Atualizei a cidade. ' + independentAnswer, 'Em quanto tempo pretende abrir?'],
      proposals: [{ field: 'city', value: { kind: 'text', text: 'Vila Horizonte' }, evidence: { messageId, quote: correction }, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: previousCity.id }],
      relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null,
    }));
    const after = await readState(), afterRows = (await readFacts()).rows;
    assert.equal(after.facts.length, 5);
    assert.deepEqual(after.facts.filter(fact => before.facts.some(original => original.id === fact.id)), before.facts);
    assert.deepEqual(afterRows.filter(row => originalRows.some(original => original.id === row.id)), originalRows, 'original declarations and projection timestamps remain unchanged');
    assert.deepEqual(after.relations, before.relations);
    const relations = await db.query<{ data: LeadState['relations'][number] }>('SELECT data FROM sdr.relations WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3', [user.tenantId, user.brandId, created.value.candidateId]);
    assert.deepEqual(relations.rows.map(row => row.data), after.relations);
    const newCity = after.facts.find(fact => fact.id !== previousCity.id && fact.field === 'city'); assert.ok(newCity);
    assert.equal(newCity.status, 'conflict'); assert.equal(newCity.confirmedBy, null); assert.equal(newCity.replacesFactId, previousCity.id);
    assert.deepEqual(newCity.evidence, { messageId: completed.job.trigger_message_id, quote: correction });
    const visible = await sessions.detail(user, created.value.id); assert.ok(visible.ok);
    assert.equal(visible.value.session.state, 'automatic');
    const replies = visible.value.messages.filter(message => message.actor === 'agent').slice(-2);
    assert.match(String(replies[0].text), /registrada para revisão/);
    assert.ok(String(replies[0].text).includes(independentAnswer), 'the factual operating/decision answer must survive in the first bubble');
    assert.doesNotMatch(String(replies[0].text), /Atualizei a cidade/);
    assert.equal(replies[1].text, completed.callback.result.bubbles[1]);
    const persisted = (await db.query<{ result: AgentDecision; state: string; error_code: string | null }>('SELECT result,state,error_code FROM sdr.jobs WHERE id=$1', [completed.job.id])).rows[0];
    assert.equal(persisted.state, 'completed'); assert.equal(persisted.error_code, null);
    assert.deepEqual(persisted.result.bubbles, replies.map(reply => reply.text));
    assert.equal(persisted.result.nextAction, 'continue');
    assert.deepEqual((await engine.complete(completed.callback)), { accepted: false, reason: 'STALE_RESULT' });
    assert.deepEqual(await readState(), after); assert.deepEqual((await readFacts()).rows, afterRows);
    assert.deepEqual(await sessions.detail(user, created.value.id), visible, 'replay neither duplicates messages nor changes the public snapshot');
    assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length, 0);
    assert.deepEqual(providerCalls, [testConfig.N8N_WEBHOOK_URL, testConfig.N8N_WEBHOOK_URL], 'only the injected fake provider is called, once per turn');
  } finally { await db.close(); }
});

test('a future-use promise is removed before persistence while conflict, roles and replay remain intact', async () => {
  const db = await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Fictional tester' }] });
    const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
    const created = await sessions.create(user, { requestId: randomUUID(), label: 'M2 memória fictícia', scenario: 'correction' });
    assert.ok(created.ok);
    const providerCalls: string[] = [];
    const engine = new Engine(store, testConfig, async url => { providerCalls.push(String(url)); return Response.json({ accepted: true }); });
    const completeTurn = async (text: string, decision: (messageId: string) => AgentDecision) => {
      const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text });
      assert.ok(sent.ok); assert.ok(sent.value.jobId);
      const channel = await store.scopeForJob(sent.value.jobId);
      const job = await store.claim(channel); assert.ok(job); assert.equal(job.id, sent.value.jobId);
      await engine.dispatch(channel, job);
      const callback = { jobId: job.id, contextVersion: job.context_version, result: decision(job.trigger_message_id) };
      const original = structuredClone(callback);
      assert.equal((await engine.complete(callback)).accepted, true);
      assert.deepEqual(callback, original, 'the raw callback must not be mutated by reply repair');
      return { job, callback };
    };
    const profile = 'Sou Marina, de Vila Aurora. Eu administro a loja e meu irmão Caio participa da decisão.';
    await completeTurn(profile, messageId => ({
      bubbles: ['Entendi, Marina. Em quanto tempo pensa em abrir?'],
      proposals: ([['name', 'Marina'], ['city', 'Vila Aurora'], ['operating_role', 'A candidata administra a loja'], ['decision_role', 'Caio participa da decisão']] as const).map(([field, text]) => ({ field, value: { kind: 'text', text }, evidence: { messageId, quote: profile }, attribution: 'candidate', capitalOrigin: null, relationId: field === 'decision_role' ? 'rel-caio' : null, replacesFactId: null })),
      relations: [{ id: 'rel-caio', name: 'Caio', role: 'family', evidence: { messageId, quote: profile } }],
      referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null,
    }));
    const readState = async () => (await db.query<{ lead_state: LeadState }>('SELECT lead_state FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3', [user.tenantId, user.brandId, created.value.candidateId])).rows[0].lead_state;
    const readFacts = async () => (await db.query<{ id: string; data: LeadState['facts'][number]; updated_at: Date }>('SELECT id,data,updated_at FROM sdr.facts WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3 ORDER BY id', [user.tenantId, user.brandId, created.value.candidateId])).rows;
    const before = await readState(), originalRows = await readFacts();
    const previousCity = before.facts.find(fact => fact.field === 'city'); assert.ok(previousCity);
    const correction = 'Corrigindo: a cidade é Vila Horizonte, não Vila Aurora. Quem administra e quem decide?';
    const notice = 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.';
    const answer = 'Você, Marina, administra a loja e seu irmão Caio participa da decisão.';
    const completed = await completeTurn(correction, messageId => ({
      bubbles: [notice + '\n\nPerfeito, obrigada pela correção: vou considerar Vila Horizonte.', answer],
      proposals: [{ field: 'city', value: { kind: 'text', text: 'Vila Horizonte' }, evidence: { messageId, quote: correction }, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: previousCity.id }],
      relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null,
    }));
    const after = await readState(), rowsAfter = await readFacts();
    assert.equal(after.facts.length, 5);
    assert.deepEqual(after.facts.filter(fact => before.facts.some(original => original.id === fact.id)), before.facts);
    assert.deepEqual(rowsAfter.filter(row => originalRows.some(original => original.id === row.id)), originalRows);
    assert.deepEqual(after.relations, before.relations);
    const city = after.facts.find(fact => fact.field === 'city' && fact.id !== previousCity.id); assert.ok(city);
    assert.equal(city.status, 'conflict'); assert.equal(city.confirmedBy, null); assert.equal(city.replacesFactId, previousCity.id);
    assert.deepEqual(city.evidence, { messageId: completed.job.trigger_message_id, quote: correction });
    const visible = await sessions.detail(user, created.value.id); assert.ok(visible.ok);
    assert.equal(visible.value.session.state, 'automatic');
    const replies = visible.value.messages.filter(message => message.actor === 'agent').slice(-2);
    assert.deepEqual(replies.map(message => message.text), [notice, answer]);
    const persisted = (await db.query<{ result: AgentDecision; state: string; error_code: string | null }>('SELECT result,state,error_code FROM sdr.jobs WHERE id=$1', [completed.job.id])).rows[0];
    assert.equal(persisted.state, 'completed'); assert.equal(persisted.error_code, null);
    assert.deepEqual(persisted.result.bubbles, [notice, answer]);
    assert.deepEqual(persisted.result.proposals, completed.callback.result.proposals);
    assert.deepEqual(await engine.complete(completed.callback), { accepted: false, reason: 'STALE_RESULT' });
    assert.deepEqual(await readState(), after); assert.deepEqual(await readFacts(), rowsAfter);
    assert.deepEqual(await sessions.detail(user, created.value.id), visible);
    assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length, 0);
    assert.deepEqual(providerCalls, [testConfig.N8N_WEBHOOK_URL, testConfig.N8N_WEBHOOK_URL], 'only the injected fake provider ran, once per turn');
  } finally { await db.close(); }
});
