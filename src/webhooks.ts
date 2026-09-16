import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Store, digest, type Channel } from './store.js';
import { scoped } from './database.js';
import { TurnInputSchema } from './contracts.js';
import { ServiceError } from './security.js';

const object = z.record(z.unknown());
const messageSchema = z.object({
  id: z.string().min(1).max(256), timestamp: z.string(), type: z.string(), from: z.string().optional(),
  from_user_id: z.string().optional(), text: z.object({ body: z.string() }).optional(),
  audio: z.object({ id: z.string() }).optional(),
  image: z.object({ id: z.string(), caption: z.string().optional() }).optional(),
  document: z.object({ id: z.string(), caption: z.string().optional(), filename: z.string().optional() }).optional(),
  contacts: z.array(z.object({ name: z.object({ formatted_name: z.string().optional() }).passthrough().optional(),
    phones: z.array(z.object({ phone: z.string().optional(), wa_id: z.string().optional() }).passthrough()).optional() }).passthrough()).optional(),
  interactive: z.object({ button_reply: z.object({ title: z.string() }).optional(), list_reply: z.object({ title: z.string() }).optional() }).optional(),
  kapso: z.object({ direction: z.enum(['inbound', 'outbound']), status: z.string().optional(), origin: z.string().optional(),
    transcript: z.object({ text: z.string().optional() }).nullable().optional() }).passthrough(),
}).passthrough();
const envelopeSchema = z.object({
  phone_number_id: z.string(), conversation: z.object({ id: z.string(), phone_number: z.string().nullable().optional(),
    phone_number_id: z.string().optional(), business_scoped_user_id: z.string().nullable().optional() }).passthrough(),
  message: messageSchema,
}).passthrough();
type Envelope = z.infer<typeof envelopeSchema>;
type Delivery = { job_id: string; message_id: string | null; state: string; text_hash: string; execution_id: string | null; created_at: Date };
export type WebhookOptions = {
  eventType?: string;
  expectedWorkflowId?: string;
  resolveContact?: (identity: string) => Promise<{ id: string; phone?: string }>;
  /** Must prove the actual WAMID belongs to this native execution from a verified provider contract. */
  verifyNativeSend?: (input: { conversationId: string; executionId: string; messageId: string; textHash: string; payload: unknown }) => Promise<boolean>;
};

type Contacts = z.infer<typeof messageSchema>['contacts'];
function messageType(type: string): 'text' | 'audio' | 'image' | 'document' | 'unsupported' {
  if (type === 'audio' || type === 'image' || type === 'document') return type;
  return ['text', 'interactive', 'contacts'].includes(type) ? 'text' : 'unsupported';
}
/** A shared contact card becomes candidate text; the referral rules in the prompt decide what to do with it. */
function contactCardText(contacts: Contacts): string {
  const card = contacts?.[0];
  if (!card) return '';
  const phone = card.phones?.[0]?.wa_id || card.phones?.[0]?.phone || '';
  return `[Cartão de contato] Nome: ${card.name?.formatted_name || ''} | Telefone: ${phone}`.trim();
}

function eventName(payload: Record<string, unknown>, fallback?: string): string {
  return typeof payload.event === 'string' ? payload.event : typeof payload.type === 'string' && payload.type.startsWith('whatsapp.')
    ? payload.type : fallback || '';
}

