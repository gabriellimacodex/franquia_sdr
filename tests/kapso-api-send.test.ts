import test from 'node:test';
import assert from 'node:assert/strict';
import { Kapso } from '../src/kapso.js';
import { setup, input } from './turns-fixture.js';
import { createServer } from '../src/server.js';
import { testConfig } from './config.js';

test('Kapso.sendText posts Cloud API text and returns WAMID', async () => {
  const calls: { path: string; body?: string }[] = [];
  const kapso = new Kapso(
    { KAPSO_API_KEY: 'k'.repeat(32), KAPSO_WORKFLOW_ID: 'wf', NATIVE_CONTROL_VERIFIED: 'true' } as never,
    async (url, init) => {
      calls.push({ path: String(url).replace('https://api.kapso.ai', ''), body: String(init?.body || '') });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.TEST123' }] }), { status: 200 });
    },
  );
  const id = await kapso.sendText({ phoneNumberId: '1093705843816293', to: '5511999999999', text: 'Oi Sofia' });
  assert.equal(id, 'wamid.TEST123');
  assert.match(calls[0]!.path, /\/meta\/whatsapp\/v24\.0\/1093705843816293\/messages$/);
  assert.match(calls[0]!.body!, /"Oi Sofia"/);
});

test('confirmApiSend binds WAMID and marks job sent', async () => {
  const { db, store } = await setup();
  try {
    const turn = await store.startTurn(input('wamid-in-1', 'oi'));
    assert.equal(turn.state, 'pending');
    await db.query("UPDATE sdr.jobs SET state='ready', result=$2::jsonb WHERE id=$1", [turn.id, JSON.stringify({
      bubbles: ['Oi! Sou a Sofia.'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null,
    })]);
    const auth = await store.authorize(turn.id, 'execution-1', 'epoch-1');
    assert.equal(auth.authorized, true);
    const sent = await store.confirmApiSend(turn.id, 'wamid.OUTBOUND1');
    assert.equal(sent.state, 'sent');
    assert.deepEqual(sent.reply, []);
    const delivery = (await db.query<{ message_id: string; state: string }>('SELECT message_id, state FROM sdr.deliveries')).rows[0];
    assert.equal(delivery.message_id, 'wamid.OUTBOUND1');
    assert.equal(delivery.state, 'sent');
  } finally {
    await db.close();
  }
});

test('deliver sends one WhatsApp message per bubble and records every WAMID as an agent message', async () => {
  const { db, store } = await setup();
  const sends: string[] = []; let count = 0;
  const transport: typeof fetch = async (url, init) => {
    const path = String(url).replace('https://api.kapso.ai', '');
    if (path.startsWith('/platform/v1/whatsapp/contacts/')) return Response.json({ data: { wa_id: '5511999999999' } });
    if (path.endsWith('/messages') && init?.method === 'POST') { sends.push(JSON.parse(String(init.body)).text.body); count++; return Response.json({ messages: [{ id: 'wamid.OUT' + count }] }); }
    throw new Error('unexpected ' + path);
  };
  const app = await createServer(db, { ...testConfig, CHANNEL_ENABLED: 'true', NATIVE_CONTROL_VERIFIED: 'true' },
    { transport, native: async id => ({ id, conversationId: 'c1', workflowId: 'wf-test', status: 'running', controlFingerprint: 'epoch-1' }) });
  try {
    const turn = await store.startTurn(input('wamid-in-2', 'oi'));
    await db.query("UPDATE sdr.jobs SET state='ready', result=$2::jsonb WHERE id=$1", [turn.id, JSON.stringify({
      bubbles: ['Oi! Sou a Sofia.', 'Qual cidade você considera?'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null,
    })]);
    const response = await app.inject({ method: 'POST', url: `/internal/turns/${encodeURIComponent(turn.id)}/deliver`,
      headers: { Authorization: 'Bearer ' + testConfig.KAPSO_FUNCTION_TOKEN }, payload: { executionId: 'execution-1', controlFingerprint: 'epoch-1', contextVersion: turn.contextVersion } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, 'sent');
    assert.deepEqual(sends, ['Oi! Sou a Sofia.', 'Qual cidade você considera?']);
    assert.equal((await db.query<{ message_id: string }>('SELECT message_id FROM sdr.deliveries')).rows[0]?.message_id, 'wamid.OUT1');
    assert.deepEqual((await db.query<{ id: string }>("SELECT id FROM sdr.messages WHERE actor='agent' ORDER BY id")).rows.map(row => row.id), ['wamid.OUT1', 'wamid.OUT2']);
    // Provider history replays both outbound messages as unknown senders; neither may read as a human takeover.
    await store.startTurn({ ...input('wamid-in-3', 'São Paulo'), messages: [
      { id: 'wamid.OUT1', text: 'Oi! Sou a Sofia.', actor: 'human', type: 'text' },
      { id: 'wamid.OUT2', text: 'Qual cidade você considera?', actor: 'human', type: 'text' },
    ] });
    assert.equal((await db.query<{ state: string }>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'automatic');
  } finally { await app.close(); await db.close(); }
});
