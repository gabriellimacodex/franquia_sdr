import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './db-helper.js';
import { Store } from '../src/store.js';
import { ingestWebhook } from '../src/webhooks.js';

const phone = '1052683654599692';
const messageTime = String(Math.floor(Date.now() / 1000) - 5);
async function setup() {
  const db = await testDatabase();
  await db.query("INSERT INTO sdr.brands VALUES ('team','sapore','Sapore')");
  await db.query("INSERT INTO sdr.channels VALUES ('1052683654599692','team','sapore',false,'operator-test')");
  await db.query("INSERT INTO sdr.testers VALUES ('team','sapore','contact-1','Fictional tester',true)");
  return { db, store: new Store(db) };
}
function inbound(id = 'wamid-1', identity = '5511999990001') {
  return { phone_number_id: phone, conversation: { id: 'conversation-1', phone_number: identity, phone_number_id: phone },
    message: { id, timestamp: messageTime, from: identity, type: 'text', text: { body: 'Sou de Campinas' },
      kapso: { direction: 'inbound', status: 'received', origin: 'cloud_api' } } };
}
const options = { eventType: 'whatsapp.message.received',
  resolveContact: async (identity: string) => ({ id: identity === '5511999990001' ? 'contact-1' : 'not-approved', phone: identity }) };

test('image captions, documents and contact cards map to typed messages that keep their media ids', async () => {
  const { db, store } = await setup();
  try {
    const image = inbound('wamid-img'); image.message = { ...image.message, type: 'image', text: undefined, image: { id: 'media-img', caption: 'Fachada que estou olhando' } } as never;
    const doc = inbound('wamid-doc'); doc.message = { ...doc.message, type: 'document', text: undefined, document: { id: 'media-doc', filename: 'proposta.pdf' } } as never;
    const card = inbound('wamid-card'); card.message = { ...card.message, type: 'contacts', text: undefined, contacts: [{ name: { formatted_name: 'Marina Souza' }, phones: [{ wa_id: '5511988887777' }] }] } as never;
    for (const [index, item] of [image, doc, card].entries()) await ingestWebhook(store, item, 'media-' + index, Buffer.from(JSON.stringify(item)), options);
    const rows = (await db.query<{id:string,type:string,text:string,media_id:string|null}>('SELECT id,type,text,media_id FROM sdr.messages ORDER BY id')).rows;
    assert.deepEqual(rows, [
      { id: 'wamid-card', type: 'text', text: '[Cartão de contato] Nome: Marina Souza | Telefone: 5511988887777', media_id: null },
      { id: 'wamid-doc', type: 'document', text: '', media_id: 'media-doc' },
      { id: 'wamid-img', type: 'image', text: 'Fachada que estou olhando', media_id: 'media-img' },
    ]);
  } finally { await db.close(); }
});

test('signed v2 batches ingest canonical allowlisted identity exactly once without creating jobs', async () => {
  const { db, store } = await setup();
  try {
    const payload = { type: 'whatsapp.message.received', batch: true, data: [inbound('wamid-1'), inbound('wamid-2')] };
    const raw = Buffer.from(JSON.stringify(payload));
    await ingestWebhook(store, payload, 'batch-1', raw, options);
    await ingestWebhook(store, payload, 'batch-1', raw, options);
    await ingestWebhook(store, inbound('wamid-1'), 'fallback-1', Buffer.from(JSON.stringify(inbound('wamid-1'))), options);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length, 2);
    assert.equal((await db.query('SELECT * FROM sdr.jobs')).rows.length, 0);
    assert.equal((await db.query<{contact_id:string}>('SELECT contact_id FROM sdr.candidates')).rows[0]?.contact_id, 'contact-1');
    assert.equal((await db.query('SELECT * FROM sdr.webhook_receipts')).rows.length, 2);
  } finally { await db.close(); }
});

test('unapproved contacts retain no content; failures do not mark a webhook received', async () => {
  const { db, store } = await setup();
  try {
    const stranger = inbound('stranger-message', '5511888880001');
    await ingestWebhook(store, stranger, 'stranger', Buffer.from(JSON.stringify(stranger)), options);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM sdr.candidates')).rows.length, 0);
    const message = inbound();
    await assert.rejects(ingestWebhook(store, message, 'failure', Buffer.from(JSON.stringify(message)), {
      eventType: options.eventType, resolveContact: async () => { throw new Error('simulated outage'); },
    }), /simulated outage/);
    assert.equal((await db.query('SELECT * FROM sdr.webhook_receipts')).rows.length, 1);
    await ingestWebhook(store, message, 'failure', Buffer.from(JSON.stringify(message)), options);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length, 1);
    await assert.rejects(ingestWebhook(store, inbound('different'), 'failure', Buffer.from('different'), options), /IDEMPOTENCY_CONFLICT/);
  } finally { await db.close(); }
});

