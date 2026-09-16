import { readFile } from 'node:fs/promises';

export const PHONE_NUMBER_ID = '1093705843816293';
export type FunctionIds = { session: string; dispatched: string; handoff: string };
type Node = { id: string; position: { x: number; y: number }; data: { node_type: string; config: Record<string, unknown> } };

const ids = {
  guard: 'decide_1788868800000', send: 'send_text_1788868800001',
  dispatched: 'function_1788868800002', poll: 'wait_for_response_1788868800003',
  wait: 'wait_for_response_1788868800004', recordHandoff: 'function_1788868800005',
  handoff: 'handoff_1788868800006', end: 'set_variable_1788868800007',
};

/** Creates a NEW draft only. Trigger attachment is a separate release operation. */
export function buildKapsoWorkflow(functionIds: FunctionIds) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!Object.values(functionIds).every(value => uuid.test(value)) || Object.keys(functionIds).length !== 3) {
    throw new Error('Verified Kapso function IDs are required; deploy new functions first');
  }
  const nodes: Node[] = [];
  function node(id: string, type: string, config: Record<string, unknown>, x: number, y: number) {
    nodes.push({ id, position: { x, y }, data: { node_type: type, config } });
  }
  node('start', 'start', {}, 440, 40);
  node(ids.guard, 'decide', {
    decision_type: 'function', function_id: functionIds.session,
    conditions: [
      { label: 'handoff', description: 'Safe first-edge fallback: takeover, escalation, uncertainty, or failure' },
      { label: 'send', description: 'Fresh turn authorized once by the backend and native owner' },
      { label: 'poll', description: 'Persisted n8n job is still pending' },
      { label: 'wait', description: 'No new turn; wait for a candidate message' },
      { label: 'end', description: 'Conversation or execution has ended' },
    ],
  }, 440, 230);
  node(ids.send, 'send_text', { message: '{{vars.sapore_reply_text}}', delay_seconds: 0 }, 140, 440);
  node(ids.dispatched, 'function', { function_id: functionIds.dispatched }, 140, 640);
  node(ids.poll, 'wait_for_response', { has_timeout: true, timeout_seconds: 10 }, 440, 440);
  node(ids.wait, 'wait_for_response', { has_timeout: false }, 140, 840);
  node(ids.recordHandoff, 'function', { function_id: functionIds.handoff }, 740, 440);
  node(ids.handoff, 'handoff', {}, 740, 640);
  node(ids.end, 'set_variable', { variable_name: 'sapore_complete', variable_value: 'true', value_type: 'string' }, 1040, 440);
  const edges = [
    { source: 'start', target: ids.guard, label: 'next' },
    ...(['handoff', 'send', 'poll', 'wait', 'end'] as const).map(label => ({
      source: ids.guard, target: label === 'handoff' ? ids.recordHandoff : ids[label], label,
    })),
    { source: ids.send, target: ids.dispatched, label: 'next' },
    { source: ids.dispatched, target: ids.poll, label: 'next' },
    { source: ids.poll, target: ids.guard, label: 'next' },
    { source: ids.wait, target: ids.guard, label: 'next' },
    { source: ids.recordHandoff, target: ids.handoff, label: 'next' },
    { source: ids.handoff, target: ids.wait, label: 'next' },
  ];
  return { workflow: {
    name: 'Sapore SDR — controle de sessão v1', status: 'draft',
    description: 'Piloto interno. Kapso controla sessão e envio; n8n produz decisões assíncronas. Sem trigger até teste de handoff.',
    message_debounce_seconds: 2,
    definition: { nodes, edges },
  } };
}

export async function buildKapsoFunctions() {
  return Promise.all(['sapore-session', 'sapore-dispatched', 'sapore-handoff'].map(async slug => ({
    slug,
    create: { function: {
      name: slug, description: 'Sapore SDR v1 — private workflow adapter',
      code: await readFile(new URL(`./functions/${slug}/index.js`, import.meta.url), 'utf8'),
      public_endpoint: false, invoke_response_mode: 'passthrough',
    } },
  })));
}

export function buildDisabledInboundTrigger() {
  return { trigger: {
    trigger_type: 'inbound_message', active: false,
    phone_number_id: PHONE_NUMBER_ID,
  } };
}
