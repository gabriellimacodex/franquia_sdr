import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './db-helper.js';
import { initialSnapshot, seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Engine } from '../src/engine.js';
import { LaboratoryDispatch } from '../src/laboratory-dispatch.js';
import { testConfig } from './config.js';
import type { Database, Queryable } from '../src/database.js';
import { Versioning } from '../src/versioning.js';
import { FINANCIAL_OUTPUT_JSON_SCHEMA } from '../src/financial-reply.js';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

async function fixture(tenantId = 'cognita-homologacao', database?: Database) {
  const db = database ?? await testDatabase(), store = new Store(db), sessions = new LabSessions(db);
  await seedPilot(db, { tenantId, testers: [{ contactId: '5511999999999', label: 'Offline' }], adminUserIds: ['offline-admin'] });
  const user = { tenantId, brandId: 'sapore', userId: 'offline-admin', role: 'admin' };
  async function nextJob(text = 'Quero conhecer a franquia em Vila Aurora.') {
    const session = await sessions.create(user, { requestId: randomUUID(), label: 'Preparação fictícia', scenario: 'free' }); assert.ok(session.ok);
    const sent = await sessions.send(user, session.value.id, { requestId: randomUUID(), text }); assert.ok(sent.ok); assert.ok(sent.value.jobId);
    const channel = await store.scopeForJob(sent.value.jobId), job = await store.claim(channel); assert.ok(job);
    return { channel, job, session: session.value, input: { jobId: job.id, attempt: job.attempts, contextVersion: job.context_version, epoch: job.epoch, versionId: job.version_id } };
  }
  return { db, store, sessions, user, nextJob };
}
function counted(db: Database) {
  const commands: string[] = [];
  const wrapper: Database = { query: db.query.bind(db), close: db.close.bind(db), async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
    commands.push('BEGIN');
    try {
      const result = await db.transaction(tx => fn({ query: async <R>(sql: string, params?: unknown[]) => {
        commands.push(sql); return tx.query<R>(sql, params);
      } }));
      commands.push('COMMIT'); return result;
    } catch (error) { commands.push('ROLLBACK'); throw error; }
  } };
  return { db: wrapper, commands };
}

test('one scoped transaction commits the legacy-identical canonical body and its exact UTF-8 reservation', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob('Quero conhecer a franquia — ação 🍧.');
    const expected = await new Engine(f.store, testConfig, async () => { throw new Error('no network'); }).prepare(channel, job);
    const measured = counted(f.db);
    const result = await new LaboratoryDispatch(measured.db, channel, testConfig).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'ready');
    if (result.data.kind !== 'ready') return;
    assert.deepEqual(JSON.parse(result.data.body), expected);
    assert.equal(result.data.inputTokenBound, Buffer.byteLength(result.data.body, 'utf8') + 4096);
    assert.equal(result.data.reservedMicroUsd, Math.ceil(result.data.inputTokenBound * 2.5 + 1200 * 15));
    assert.equal(measured.commands.length, 9);
    assert.equal(measured.commands.filter(sql => sql === 'BEGIN').length, 1);
    assert.equal(measured.commands.at(-1), 'COMMIT');
    const reservation = (await f.db.query<{ detail: Record<string, unknown> }>('SELECT detail FROM sdr.events WHERE id=$1', [result.data.reservationId])).rows[0];
    assert.deepEqual(reservation.detail, { gateId: testConfig.LAB_BUDGET_GATE_ID, jobId: job.id, attempt: job.attempts,
      inputTokenBound: result.data.inputTokenBound, reservedMicroUsd: result.data.reservedMicroUsd, costMicroUsd: result.data.reservedMicroUsd, settled: false });
    const stored = (await f.db.query<{ context: Record<string, unknown>; state: string }>('SELECT context,state FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    const { backendTimings: _privateTimings, ...storedContext } = stored.context;
    assert.deepEqual(storedContext, expected.context); assert.equal(stored.state, 'working');
    assert.equal(result.data.body.includes('backendTimings'), false);
  } finally { await f.db.close(); }
});