test('project handoff applies only to its known native execution; resume cannot arrive via an arbitrary webhook', async () => {
  const { db, store } = await setup();
  try {
    const message = inbound();
    await ingestWebhook(store, message, 'inbound', Buffer.from(JSON.stringify(message)), options);
    await db.query("UPDATE sdr.conversations SET execution_id='execution-1'");
    const handoff = { event: 'workflow.execution.handoff', workflow_id: 'workflow-1',
      workflow_execution_id: 'unrelated-execution', whatsapp_conversation_id: 'conversation-1' };
    await ingestWebhook(store, handoff, 'unrelated', Buffer.from(JSON.stringify(handoff)), { expectedWorkflowId: 'workflow-1' });
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'automatic');
    handoff.workflow_execution_id = 'execution-1';
    await ingestWebhook(store, handoff, 'handoff', Buffer.from(JSON.stringify(handoff)), { expectedWorkflowId: 'workflow-1' });
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'human');
    const resume = { ...handoff, event: 'workflow.execution.resume' };
    await ingestWebhook(store, resume, 'forged-resume', Buffer.from(JSON.stringify(resume)));
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'human');
  } finally { await db.close(); }
});

test('matching text and cloud_api origin cannot falsely confirm delivery; a known WAMID advances monotonically', async () => {
  const { db, store } = await setup();
  try {
    const received = inbound();
    await ingestWebhook(store, received, 'inbound', Buffer.from(JSON.stringify(received)), options);
    await db.query("UPDATE sdr.conversations SET execution_id='execution-1'");
    await db.query("INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES ('v1','team','sapore','v1','{}','v1','gpt-5.4-2026-03-05')");
    await db.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state) SELECT '1052683654599692:job-1','team','sapore','conversation-1',id,'wamid-1',1,0,'v1','dispatched' FROM sdr.candidates");
    const { digest } = await import('../src/store.js');
    await db.query("INSERT INTO sdr.deliveries(job_id,tenant_id,brand_id,conversation_id,state,text_hash) VALUES ('1052683654599692:job-1','team','sapore','conversation-1','unknown',$1)", [digest('Olá')]);
    const outbound = { ...received, message: { id: 'wamid-out', timestamp: String(Number(messageTime) + 1), type: 'text',
      text: { body: 'Olá' }, kapso: { direction: 'outbound', origin: 'cloud_api', status: 'sent' } } };
    await ingestWebhook(store, outbound, 'ambiguous', Buffer.from(JSON.stringify(outbound)), { eventType: 'whatsapp.message.sent' });
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.deliveries')).rows[0]?.state, 'unknown');
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'human');
    await db.query("UPDATE sdr.deliveries SET message_id='wamid-out'");
    await Promise.all([
      ingestWebhook(store, outbound, 'read', Buffer.from(JSON.stringify(outbound)), { eventType: 'whatsapp.message.read' }),
      ingestWebhook(store, outbound, 'late-sent', Buffer.from(JSON.stringify(outbound)), { eventType: 'whatsapp.message.sent' }),
    ]);
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.deliveries')).rows[0]?.state, 'read');
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.jobs')).rows[0]?.state, 'sent');
  } finally { await db.close(); }
});

test('verified native send binds WAMID and does not pause the conversation as human', async () => {
  const { db, store } = await setup();
  try {
    const received = inbound();
    await ingestWebhook(store, received, 'inbound-verified', Buffer.from(JSON.stringify(received)), options);
    await db.query("UPDATE sdr.conversations SET execution_id='execution-1'");
    await db.query("INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES ('v1','team','sapore','v1','{}','v1','gpt-5.4-2026-03-05')");
    await db.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state) SELECT '1052683654599692:job-1','team','sapore','conversation-1',id,'wamid-1',1,0,'v1','dispatched' FROM sdr.candidates");
    const { digest } = await import('../src/store.js');
    await db.query("INSERT INTO sdr.deliveries(job_id,tenant_id,brand_id,conversation_id,state,text_hash) VALUES ('1052683654599692:job-1','team','sapore','conversation-1','unknown',$1)", [digest('Olá')]);
    const outbound = { ...received, message: { id: 'wamid-out', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text',
      text: { body: 'Olá' }, kapso: { direction: 'outbound', origin: 'cloud_api', status: 'sent' } } };
    await ingestWebhook(store, outbound, 'verified-sent', Buffer.from(JSON.stringify(outbound)), {
      eventType: 'whatsapp.message.sent', verifyNativeSend: async () => true,
    });
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.deliveries')).rows[0]?.state, 'sent');
    assert.equal((await db.query<{message_id:string}>('SELECT message_id FROM sdr.deliveries')).rows[0]?.message_id, 'wamid-out');
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.jobs')).rows[0]?.state, 'sent');
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'automatic');
  } finally { await db.close(); }
});

