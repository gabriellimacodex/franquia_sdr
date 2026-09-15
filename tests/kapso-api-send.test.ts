import test from 'node:test';
import assert from 'node:assert/strict';
import { Kapso } from '../src/kapso.js';

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
  const { setup, input } = await import('./turns.test.js');
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