test('a stale claimed reference is ignored before business decoding and creates no reservation or context', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    for (const stale of [{ ...input, attempt: input.attempt + 1 }, { ...input, contextVersion: input.contextVersion + 1 },
      { ...input, epoch: input.epoch + 1 }, { ...input, versionId: 'another-version' }]) {
      const result = await new LaboratoryDispatch(f.db, channel, testConfig).execute(stale);
      assert.deepEqual(result, { success: true, data: { kind: 'ignored', reason: 'STALE_JOB' } });
    }
    for (const statement of ["UPDATE sdr.conversations SET state='human'", 'UPDATE sdr.conversations SET epoch=epoch+1',
      'UPDATE sdr.candidates SET revision=revision+1', "UPDATE sdr.jobs SET state='running'", 'UPDATE sdr.jobs SET deadline=to_timestamp(0)']) {
      await f.db.transaction(async tx => {
        await tx.query('SAVEPOINT boundary'); await tx.query(statement);
        const txDb: Database = { ...f.db, transaction: fn => fn(tx) };
        assert.deepEqual(await new LaboratoryDispatch(txDb, channel, testConfig).execute(input),
          { success: true, data: { kind: 'ignored', reason: 'STALE_JOB' } });
        await tx.query('ROLLBACK TO SAVEPOINT boundary');
      });
    }
    const stored = (await f.db.query<{ context: unknown }>('SELECT context FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(stored.context, null);
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await f.db.close(); }
});

test('repeated preparation of the same attempt returns no body and preserves the original context/reservation', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    const service = new LaboratoryDispatch(f.db, channel, testConfig);
    const first = await service.execute(input); assert.ok(first.success); assert.equal(first.data.kind, 'ready');
    const before = (await f.db.query('SELECT context FROM sdr.jobs WHERE id=$1', [job.id])).rows;
    const again = await service.execute(input);
    assert.deepEqual(again, { success: true, data: { kind: 'ignored', reason: 'ALREADY_RESERVED' } });
    assert.deepEqual((await f.db.query('SELECT context FROM sdr.jobs WHERE id=$1', [job.id])).rows, before);
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 1);
  } finally { await f.db.close(); }
});

test('missing budget configuration commits the same single human pause as the legacy path without reserving', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    const result = await new LaboratoryDispatch(f.db, channel, { ...testConfig, LAB_BUDGET_GATE_ID: undefined, LAB_BUDGET_LIMIT_MICRO_USD: undefined }).execute(input);
    assert.deepEqual(result, { success: true, data: { kind: 'paused', reason: 'LAB_BUDGET_NOT_CONFIGURED' } });
    const terminal = (await f.db.query<{ state: string; error_code: string; result: { bubbles: string[]; nextAction: string } }>('SELECT state,error_code,result FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(terminal.state, 'handoff'); assert.equal(terminal.error_code, 'LAB_BUDGET_NOT_CONFIGURED');
    assert.equal(terminal.result.nextAction, 'handoff');
    const conversation = (await f.db.query<{ state: string; epoch: number }>('SELECT state,epoch FROM sdr.conversations WHERE id=$1', [job.conversation_id])).rows[0];
    assert.deepEqual(conversation, { state: 'human', epoch: job.epoch + 1 });
    const lead = (await f.db.query<{ status: string }>("SELECT lead_state->>'status' AS status FROM sdr.candidates WHERE id=$1", [job.candidate_id])).rows[0];
    assert.equal(lead.status, 'handoff');
    const replies = (await f.db.query<{ text: string }>("SELECT text FROM sdr.messages WHERE conversation_id=$1 AND actor='agent'", [job.conversation_id])).rows;
    assert.deepEqual(replies.map(reply => reply.text), terminal.result.bubbles);
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM sdr.briefings')).rows.length, 0);
    assert.equal((await f.db.query('SELECT * FROM sdr.deliveries')).rows.length, 0);
  } finally { await f.db.close(); }
});