test('buffered inbound messages use one canonical lookup and one ingestion per conversation', async () => {
  const { db, store } = await setup();
  try {
    let lookups = 0;
    let ingestions = 0;
    const original = store.ingest.bind(store);
    store.ingest = async input => { ingestions += 1; return original(input); };
    const payload = { type: 'whatsapp.message.received', batch: true,
      data: Array.from({ length: 10 }, (_, index) => inbound(`message-${index}`, 'unapproved-identity')) };
    await ingestWebhook(store, payload, 'buffered', Buffer.from(JSON.stringify(payload)), {
      ...options, resolveContact: async () => { lookups += 1; return { id: 'not-approved' }; },
    });
    assert.equal(lookups, 1);
    assert.equal(ingestions, 1);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length, 0);
  } finally { await db.close(); }
});

test('independent inbound conversations resolve contacts concurrently with a limit of four', async () => {
  const { db, store } = await setup();
  try {
    let active = 0;
    let peak = 0;
    let lookups = 0;
    const payload = { type: 'whatsapp.message.received', batch: true, data: Array.from({ length: 6 }, (_, index) => {
      const entry = inbound(`parallel-${index}`, `identity-${index}`);
      entry.conversation.id = `conversation-${index}`;
      return entry;
    }) };
    await ingestWebhook(store, payload, 'parallel-batch', Buffer.from(JSON.stringify(payload)), {
      ...options, resolveContact: async () => {
        lookups += 1; active += 1; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 25));
        active -= 1;
        return { id: 'not-approved' };
      },
    });
    assert.equal(lookups, 6);
    assert.ok(peak > 1 && peak <= 4);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length, 0);
  } finally { await db.close(); }
});

test('a delayed handoff older than the verified native resume cannot pause the conversation again', async () => {
  const { db, store } = await setup();
  try {
    const message = inbound();
    await ingestWebhook(store, message, 'start', Buffer.from(JSON.stringify(message)), options);
    await db.query("UPDATE sdr.conversations SET execution_id='execution-1'");
    const nativeResumeAt = new Date(Date.now() - 5000).toISOString();
    const handoff = { event: 'workflow.execution.handoff', workflow_id: 'workflow-1', workflow_execution_id: 'execution-1',
      whatsapp_conversation_id: 'conversation-1', occurred_at: new Date(Date.now() - 10000).toISOString() };
    await ingestWebhook(store, handoff, 'first-handoff', Buffer.from(JSON.stringify(handoff)));
    const channel = await store.channel(phone);
    await store.control(channel, 'conversation-1', 'resume', 'native-resume-1', 'execution-1', 'execution-1:native-resume-1',
      { providerOccurredAt: nativeResumeAt, providerSource: 'native_execution' });
    const before = (await db.query<{state:string,epoch:number}>('SELECT state,epoch FROM sdr.conversations')).rows[0]!;
    await ingestWebhook(store, handoff, 'delayed-handoff-new-delivery-key', Buffer.from(JSON.stringify(handoff)));
    const after = (await db.query<{state:string,epoch:number}>('SELECT state,epoch FROM sdr.conversations')).rows[0]!;
    assert.equal(after.state, 'automatic');
    assert.equal(after.epoch, before.epoch);
    assert.equal((await db.query("SELECT * FROM sdr.events WHERE type='handoff_ignored_stale'")).rows.length, 1);
    // Equal provider timestamps are ambiguous, not ordered by event IDs or arrival time.
    const equal = { ...handoff, occurred_at: nativeResumeAt };
    await ingestWebhook(store, equal, 'equal-time-handoff', Buffer.from(JSON.stringify(equal)));
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'human');
    await store.control(channel, 'conversation-1', 'resume', 'native-resume-2', 'execution-1', 'execution-1:native-resume-2',
      { providerOccurredAt: nativeResumeAt, providerSource: 'native_execution' });
    const missingTime = { ...handoff, occurred_at: undefined };
    await ingestWebhook(store, missingTime, 'missing-time-handoff', Buffer.from(JSON.stringify(missingTime)));
    assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state, 'human');
  } finally { await db.close(); }
});
