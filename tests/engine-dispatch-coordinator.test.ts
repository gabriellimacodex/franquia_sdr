import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { seedPilot } from '../src/seed.js';
import type { Database } from '../src/database.js';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';

async function fixture() {
  const actual = await testDatabase();
  try {
    await seedPilot(actual, { testers: [{ contactId: '5511999999999', label: 'Synthetic' }] });
    const store = new Store(actual), sessions = new LabSessions(actual);
    const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'dispatch-tester', role: 'tester' };
    const created = await sessions.create(user, { requestId: randomUUID(), label: 'Synthetic dispatch', scenario: 'free' }); assert.ok(created.ok);
    const sent = await sessions.send(user, created.value.id, { requestId: randomUUID(), text: 'Quero abrir uma franquia em Vila Aurora.' }); assert.ok(sent.ok); assert.ok(sent.value.jobId);
    const channel = await store.scopeForJob(sent.value.jobId), job = await store.claim(channel); assert.ok(job);
    return { actual, store, sessions, user, channel, job };
  } catch (error) { await actual.close(); throw error; }
}

test('laboratory dispatch sends the exact reserved body only after the fused preparation commits, keeping ACK separate', async () => {
  const { actual, store, channel, job } = await fixture();
  try {
    const expected = await new Engine(store, testConfig).prepare(channel, job);
    let transactions = 0, queries = 0, activeTransactions = 0, commits = 0, calls = 0;
    const db: Database = { ...actual, transaction: async fn => {
      transactions++; activeTransactions++;
      try {
        const result = await actual.transaction(tx => fn({ query: async <T>(sql: string, params?: unknown[]) => { queries++; return tx.query<T>(sql, params); } }));
        commits++; return result;
      } finally { activeTransactions--; }
    } };
    const transport: typeof fetch = async (url, request) => {
      calls++;
      assert.equal(url, testConfig.N8N_WEBHOOK_URL);
      assert.equal(activeTransactions, 0, 'No HTTP request under a database transaction/lock');
      assert.ok(commits > 0, 'Committed preparation is required before transport');
      const body = String(request?.body);
      assert.deepEqual(JSON.parse(body), expected);
      assert.equal(body.includes('backendTimings'), false);
      const rows = (await actual.query<{ detail: { inputTokenBound: number; settled: boolean } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].detail.inputTokenBound, Buffer.byteLength(body, 'utf8') + 4096);
      assert.equal(rows[0].detail.settled, false);
      assert.equal((await actual.query<{ state: string }>('SELECT state FROM sdr.jobs WHERE id=$1', [job.id])).rows[0].state, 'working');
      return Response.json({ accepted: true });
    };
    await new Engine(new Store(db), testConfig, transport).dispatch(channel, job);
    assert.equal(calls, 1);
    assert.equal(transactions, 2, 'One fused preparation transaction plus one conditional ACK transaction');
    assert.equal(queries + transactions * 2, 13, 'Thirteen exchanges include both BEGIN/COMMIT pairs');
    assert.equal((await actual.query<{ state: string }>('SELECT state FROM sdr.jobs WHERE id=$1', [job.id])).rows[0].state, 'running');
  } finally { await actual.close(); }
});

test('a callback before ACK preserves only the new partial timing, settles once and is not reopened', async () => {
  const { actual, store, channel, job } = await fixture();
  try {
    const engine: Engine = new Engine(store, testConfig, async (_url, request) => {
      assert.doesNotMatch(String(request?.body), /backendTimings|dispatchPreparation/);
      assert.deepEqual(await engine.complete({ jobId: job.id, contextVersion: job.context_version, configVersion: job.version_id,
        model: 'gpt-5.4-2026-03-05', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        result: { bubbles: ['Em qual prazo você pensa em começar?'], proposals: [], relations: [], referral: null,
          sourceRefs: [], nextAction: 'continue', handoffReason: null } }), { accepted: true });
      return Response.json({ accepted: true });
    });
    await engine.dispatch(channel, job);
    const events = (await actual.query<{ detail: { timings: { backend: Record<string, number> } } }>("SELECT detail FROM sdr.events WHERE type='turn_completed'")).rows;
    assert.equal(events.length, 1);
    const timings = events[0].detail.timings.backend;
    assert.ok(Number.isInteger(timings.dispatchPreparationUntilContextWriteMs));
    for (const key of ['dispatchPreparationMs', 'prepareUntilContextWriteMs', 'preflightMs', 'prepareMs', 'budgetReservationMs', 'n8nAckMs']) assert.equal(timings[key], undefined);
    assert.equal((await actual.query<{ state: string }>('SELECT state FROM sdr.jobs WHERE id=$1', [job.id])).rows[0].state, 'completed');
    const ledger = (await actual.query<{ detail: { settled: boolean; costMicroUsd: number } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
    assert.equal(ledger.length, 1); assert.equal(ledger[0].detail.settled, true); assert.equal(ledger[0].detail.costMicroUsd, 400);
    assert.equal((await actual.query("SELECT id FROM sdr.messages WHERE actor='agent'")).rows.length, 1);
  } finally { await actual.close(); }
});

test('a normal ACK records the complete fused preparation phase without inventing legacy sub-phase timings', async () => {
  const { actual, store, channel, job } = await fixture();
  try {
    let tick = 100;
    const engine = new Engine(store, testConfig, async () => Response.json({ accepted: true }), () => tick += 10);
    await engine.dispatch(channel, job);
    await engine.complete({ jobId: job.id, contextVersion: job.context_version,
      result: { bubbles: ['Em qual prazo você pensa em começar?'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null } });
    const event = (await actual.query<{ detail: { timings: { backend: Record<string, number> } } }>("SELECT detail FROM sdr.events WHERE type='turn_completed'")).rows[0];
    assert.ok(Number.isInteger(event.detail.timings.backend.dispatchPreparationMs));
    assert.ok(Number.isInteger(event.detail.timings.backend.n8nAckMs));
    for (const key of ['dispatchPreparationUntilContextWriteMs', 'preflightMs', 'prepareMs', 'budgetReservationMs']) assert.equal(event.detail.timings.backend[key], undefined);
  } finally { await actual.close(); }
});