test('concurrent distinct jobs share the finite ledger balance and cannot authorize overspending', async () => {
  const f = await fixture();
  try {
    const first = await f.nextJob(), second = await f.nextJob();
    const payload = await new Engine(f.store, testConfig).prepare(first.channel, first.job);
    const reserve = Math.ceil((Buffer.byteLength(JSON.stringify(payload), 'utf8') + 4096) * 2.5 + 18000);
    const config = { ...testConfig, LAB_BUDGET_LIMIT_MICRO_USD: Math.floor(reserve * 1.5) };
    const results = await Promise.all([first, second].map(item => new LaboratoryDispatch(f.db, item.channel, config).execute(item.input)));
    assert.equal(results.filter(result => result.success && result.data.kind === 'ready').length, 1);
    assert.equal(results.filter(result => result.success && result.data.kind === 'paused' && result.data.reason === 'LAB_BUDGET_EXHAUSTED').length, 1);
    const events = (await f.db.query<{ cost: string }>("SELECT detail->>'costMicroUsd' AS cost FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
    assert.equal(events.length, 1); assert.ok(Number(events[0].cost) <= config.LAB_BUDGET_LIMIT_MICRO_USD);
  } finally { await f.db.close(); }
});

test('the pilot gate cannot be reused by another tenant', async () => {
  const f = await fixture('other-tenant');
  try {
    const { channel, input } = await f.nextJob();
    const result = await new LaboratoryDispatch(f.db, channel, testConfig).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'paused');
    assert.deepEqual(result.data, { kind: 'paused', reason: 'LAB_BUDGET_SCOPE_MISMATCH' });
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await f.db.close(); }
});

test('an oversized canonical payload pauses without entering the larger-context price tier', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    await f.db.query('UPDATE sdr.messages SET text=repeat($2,272000) WHERE id=$1', [job.trigger_message_id, 'x']);
    const result = await new LaboratoryDispatch(f.db, channel, testConfig).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'paused');
    assert.deepEqual(result.data, { kind: 'paused', reason: 'LAB_BUDGET_INPUT_TOO_LARGE' });
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await f.db.close(); }
});

test('untranscribed laboratory audio is answered locally before snapshot decoding, retrieval or budget', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    await f.db.query("UPDATE sdr.messages SET type='audio',text='',media_id='offline' WHERE id=$1", [job.trigger_message_id]);
    const measured = counted(f.db);
    const result = await new LaboratoryDispatch(measured.db, channel, { ...testConfig, LAB_BUDGET_GATE_ID: undefined }).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'capability');
    assert.deepEqual(result.data, { kind: 'capability', reason: 'AUDIO_REQUIRES_TEXT' });
    assert.equal(measured.commands.length, 6);
    assert.equal(measured.commands.some(sql => sql.includes('knowledge_chunks')), false);
    const terminal = (await f.db.query<{ state: string; context: unknown; result: { bubbles: string[] } }>('SELECT state,context,result FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    assert.equal(terminal.state, 'completed'); assert.equal(terminal.context, null);
    assert.deepEqual(terminal.result.bubbles, ['Nesta etapa do laboratório, envie sua mensagem por texto.']);
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
    const reply = (await f.db.query<{ text: string }>("SELECT text FROM sdr.messages WHERE id=$1", [job.id + ':capability'])).rows[0];
    assert.equal(reply.text, terminal.result.bubbles[0]);
  } finally { await f.db.close(); }
});