/** Called ONLY after the HTTP layer verifies HMAC against raw bytes. Does not log payloads or create model jobs. */
export async function ingestWebhook(store: Store, rawPayload: unknown, key: string, raw: Buffer, options: WebhookOptions = {}): Promise<void> {
  const payload = object.parse(rawPayload);
  const hash = createHash('sha256').update(raw).digest('hex');
  const receiptId = digest(`kapso:${key || hash}`);
  const previous = (await store.db.query<{payload_hash:string}>('SELECT payload_hash FROM sdr.webhook_receipts WHERE id=$1', [receiptId])).rows[0];
  if (previous) {
    if (previous.payload_hash !== hash) throw new ServiceError('WEBHOOK_IDEMPOTENCY_CONFLICT', 409);
    return;
  }
  const event = eventName(payload, options.eventType);
  const entries = payload.batch === true ? z.array(object).min(1).max(100).parse(payload.data) : [payload];
  // Request-local only: identity changes between webhook requests must not use a stale cache.
  const contactCache = new Map<string, Promise<{ id: string; phone?: string }>>();
  const cachedOptions: WebhookOptions = { ...options, ...(options.resolveContact ? {
    resolveContact: (identity: string) => {
      let pending = contactCache.get(identity);
      if (!pending) { pending = options.resolveContact!(identity); contactCache.set(identity, pending); }
      return pending;
    },
  } : {}) };
  if (entries.every(entry => eventName(entry, event) === 'whatsapp.message.received')) {
    const groups = new Map<string, Envelope[]>();
    for (const entry of entries) {
      const envelope = envelopeSchema.parse(entry);
      const groupKey = JSON.stringify([envelope.phone_number_id, envelope.conversation.id]);
      const group = groups.get(groupKey) || [];
      group.push(envelope); groups.set(groupKey, group);
    }
    const conversations = [...groups.values()];
    // Each conversation is ingested once; independent contact reads can overlap, bounded to four.
    for (let index = 0; index < conversations.length; index += 4) {
      const results = await Promise.allSettled(conversations.slice(index, index + 4).map(group =>
        ingestMessages(store, group, 'whatsapp.message.received', cachedOptions)));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  } else for (const entry of entries) {
    const entryEvent = eventName(entry, event);
    if (entryEvent.startsWith('whatsapp.message.')) await ingestMessages(store, [envelopeSchema.parse(entry)], entryEvent, cachedOptions);
    else if (['workflow.execution.handoff', 'workflow.execution.failed'].includes(entryEvent)) {
      await ingestControl(store, entry, entryEvent, receiptId, options);
    } else if (entryEvent === 'whatsapp.conversation.ended') {
      const phone = z.string().parse(entry.phone_number_id);
      const conversation = z.object({ id: z.string() }).parse(entry.conversation);
      const channel = await configuredChannel(store, phone);
      if (channel) await store.control(channel, conversation.id, 'handoff', receiptId);
    }
  }
  // Partial failure intentionally leaves no receipt: message/control writes are independently idempotent.
  await store.db.query('INSERT INTO sdr.webhook_receipts(id,payload_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [receiptId, hash]);
}

async function configuredChannel(store: Store, phone: string): Promise<Channel | undefined> {
  try { return await store.channel(phone); }
  catch (error) { if (error instanceof ServiceError && error.code === 'CHANNEL_NOT_CONFIGURED') return undefined; throw error; }
}

async function ingestMessages(store: Store, payloads: Envelope[], event: string, options: WebhookOptions): Promise<void> {
  const payload = payloads[0]!;
  const channel = await configuredChannel(store, payload.phone_number_id);
  if (!channel) return;
  const messages = [];
  for (const item of payloads) {
    if (item.message.kapso.origin === 'history_sync') continue;
    if (item.phone_number_id !== payload.phone_number_id || item.conversation.id !== payload.conversation.id ||
      (item.conversation.phone_number_id && item.conversation.phone_number_id !== item.phone_number_id)) {
      throw new ServiceError('WEBHOOK_CHANNEL_MISMATCH');
    }
    const message = item.message;
    if ((event === 'whatsapp.message.received') !== (message.kapso.direction === 'inbound')) throw new ServiceError('WEBHOOK_DIRECTION_MISMATCH');
    const timestamp = Number(message.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > Date.now() + 60000) throw new ServiceError('INVALID_MESSAGE_TIMESTAMP');
    const text = message.text?.body || message.kapso.transcript?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
      || message.image?.caption || message.document?.caption || contactCardText(message.contacts) || '';
    let actor: 'candidate' | 'agent' | 'human' = message.kapso.direction === 'inbound' ? 'candidate' : 'human';
    if (actor === 'human' && await reconcileDelivery(store, channel, item, event, text, options)) actor = 'agent';
    const mediaId = message.audio?.id || message.image?.id || message.document?.id;
    messages.push({ id: message.id, text, actor, timestamp: new Date(timestamp).toISOString(),
      type: messageType(message.type),
      ...(mediaId ? { mediaId } : {}),
      ...(message.kapso.transcript?.text ? { transcriptOrigin: 'kapso' } : {}),
    });
  }
  if (!messages.length) return;
  const known = await scoped(store.db, channel, async tx => (await tx.query<{contact_id:string}>(
    'SELECT p.contact_id FROM sdr.conversations c JOIN sdr.candidates p ON p.tenant_id=c.tenant_id AND p.brand_id=c.brand_id AND p.id=c.candidate_id WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.id=$3 AND c.phone_number_id=$4',
    [channel.tenantId, channel.brandId, payload.conversation.id, payload.phone_number_id])).rows[0]);
  const identity = payload.message.from_user_id || payload.message.from || payload.conversation.business_scoped_user_id || payload.conversation.phone_number;
  let contact: { id: string; phone?: string } | undefined = known ? { id: known.contact_id, phone: payload.conversation.phone_number || undefined } : undefined;
  if (!contact) {
    if (!identity || !options.resolveContact) throw new ServiceError('CONTACT_RESOLVER_REQUIRED', 503);
    contact = await options.resolveContact(identity);
  }
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const latest = messages.at(-1)!;
  await store.ingest(TurnInputSchema.parse({
    phoneNumberId: payload.phone_number_id, conversationId: payload.conversation.id,
    contactId: contact.id, ...(contact.phone ? { contactPhone: contact.phone } : {}), messageId: latest.id,
    text: latest.text, messages,
  }));
}

async function reconcileDelivery(store: Store, channel: Channel, payload: Envelope, event: string, text: string, options: WebhookOptions): Promise<boolean> {
  const s = [channel.tenantId, channel.brandId];
  const candidates = await scoped(store.db, channel, async tx => (await tx.query<Delivery>(
    `SELECT d.*,c.execution_id FROM sdr.deliveries d JOIN sdr.conversations c ON c.tenant_id=d.tenant_id AND c.brand_id=d.brand_id AND c.id=d.conversation_id
     WHERE d.tenant_id=$1 AND d.brand_id=$2 AND d.conversation_id=$3 AND (d.message_id=$4 OR (d.message_id IS NULL AND d.text_hash=$5 AND d.state IN ('dispatching','unknown')))`,
    [...s, payload.conversation.id, payload.message.id, digest(text)])).rows);
  let delivery = candidates.find(item => item.message_id === payload.message.id);
  if (!delivery && candidates.length === 1 && options.verifyNativeSend && candidates[0]!.execution_id &&
    Number(payload.message.timestamp) * 1000 >= candidates[0]!.created_at.getTime() - 2000) {
    const candidate = candidates[0]!;
    if (await options.verifyNativeSend({ conversationId: payload.conversation.id, executionId: candidate.execution_id!,
      messageId: payload.message.id, textHash: digest(text), payload })) delivery = candidate;
  }
  if (!delivery) return false; // Matching text/cloud_api origin alone is NOT evidence of the native sender.
  const status = event.slice('whatsapp.message.'.length);
  if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return false;
  const rank: Record<string, number> = { dispatching: 0, unknown: 0, sent: 1, delivered: 2, read: 3, failed: -1 };
  const next = await scoped(store.db, channel, async tx => {
    const current = (await tx.query<Delivery>('SELECT * FROM sdr.deliveries WHERE tenant_id=$1 AND brand_id=$2 AND job_id=$3 FOR UPDATE',
      [...s, delivery!.job_id])).rows[0];
    if (!current || (current.message_id && current.message_id !== payload.message.id)) return null;
    const state = status === 'failed' && ['delivered', 'read'].includes(current.state) ? current.state :
      current.state === 'failed' ? 'failed' : status === 'failed' || (rank[status] ?? 0) > (rank[current.state] ?? 0) ? status : current.state;
    await tx.query('UPDATE sdr.deliveries SET message_id=COALESCE(message_id,$4),state=$5,updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND job_id=$3',
      [...s, delivery!.job_id, payload.message.id, state]);
    await tx.query("UPDATE sdr.jobs SET state=$4,error_code=$5 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND state IN ('dispatching','dispatched','unknown','sent')",
      [...s, delivery!.job_id, state === 'failed' ? 'handoff' : 'sent', state === 'failed' ? 'PROVIDER_SEND_FAILED' : null]);
    await tx.query("UPDATE sdr.messages SET actor='agent' WHERE tenant_id=$1 AND brand_id=$2 AND conversation_id=$3 AND id=$4 AND actor='human'",
      [...s, payload.conversation.id, payload.message.id]);
    return state;
  });
  if (next === null) return false;
  if (next === 'failed') await store.control(channel, payload.conversation.id, 'handoff', `${payload.message.id}:failed`);
  return true;
}

async function ingestControl(store: Store, payload: Record<string, unknown>, event: string, receiptId: string, options: WebhookOptions): Promise<void> {
  if (options.expectedWorkflowId && payload.workflow_id !== options.expectedWorkflowId) return;
  const input = z.object({ whatsapp_conversation_id: z.string(), workflow_execution_id: z.string() }).parse(payload);
  for (const channel of await store.channels()) {
    const matches = await scoped(store.db, channel, async tx => (await tx.query(
      'SELECT id FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND execution_id=$4 AND phone_number_id=$5',
      [channel.tenantId, channel.brandId, input.whatsapp_conversation_id, input.workflow_execution_id, channel.phoneNumberId])).rows.length > 0);
    if (matches) await store.control(channel, input.whatsapp_conversation_id, 'handoff', `${event}:${receiptId}`, input.workflow_execution_id, undefined, {
      providerSource: 'signed_webhook',
      ...(typeof payload.occurred_at === 'string' ? { providerOccurredAt: payload.occurred_at } : {}),
    });
  }
}
