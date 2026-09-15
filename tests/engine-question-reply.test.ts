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
import type { Database } from '../src/database.js';

test('question repair commits one useful reply, preserves the model failure privately and settles only once', async () => {
  const db = await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  try {
    await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Fictional tester' }] });
    const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
    const session = await sessions.create(user, { requestId: randomUUID(), label: 'Pergunta fictícia', scenario: 'free' });
    assert.ok(session.ok);
    const sent = await sessions.send(user, session.value.id, { requestId: randomUUID(), text: 'To pensando em montar em Osaso' });
    assert.ok(sent.ok); assert.ok(sent.value.jobId);
    const channel = await store.scopeForJob(sent.value.jobId), job = await store.claim(channel); assert.ok(job);
    const providerCalls: string[] = [];
    const engine = new Engine(store, testConfig, async url => { providerCalls.push(String(url)); return Response.json({ accepted: true }); });
    await engine.dispatch(channel, job);
    const result: AgentDecision = { bubbles: ['Legal — você está pensando em Osasco, certo?', 'Pra eu te orientar melhor, a operação seria tocada por você no dia a dia ou com um gestor/parceiro?'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null };
    const callback = { jobId: job.id, contextVersion: job.context_version, configVersion: job.version_id, model: 'gpt-5.4-2026-03-05', result, usage: { input_tokens: 101, output_tokens: 10, total_tokens: 111 } };
    assert.deepEqual(await engine.complete(callback), { accepted: true });
    const detail = await sessions.detail(user, session.value.id); assert.ok(detail.ok);
    assert.equal(detail.value.session.state, 'automatic');
    assert.deepEqual(detail.value.messages.filter(message => message.actor === 'agent').map(message => message.text), [result.bubbles[0]]);
    assert.doesNotMatch(JSON.stringify(detail), /guardReview|guardViolations|deferred_operating_question|gestor\/parceiro/);
    const terminal = (await db.query<{ state: string; error_code: string | null; result: AgentDecision; context: { guardReview: unknown } }>('SELECT state,error_code,result,context FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(terminal.state, 'completed'); assert.equal(terminal.error_code, null);
    assert.deepEqual(terminal.result.bubbles, [result.bubbles[0]]);
    assert.deepEqual(terminal.context.guardReview, { violations: ['multiple_questions'], bubbles: result.bubbles, repairCode: 'deferred_operating_question' });
    const event = (await db.query<{ detail: Record<string, unknown> }>("SELECT detail FROM sdr.events WHERE type='turn_completed' AND detail->>'jobId'=$1", [job.id])).rows[0].detail;
    assert.equal(event.guardPassed, true); assert.equal(event.modelGuardPassed, false);
    assert.deepEqual(event.originalGuardViolations, ['multiple_questions']); assert.equal(event.replyRepair, 'deferred_operating_question');
    assert.doesNotMatch(JSON.stringify(event), /Osasco|gestor\/parceiro/);
    const state = (await db.query<{ lead_state: LeadState }>('SELECT lead_state FROM sdr.candidates WHERE id=$1', [session.value.candidateId])).rows[0].lead_state;
    assert.deepEqual(state.facts, []); assert.deepEqual(state.relations, []); assert.equal(state.referral, null);
    const reservations = async () => (await db.query<{ detail: { settled: boolean; costMicroUsd: number } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
    const reserved = await reservations(); assert.equal(reserved.length, 1); assert.equal(reserved[0].detail.settled, true); assert.equal(reserved[0].detail.costMicroUsd, 403);
    assert.deepEqual(await engine.complete(callback), { accepted: false, reason: 'STALE_RESULT' });
    assert.deepEqual(await sessions.detail(user, session.value.id), detail); assert.deepEqual(await reservations(), reserved);
    assert.equal((await db.query('SELECT * FROM sdr.deliveries')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM sdr.briefings')).rows.length, 0);
    assert.deepEqual(providerCalls, [testConfig.N8N_WEBHOOK_URL], 'one injected fake call only, no model repair call');
  } finally { await db.close(); }
});

async function pendingRepairFixture(failSettlement: () => boolean = () => false) {
  const actual = await testDatabase();
  const db: Database = { ...actual, transaction: fn => actual.transaction(tx => fn({
    query: async <T>(sql: string, params?: unknown[]) => {
      if (failSettlement() && sql.startsWith('UPDATE sdr.events SET detail=detail||')) throw new Error('Synthetic settlement failure');
      return tx.query<T>(sql, params);
    },
  })) };
  await seedPilot(actual, { testers: [{ contactId: '5511999999999', label: 'Fictional tester' }] });
  const store = new Store(db), sessions = new LabSessions(db);
  const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'tester', role: 'tester' };
  const session = await sessions.create(user, { requestId: randomUUID(), label: 'Pergunta isolada', scenario: 'free' }); assert.ok(session.ok);
  const sent = await sessions.send(user, session.value.id, { requestId: randomUUID(), text: 'To pensando em montar em Osaso' }); assert.ok(sent.ok); assert.ok(sent.value.jobId);
  const channel = await store.scopeForJob(sent.value.jobId), job = await store.claim(channel); assert.ok(job);
  let calls = 0;
  const engine = new Engine(store, testConfig, async () => { calls++; return Response.json({ accepted: true }); });
  await engine.dispatch(channel, job);
  const result: AgentDecision = { bubbles: ['Legal — você está pensando em Osasco, certo?', 'Pra eu te orientar melhor, a operação seria tocada por você no dia a dia ou com um gestor/parceiro?'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null };
  const callback = { jobId: job.id, contextVersion: job.context_version, configVersion: job.version_id, model: 'gpt-5.4-2026-03-05', result, usage: { input_tokens: 101, output_tokens: 10, total_tokens: 111 } };
  const reservation = async () => (await actual.query<{ detail: { settled: boolean; costMicroUsd: number } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0].detail;
  return { actual, sessions, user, sessionId: session.value.id, engine, job, callback, reservation, calls: () => calls };
}

test('a settlement failure rolls back the reply, repair audit, memory and terminal job together', async () => {
  let failing = true;
  const f = await pendingRepairFixture(() => failing);
  try {
    const before = await f.reservation(); assert.equal(before.settled, false);
    await assert.rejects(f.engine.complete(f.callback), /Synthetic settlement failure/);
    const detail = await f.sessions.detail(f.user, f.sessionId); assert.ok(detail.ok);
    assert.equal(detail.value.session.state, 'automatic');
    assert.equal(detail.value.messages.filter(message => message.actor === 'agent').length, 0);
    assert.deepEqual((await f.actual.query("SELECT state,result,context->'guardReview' AS review FROM sdr.jobs WHERE id=$1", [f.job.id])).rows,
      [{ state: 'running', result: null, review: null }]);
    assert.equal((await f.actual.query("SELECT id FROM sdr.events WHERE type='turn_completed'")).rows.length, 0);
    assert.equal((await f.actual.query('SELECT id FROM sdr.facts')).rows.length, 0);
    assert.deepEqual(await f.reservation(), before);
    failing = false;
    assert.deepEqual(await f.engine.complete(f.callback), { accepted: true });
    assert.equal((await f.reservation()).settled, true); assert.equal(f.calls(), 1);
    assert.equal((await f.actual.query("SELECT id FROM sdr.messages WHERE actor='agent'")).rows.length, 1);
  } finally { await f.actual.close(); }
});

test('stale revision, epoch, human ownership and deadline reject the callback before any repair or settlement', async () => {
  const mutations = [
    'UPDATE sdr.candidates SET revision=revision+1',
    'UPDATE sdr.conversations SET epoch=epoch+1',
    "UPDATE sdr.conversations SET state='human'",
    "UPDATE sdr.jobs SET deadline=now()-interval '1 second'",
  ];
  for (const mutation of mutations) {
    const f = await pendingRepairFixture();
    try {
      const before = await f.reservation();
      await f.actual.query(mutation); // Isolated in-memory fixture, never remote.
      assert.deepEqual(await f.engine.complete(f.callback), { accepted: false, reason: 'STALE_RESULT' });
      assert.deepEqual(await f.reservation(), before);
      assert.equal((await f.actual.query("SELECT id FROM sdr.messages WHERE actor='agent'")).rows.length, 0);
      assert.equal((await f.actual.query("SELECT id FROM sdr.events WHERE type='turn_completed'")).rows.length, 0);
      assert.deepEqual((await f.actual.query("SELECT context->'guardReview' AS review FROM sdr.jobs WHERE id=$1", [f.job.id])).rows, [{ review: null }]);
      assert.equal(f.calls(), 1);
    } finally { await f.actual.close(); }
  }
});