test('an unsupported direct trigger outside the 24-message context remains a free capability response', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    await f.db.query("UPDATE sdr.messages SET type='unsupported',provider_timestamp=now()-interval '1 hour' WHERE id=$1", [job.trigger_message_id]);
    await f.db.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp)
      SELECT 'offline-context-'||n,$1,$2,$3,$4,'agent','text','Fictício',now() FROM generate_series(1,25) n`,
      [channel.tenantId, channel.brandId, job.conversation_id, job.candidate_id]);
    const result = await new LaboratoryDispatch(f.db, channel, testConfig).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'capability');
    assert.deepEqual(result.data, { kind: 'capability', reason: 'UNSUPPORTED_MESSAGE' });
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await f.db.close(); }
});

test('expiry after context preparation rolls back context and never commits a reservation or body', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob(); let now = new Date();
    const wrapped: Database = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      if (sql.startsWith('UPDATE sdr.jobs SET context=')) now = new Date(job.deadline);
      return result;
    } })) };
    const result = await new LaboratoryDispatch(wrapped, channel, testConfig, () => now).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'ignored');
    assert.deepEqual(result.data, { kind: 'ignored', reason: 'STALE_JOB' });
    assert.equal((await f.db.query<{ context: unknown }>('SELECT context FROM sdr.jobs WHERE id=$1', [job.id])).rows[0].context, null);
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await f.db.close(); }
});

test('the reservation statement itself checks the database wall clock and rolls back on expiry', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    const wrapped: Database = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ async query<T>(sql: string, params?: unknown[]) {
      if (sql.startsWith('INSERT INTO sdr.events')) await tx.query('UPDATE sdr.jobs SET deadline=to_timestamp(0) WHERE id=$1', [job.id]);
      return tx.query<T>(sql, params);
    } })) };
    const result = await new LaboratoryDispatch(wrapped, channel, testConfig).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'ignored');
    assert.equal((await f.db.query<{ context: unknown }>('SELECT context FROM sdr.jobs WHERE id=$1', [job.id])).rows[0].context, null);
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await f.db.close(); }
});

test('a ready result cannot escape the transaction commit barrier', async () => {
  const f = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    const { channel, input } = await f.nextJob();
    let reached!: () => void, settled = false;
    const atCommit = new Promise<void>(resolve => { reached = resolve; });
    const wrapped: Database = { ...f.db, transaction: fn => f.db.transaction(async tx => {
      const value = await fn(tx); reached(); await barrier; return value;
    }) };
    const pending = new LaboratoryDispatch(wrapped, channel, testConfig).execute(input).then(result => { settled = true; return result; });
    await atCommit; await Promise.resolve();
    assert.equal(settled, false, 'no body/permission before COMMIT');
    release();
    const result = await pending; assert.ok(result.success); assert.equal(result.data.kind, 'ready');
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 1);
  } finally { release(); await f.db.close(); }
});

test('failures after context, reservation, pause, capability or before commit roll back the complete local operation', async () => {
  for (const fault of ['context', 'reservation', 'pause', 'capability', 'commit']) {
    const f = await fixture();
    try {
      const { channel, job, input } = await f.nextJob();
      if (fault === 'capability') await f.db.query("UPDATE sdr.messages SET type='audio',text='' WHERE id=$1", [job.trigger_message_id]);
      const wrapped: Database = { ...f.db, transaction: fn => f.db.transaction(async tx => {
        const value = await fn({ async query<T>(sql: string, params?: unknown[]) {
          const result = await tx.query<T>(sql, params);
          if ((fault === 'context' && sql.startsWith('UPDATE sdr.jobs SET context='))
            || (fault === 'reservation' && sql.startsWith('INSERT INTO sdr.events'))
            || (fault === 'pause' && sql.startsWith('UPDATE sdr.candidates'))
            || (fault === 'capability' && sql.startsWith('INSERT INTO sdr.messages'))) throw new Error('synthetic secret must be redacted');
          return result;
        } });
        if (fault === 'commit') throw new Error('synthetic commit failure');
        return value;
      }) };
      const config = fault === 'pause' ? { ...testConfig, LAB_BUDGET_GATE_ID: undefined } : testConfig;
      assert.deepEqual(await new LaboratoryDispatch(wrapped, channel, config).execute(input),
        { success: false, error: { code: 'DISPATCH_PREPARATION_FAILED' } });
      assert.deepEqual((await f.db.query('SELECT state,context FROM sdr.jobs WHERE id=$1', [job.id])).rows, [{ state: 'working', context: null }]);
      assert.deepEqual((await f.db.query('SELECT state,epoch FROM sdr.conversations WHERE id=$1', [job.conversation_id])).rows, [{ state: 'automatic', epoch: job.epoch }]);
      assert.equal((await f.db.query("SELECT id FROM sdr.messages WHERE actor='agent'")).rows.length, 0);
      assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
    } finally { await f.db.close(); }
  }
});

test('an unpublished financial-v2 draft retains its exact pinned payload/schema/hash without changing the active version', async () => {
  const pg = new PGlite({ extensions: { vector } });
  for (const file of ['001_sdr.sql', '002_versions.sql', '003_lab_sessions.sql']) {
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const f = await fixture('cognita-homologacao', { query: (sql, params) => pg.query(sql, params),
    transaction: fn => pg.transaction(tx => fn(tx as Queryable)), close: () => pg.close() });
  try {
    const before = (await f.db.query('SELECT * FROM sdr.active_versions')).rows;
    const snapshot = { ...initialSnapshot({ tenantId: f.user.tenantId, brandId: f.user.brandId }), outputContract: 'financial-v2' as const };
    const draft = await new Versioning(f.db).saveDraft(f.user, snapshot, f.user.userId); assert.ok(draft.ok);
    const session = await f.sessions.createEvaluation(f.user, { requestId: randomUUID(), label: 'V2 offline', scenario: 'investment',
      versionId: draft.value.versionId, contentHash: draft.value.contentHash }); assert.ok(session.ok);
    const sent = await f.sessions.send(f.user, session.value.id, { requestId: randomUUID(), text: 'Tenho R$ 260 mil próprios disponíveis.' });
    assert.ok(sent.ok); assert.ok(sent.value.jobId);
    const channel = await f.store.scopeForJob(sent.value.jobId), job = await f.store.claim(channel); assert.ok(job);
    const expected = await new Engine(f.store, testConfig).prepare(channel, job);
    const result = await new LaboratoryDispatch(f.db, channel, testConfig).execute({ jobId: job.id, attempt: job.attempts,
      contextVersion: job.context_version, epoch: job.epoch, versionId: job.version_id });
    assert.ok(result.success); assert.equal(result.data.kind, 'ready'); if (result.data.kind !== 'ready') return;
    const body = JSON.parse(result.data.body);
    assert.deepEqual(body, expected); assert.deepEqual(body.outputSchema, FINANCIAL_OUTPUT_JSON_SCHEMA);
    assert.equal(body.configVersion, draft.value.versionId); assert.equal(result.data.contentHash, draft.value.contentHash);
    assert.deepEqual((await f.db.query('SELECT * FROM sdr.active_versions')).rows, before);
    assert.equal((await f.db.query('SELECT * FROM sdr.validation_runs')).rows.length, 0);
  } finally { await f.db.close(); }
});

test('monotonic preparation timing is private, partial and separate from the validity clock', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob(); let tick = 100;
    const result = await new LaboratoryDispatch(f.db, channel, testConfig, () => new Date(), () => { const value = tick; tick += 20.4; return value; }).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'ready'); if (result.data.kind !== 'ready') return;
    const stored = (await f.db.query<{ context: Record<string, unknown> }>('SELECT context FROM sdr.jobs WHERE id=$1', [job.id])).rows[0];
    assert.deepEqual(stored.context.backendTimings, { attempt: job.attempts, dispatchPreparationUntilContextWriteMs: 20 });
    assert.equal(result.data.body.includes('backendTimings'), false);
    assert.equal(result.data.body.includes('dispatchPreparationUntilContextWriteMs'), false);
  } finally { await f.db.close(); }
});

test('the private input rejects overrides/WhatsApp without I/O and cannot read another scope or channel', async () => {
  const f = await fixture();
  try {
    const { channel, input } = await f.nextJob(), measured = counted(f.db);
    assert.deepEqual(await new LaboratoryDispatch(measured.db, channel, testConfig).execute({ ...input, context: { injected: true } }),
      { success: false, error: { code: 'INVALID_INPUT' } });
    assert.deepEqual(await new LaboratoryDispatch(measured.db, { ...channel, kind: 'whatsapp' }, testConfig).execute(input),
      { success: false, error: { code: 'NOT_LABORATORY' } });
    assert.equal(measured.commands.length, 0);
    for (const scope of [{ ...channel, tenantId: 'foreign' }, { ...channel, brandId: 'foreign' }]) {
      assert.deepEqual(await new LaboratoryDispatch(f.db, scope, testConfig).execute(input),
        { success: false, error: { code: 'JOB_NOT_FOUND' } });
    }
    const wrongChannel = await new LaboratoryDispatch(f.db, { ...channel, phoneNumberId: '1052683654599692' }, testConfig).execute(input);
    assert.deepEqual(wrongChannel, { success: false, error: { code: 'INCONSISTENT_SNAPSHOT' } });
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  } finally { await f.db.close(); }
});

test('corrupt snapshot/hash/model/evidence ownership fails closed while stale and audio paths precede business decoding', async () => {
  const f = await fixture();
  try {
    const { channel, input } = await f.nextJob();
    const execute = (poison: (row: any) => any) => {
      const wrapped: Database = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        return sql.startsWith('WITH locked_job') ? { rows: result.rows.map(poison) as T[] } : result;
      } })) };
      return new LaboratoryDispatch(wrapped, channel, testConfig).execute(input);
    };
    const badRows = [
      (row: any) => ({ ...row, version: { ...row.version, content_hash: '0'.repeat(64) } }),
      (row: any) => ({ ...row, version: { ...row.version, model: 'unapproved-model' } }),
      (row: any) => ({ ...row, candidate: { ...row.candidate, lead_state: { ...row.candidate.lead_state, tenantId: 'foreign' } } }),
      (row: any) => ({ ...row, trigger: { ...row.trigger, candidate_id: 'foreign' } }),
      (row: any) => ({ ...row, conversation: { ...row.conversation, candidate_id: 'foreign' } }),
    ];
    for (const poison of badRows) assert.deepEqual(await execute(poison), { success: false, error: { code: 'INCONSISTENT_SNAPSHOT' } });
    assert.deepEqual(await execute(row => ({ ...row, job: { ...row.job, state: 'stale' }, version: null, messages: null,
      candidate: { ...row.candidate, lead_state: null } })), { success: true, data: { kind: 'ignored', reason: 'STALE_JOB' } });
    assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
    assert.deepEqual(await execute(row => ({ ...row, has_audio: true, version: null, messages: null,
      candidate: { ...row.candidate, lead_state: null } })), { success: true, data: { kind: 'capability', reason: 'AUDIO_REQUIRES_TEXT' } });
  } finally { await f.db.close(); }
});

test('candidate-wide history retains roles/timestamps but audio fallback uses only the current conversation last 24 candidate messages', async () => {
  const f = await fixture();
  try {
    const { channel, job, input } = await f.nextJob();
    const s = [channel.tenantId, channel.brandId], otherConversation = randomUUID();
    await f.db.query('INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) VALUES($3,$1,$2,$4,$5)',
      [...s, otherConversation, job.candidate_id, channel.phoneNumberId]);
    await f.db.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp)
      SELECT 'window-'||n,$1,$2,$3,$4,'candidate','text','Texto '||n,now()-(30-n)*interval '1 second' FROM generate_series(1,25) n`,
      [...s, job.conversation_id, job.candidate_id]);
    for (const [id, conversation, actor, type, text, seconds] of [
      ['old-audio', job.conversation_id, 'candidate', 'audio', '', 3600],
      ['operator-audio', job.conversation_id, 'human', 'audio', '', 1],
      ['other-conversation-audio', otherConversation, 'candidate', 'audio', '', 2],
      ['transcribed-audio', job.conversation_id, 'candidate', 'audio', 'Transcrição fictícia', 3],
    ] as const) {
      await f.db.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp)
        VALUES($3,$1,$2,$4,$5,$6,$7,$8,now()-$9::int*interval '1 second')`, [...s, id, conversation, job.candidate_id, actor, type, text, seconds]);
    }
    await f.nextJob('Texto de outra candidata que não deve entrar no contexto.');
    const expected = await new Engine(f.store, testConfig).prepare(channel, job);
    const result = await new LaboratoryDispatch(f.db, channel, testConfig).execute(input);
    assert.ok(result.success); assert.equal(result.data.kind, 'ready'); if (result.data.kind !== 'ready') return;
    const body = JSON.parse(result.data.body);
    assert.deepEqual(body, expected);
    assert.equal(body.context.messages.length, 24);
    const operator = body.context.messages.find((m: { id: string }) => m.id === 'operator-audio');
    assert.ok(operator); assert.equal(operator.role, 'operator');
    assert.ok(body.context.messages.some((m: { id: string }) => m.id === 'other-conversation-audio'));
    assert.ok(body.context.messages.some((m: { id: string }) => m.id === 'transcribed-audio'));
    assert.equal(result.data.body.includes('old-audio'), false);
    assert.equal(result.data.body.includes('Texto de outra candidata'), false);
  } finally { await f.db.close(); }
});
