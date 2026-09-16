import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildKapsoWorkflow } from '../integrations/kapso/artifacts.js';
import { buildN8nWorkflow } from '../integrations/n8n/artifacts.js';
import { selectNativeControl, isHumanResume } from '../integrations/kapso/control-contract.js';

const kapsoRoot = new URL('../integrations/kapso/functions/', import.meta.url);
const phoneNumberId = '1052683654599692';
const syntheticEnv = {
  KAPSO_NATIVE_CONTROL_VERIFIED: 'true',
  KAPSO_API_KEY: 'synthetic-kapso-key',
  SAPORE_API_URL: 'https://sdr.example.test',
  KAPSO_FUNCTION_TOKEN: 'synthetic-function-token',
  KAPSO_PHONE_NUMBER_ID: phoneNumberId,
};
function workflowRequest(vars: Record<string, string> = {}) {
  return new Request('https://functions.example.test', {
    method: 'POST',
    body: JSON.stringify({
      available_edges: ['send', 'poll', 'wait', 'handoff', 'end'],
      flow_info: { id: 'workflow-1' },
      execution_context: {
        system: { whatsapp_config: { phone_number_id: phoneNumberId } },
        context: { conversation_id: 'conversation-1', phone_number: '5511999990001' },
        vars,
      },
    }),
  });
}

async function loadFunction(name: string, fetch: typeof globalThis.fetch) {
  const source = await readFile(new URL(`${name}/index.js`, kapsoRoot), 'utf8');
  return vm.runInNewContext(`${source}\nhandler`, {
    Request, Response, URL, URLSearchParams, AbortSignal, TextEncoder,
    crypto: globalThis.crypto, fetch,
  }) as (request: Request, env: Record<string, string>) => Promise<Response>;
}

test('Kapso session stays closed until native control behavior has been verified', async () => {
  let calls = 0;
  const handler = await loadFunction('sapore-session', async () => {
    calls += 1;
    throw new Error('No network request should occur before the release gate');
  });
  const response = await handler(new Request('https://functions.example.test', {
    method: 'POST', body: JSON.stringify({ available_edges: ['send', 'poll', 'wait', 'handoff', 'end'] }),
  }), {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.next_edge, 'handoff');
  assert.equal(result.vars.sapore_error, 'native_control_not_verified');
  assert.equal(calls, 0);
});

test('a native handoff prevents job creation and send authorization', async () => {
  const paths: string[] = [];
  const handler = await loadFunction('sapore-session', async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/flow_executions')) return Response.json({ data: [
      { id: 'execution-1', status: 'handoff', workflow: { id: 'workflow-1' } },
    ] });
    if (url.pathname.endsWith('/workflow_executions/execution-1')) return Response.json({ data: {
      id: 'execution-1', status: 'handoff', whatsapp_conversation_id: 'conversation-1',
      workflow: { id: 'workflow-1' }, events: [],
    } });
    if (url.pathname.endsWith('/control')) return Response.json({ ok: true });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const result = await (await handler(workflowRequest(), syntheticEnv)).json();
  assert.equal(result.next_edge, 'handoff');
  assert.equal(result.vars.sapore_execution_id, 'execution-1');
  assert.ok(paths.some(path => path.endsWith('/control')));
  assert.ok(!paths.some(path => path.includes('/internal/turns')));
});

function sessionNetwork(state = 'ready', authorized = true) {
  const requests: { path: string; body: any }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/flow_executions')) return Response.json({ data: [
      { id: 'execution-1', status: 'running', workflow: { id: 'workflow-1' } },
    ] });
    if (url.pathname.endsWith('/workflow_executions/execution-1')) return Response.json({ data: {
      id: 'execution-1', status: 'running', whatsapp_conversation_id: 'conversation-1',
      workflow: { id: 'workflow-1' }, events: [],
    } });
    if (url.pathname.endsWith('/messages')) return Response.json({ data: [
      { id: 'wamid-latest', timestamp: '1730092801', from: '5511999990001', type: 'text', text: { body: 'Sou de Campinas' }, kapso: { direction: 'inbound', origin: 'cloud_api' } },
      { id: 'wamid-bot', timestamp: '1730092802', type: 'text', text: { body: 'old bot reply' }, kapso: { direction: 'outbound' } },
    ] });
    if (url.pathname.includes('/contacts/')) return Response.json({ data: {
      id: 'contact-1', wa_id: '5511999990001', business_scoped_user_id: null,
    } });
    if (url.pathname === '/internal/turns') return Response.json({
      id: 'turn-1', state, reply: ['Olá!', 'Qual é sua cidade?'], contextVersion: 3,
    });
    if (url.pathname.endsWith('/authorize-send')) return Response.json({
      authorized, state: authorized ? 'ready' : 'stale',
      reply: ['Olá!', 'Qual é sua cidade?'], attemptId: 'attempt-1',
    });
    if (url.pathname.endsWith('/control')) return Response.json({ ok: true });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  return { fetch, requests };
}

test('a ready reply is sent only after fresh native state and backend authorization', async () => {
  const network = sessionNetwork();
  const handler = await loadFunction('sapore-session', network.fetch);
  const result = await (await handler(workflowRequest(), syntheticEnv)).json();
  assert.equal(result.next_edge, 'send');
  assert.equal(result.vars.sapore_reply_text, 'Olá!\n\nQual é sua cidade?');
  assert.equal(result.vars.sapore_turn_id, 'turn-1');
  assert.equal(result.vars.sapore_attempt_id, 'attempt-1');
  const turn = network.requests.find(item => item.path === '/internal/turns')?.body;
  assert.equal(turn.messageId, 'wamid-latest');
  assert.equal(turn.contactId, 'contact-1');
  assert.equal(turn.text, 'Sou de Campinas');
  assert.equal(turn.executionId, 'execution-1');
  assert.equal(network.requests.at(-1)?.path, '/internal/turns/turn-1/authorize-send');
});

test('a pending turn polls without reusing an old reply or authorizing a send', async () => {
  const network = sessionNetwork('pending');
  const handler = await loadFunction('sapore-session', network.fetch);
  const result = await (await handler(workflowRequest(), syntheticEnv)).json();
  assert.equal(result.next_edge, 'poll');
  assert.equal(result.vars.sapore_reply_text, '');
  assert.ok(!network.requests.some(item => item.path.endsWith('/authorize-send')));
});

test('unknown delivery and escalated turns go to native handoff without another send', async () => {
  for (const state of ['unknown', 'handoff']) {
    const network = sessionNetwork(state);
    const handler = await loadFunction('sapore-session', network.fetch);
    const result = await (await handler(workflowRequest(), syntheticEnv)).json();
    assert.equal(result.next_edge, 'handoff', state);
    assert.equal(result.vars.sapore_reply_text, '');
    assert.ok(!network.requests.some(item => item.path.endsWith('/authorize-send')));
  }
});

test('the native graph stays draft with no triggers and routes every wait through the guard', async () => {
  const bundle = buildKapsoWorkflow({
    session: '11111111-1111-4111-8111-111111111111',
    dispatched: '22222222-2222-4222-8222-222222222222',
    handoff: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(bundle.workflow.status, 'draft');
  assert.equal('triggers' in bundle.workflow, false);
  const definition = bundle.workflow.definition;
  const guard = definition.nodes.find((node: any) => node.data.node_type === 'decide')!;
  assert.equal((guard.data.config.conditions as {label:string}[])[0]?.label, 'handoff');
  assert.equal(definition.edges.find(edge => edge.source === guard.id)?.label, 'handoff');
  const send = definition.nodes.filter((node: any) => node.data.node_type === 'send_text');
  assert.equal(send.length, 1);
  const waitNodes = definition.nodes.filter((node: any) => node.data.node_type === 'wait_for_response');
  assert.equal(waitNodes.length, 2);
  for (const wait of waitNodes) assert.ok(definition.edges.some((edge: any) => edge.source === wait.id && edge.target === guard.id));
  assert.equal(waitNodes.find((node: any) => node.data.config.has_timeout)?.data.config.timeout_seconds, 10);
  const dispatch = definition.nodes.find(node => node.data.node_type === 'function' && node.data.config.function_id === '22222222-2222-4222-8222-222222222222')!;
  const poll = waitNodes.find(node => node.data.config.has_timeout)!;
  assert.ok(definition.edges.some(edge => edge.source === dispatch.id && edge.target === poll.id));
  assert.throws(() => buildKapsoWorkflow({ session: 'guess', dispatched: '', handoff: '' }), /function IDs/);
});

test('a temporary native waiting status never records stop or authorizes a send', async () => {
  const requests: string[] = [];
  const handler = await loadFunction('sapore-session', async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path.endsWith('/flow_executions')) return Response.json({ data: [
      { id: 'execution-1', status: 'waiting', workflow: { id: 'workflow-1' } },
    ] });
    if (path.endsWith('/workflow_executions/execution-1')) return Response.json({ data: {
      id: 'execution-1', status: 'waiting', whatsapp_conversation_id: 'conversation-1',
      workflow: { id: 'workflow-1' }, events: [],
    } });
    return Response.json({ ok: true });
  });
  const result = await (await handler(workflowRequest(), syntheticEnv)).json();
  assert.equal(result.next_edge, 'wait');
  assert.ok(!requests.some(path => path.endsWith('/control') || path.includes('/internal/turns')));
});

test('after native send, the dispatch adapter records uncertainty once and never sends', async () => {
  const calls: { url: string; body: any; authorization: string | null }[] = [];
  const handler = await loadFunction('sapore-dispatched', async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('Authorization') });
    return Response.json({ ok: true });
  });
  const request = new Request('https://functions.example.test', { method: 'POST', body: JSON.stringify({
    execution_context: { vars: { sapore_turn_id: 'turn-1', sapore_execution_id: 'execution-1', sapore_control_fingerprint: 'execution-1:initial' } },
  }) });
  const result = await (await handler(request, syntheticEnv)).json();
  assert.equal(result.vars.sapore_reply_text, '');
  assert.equal(result.vars.sapore_dispatch_status, 'unknown');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sdr.example.test/internal/turns/turn-1/dispatched');
  assert.equal(calls[0].authorization, 'Bearer synthetic-function-token');
  assert.equal(calls[0].body.executionId, 'execution-1');
});

test('handoff records an idempotent control event without blocking the native Handoff node on failure', async () => {
  const calls: any[] = [];
  const handler = await loadFunction('sapore-handoff', async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response('', { status: 503 });
  });
  const request = new Request('https://functions.example.test', { method: 'POST', body: JSON.stringify({
    execution_context: { vars: { sapore_phone_number_id: phoneNumberId, sapore_conversation_id: 'conversation-1',
      sapore_execution_id: 'execution-1', sapore_turn_id: 'turn-1', sapore_control_fingerprint: 'execution-1:initial' } },
  }) });
  const response = await handler(request, syntheticEnv);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).vars.sapore_reply_text, '');
  assert.equal(calls[0].event, 'handoff');
  assert.equal(calls[0].eventId, 'execution-1:turn-1:handoff');
});

test('n8n draft requires real credential references, immediate authenticated acknowledgement, and no WhatsApp sender', async () => {
  const input = { backendOrigin: 'https://sdr.example.test', credentials: {
    inbound: { id: 'real-inbound-id', name: 'Sapore inbound' },
    callback: { id: 'real-callback-id', name: 'Sapore callback' },
    openai: { id: 'real-openai-id', name: 'OpenAI verified' },
  } };
  const workflow = await buildN8nWorkflow(input);
  assert.equal(workflow.active, false);
  const webhook = workflow.nodes.find((node: any) => node.type === 'n8n-nodes-base.webhook')!;
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.equal(webhook.parameters.responseMode, 'onReceived');
  assert.equal(webhook.parameters.options?.responseCode, 202);
  assert.equal(workflow.nodes.filter((node: any) => node.type === 'n8n-nodes-base.httpRequest').length, 2);
  assert.ok(!JSON.stringify(workflow).includes('api.kapso.ai'));
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  // @ts-expect-error Exercise runtime validation of an untrusted config file.
  await assert.rejects(buildN8nWorkflow({ ...input, credentials: {} }), /credential/);
});

test('n8n prepares strict supplied schema and pins callback; refuses incomplete or refused responses', async () => {
  const jobId = '1052683654599692:11111111-1111-4111-8111-111111111111';
  const job = { jobId, contextVersion: 3, configVersion: 'version-1', model: 'gpt-5.4-2026-03-05',
    instructions: 'Use only evidence.', context: { messages: [] }, outputSchema: { type: 'object', additionalProperties: false },
    callbackUrl: `https://sdr.example.test/internal/n8n/jobs/${encodeURIComponent(jobId)}/complete` };
  const source = (await readFile(new URL('../integrations/n8n/nodes/prepare-job.js', import.meta.url), 'utf8'))
    .replace('__SAPORE_BACKEND_ORIGIN__', JSON.stringify('https://sdr.example.test'));
  function prepare(body: any) {
    return vm.runInNewContext(`(function(){${source}\n})()`, { $input: { all: () => [{ json: { body } }] } });
  }
  const prepared = prepare(job)[0].json;
  assert.equal(prepared.request.store, false);
  assert.equal(prepared.request.text.format.strict, true);
  assert.deepEqual(prepared.request.text.format.schema, job.outputSchema);
  assert.throws(() => prepare({ ...job, callbackUrl: 'https://attacker.example/steal' }), /CALLBACK_ORIGIN_MISMATCH/);
  const briefing = prepare({ ...job, task: 'briefing', model: 'gpt-5-mini',
    callbackUrl: `https://sdr.example.test/internal/n8n/briefings/${encodeURIComponent(jobId)}/complete` })[0].json;
  assert.equal(briefing.request.model, 'gpt-5-mini');
  assert.ok(briefing.callbackUrl.includes('/briefings/'));
  const parseSource = await readFile(new URL('../integrations/n8n/nodes/parse-result.js', import.meta.url), 'utf8');
  function parse(response: any) {
    return vm.runInNewContext(`(function(){${parseSource}\n})()`, {
      $input: { all: () => [{ json: response }] }, $: () => ({ first: () => ({ json: prepared }) }),
    });
  }
  const response = { status: 'completed', model: job.model, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"bubbles":["Olá"]}' }] }] };
  const completion = parse(response)[0].json.completion;
  assert.equal(completion.jobId, jobId);
  assert.equal(completion.result.bubbles[0], 'Olá');
  assert.throws(() => parse({ ...response, status: 'incomplete' }), /NOT_COMPLETED/);
  assert.throws(() => parse({ ...response, output: [{ type: 'message', content: [{ type: 'refusal' }] }] }), /MODEL_REFUSAL/);
});

test('n8n accepts laboratory job identifiers produced by LabSessions', async () => {
  const jobId = 'lab-0123456789abcdef0123456789abcdef:11111111-1111-4111-8111-111111111111';
  const job = {
    jobId,
    contextVersion: 1,
    configVersion: 'version-1',
    model: 'gpt-5.4-2026-03-05',
    instructions: 'Use only evidence.',
    context: { messages: [] },
    outputSchema: { type: 'object', additionalProperties: false },
    callbackUrl: `https://sdr.example.test/internal/n8n/jobs/${encodeURIComponent(jobId)}/complete`,
  };
  const source = (await readFile(new URL('../integrations/n8n/nodes/prepare-job.js', import.meta.url), 'utf8'))
    .replace('__SAPORE_BACKEND_ORIGIN__', JSON.stringify('https://sdr.example.test'));
  const prepared = vm.runInNewContext(`(function(){${source}\n})()`, {
    $input: { all: () => [{ json: { body: job } }] },
  });
  assert.equal(prepared[0].json.jobId, jobId);
});

test('n8n caps paid model output for the laboratory budget gate', async () => {
  const jobId = 'lab-0123456789abcdef0123456789abcdef:22222222-2222-4222-8222-222222222222';
  const source = (await readFile(new URL('../integrations/n8n/nodes/prepare-job.js', import.meta.url), 'utf8'))
    .replace('__SAPORE_BACKEND_ORIGIN__', JSON.stringify('https://sdr.example.test'));
  const prepared = vm.runInNewContext(`(function(){${source}\n})()`, {
    $input: { all: () => [{ json: { body: {
      jobId,
      contextVersion: 1,
      configVersion: 'version-1',
      model: 'gpt-5.4-2026-03-05',
      instructions: 'Use only evidence.',
      context: { messages: [] },
      outputSchema: { type: 'object', additionalProperties: false },
      callbackUrl: `https://sdr.example.test/internal/n8n/jobs/${encodeURIComponent(jobId)}/complete`,
    } } }] },
  });
  assert.equal(prepared[0].json.request.max_output_tokens, 1200);
  assert.equal(prepared[0].json.request.service_tier, 'default');
});

test('only the configured explicit human resume event reconciles backend resume', async () => {
  const resumedAt = new Date(Date.now() - 10000).toISOString();
  for (const reason of ['human', 'timeout']) {
    const network = sessionNetwork('handoff');
    const calls: any[] = [];
    const handler = await loadFunction('sapore-session', async (input, init) => {
      if (String(input).endsWith('/workflow_executions/execution-1')) return Response.json({ data: {
        id: 'execution-1', status: 'running', whatsapp_conversation_id: 'conversation-1', workflow: { id: 'workflow-1' },
        events: [{ id: `resume-${reason}`, event_type: 'execution_resumed', created_at: resumedAt, payload: { reason } }],
      } });
      if (String(input).includes('/messages?')) return Response.json({ data: [{
        id: 'message-after-review', timestamp: String(Math.floor(Date.parse(resumedAt) / 1000) + 1), from: '5511999990001',
        type: 'text', text: { body: 'Podemos continuar' }, kapso: { direction: 'inbound' },
      }] });
      if (String(input).endsWith('/control')) calls.push(JSON.parse(String(init?.body)));
      return network.fetch(input, init);
    });
    await handler(workflowRequest(), { ...syntheticEnv, KAPSO_HUMAN_RESUME_EVENT_TYPE: 'execution_resumed', KAPSO_HUMAN_RESUME_REASON: 'human' });
    assert.equal(calls.filter(call => call.event === 'resume').length, reason === 'human' ? 1 : 0);
    if (reason === 'human') {
      const paths = network.requests.map(item => item.path);
      assert.ok(paths.indexOf('/internal/turns') < paths.indexOf('/internal/conversations/conversation-1/control'));
      assert.equal(paths.filter(path => path === '/internal/turns').length, 2);
    }
  }
});

test('ordinary timeout/user-input resumes and running transitions do not change the native control fingerprint', async () => {
  const handoff = { id: 'human-handoff', event_type: 'status_changed', created_at: '2026-09-08T10:00:00Z', payload: { status: 'handoff' } };
  const humanResume = { id: 'human-resume', event_type: 'execution_resumed', created_at: '2026-09-08T10:01:00Z', payload: { reason: 'human' } };
  const automatic = [
    { id: 'timeout-1', event_type: 'execution_resumed', created_at: '2026-09-08T10:02:00Z', payload: { reason: 'timeout' } },
    { id: 'input-1', event_type: 'execution_resumed', created_at: '2026-09-08T10:03:00Z', payload: { reason: 'user_input' } },
    { id: 'running-1', event_type: 'status_changed', created_at: '2026-09-08T10:04:00Z', payload: { status: 'running' } },
  ];
  for (const [events, expected] of [
    [automatic, 'initial'], [[handoff, ...automatic], handoff.id], [[handoff, humanResume, ...automatic], humanResume.id],
  ] as const) {
    const network = sessionNetwork('pending');
    const handler = await loadFunction('sapore-session', async (input, init) => {
      if (String(input).endsWith('/workflow_executions/execution-1')) return Response.json({ data: {
        id: 'execution-1', status: 'running', whatsapp_conversation_id: 'conversation-1', workflow: { id: 'workflow-1' }, events,
      } });
      return network.fetch(input, init);
    });
    const result = await (await handler(workflowRequest(), { ...syntheticEnv,
      KAPSO_HUMAN_RESUME_EVENT_TYPE: 'execution_resumed', KAPSO_HUMAN_RESUME_REASON: 'human' })).json();
    assert.equal(result.vars.sapore_control_fingerprint, `execution-1:${expected}`);
    const selection = selectNativeControl('execution-1', events, {
      KAPSO_HUMAN_RESUME_EVENT_TYPE: 'execution_resumed', KAPSO_HUMAN_RESUME_REASON: 'human',
    });
    assert.equal(selection.controlFingerprint, result.vars.sapore_control_fingerprint);
  }
  assert.equal(isHumanResume(automatic[0], { KAPSO_HUMAN_RESUME_EVENT_TYPE: 'execution_resumed' }), false);
  assert.equal(isHumanResume(humanResume, {}), false);
});

test('post-send checkpoint checks the previous unknown attempt before processing a newer inbound message', async () => {
  const network = sessionNetwork('pending');
  const handler = await loadFunction('sapore-session', async (input, init) => {
    if (String(input).endsWith('/internal/turns/previous-turn')) return Response.json({ id: 'previous-turn', state: 'unknown' });
    return network.fetch(input, init);
  });
  const result = await (await handler(workflowRequest({ sapore_turn_id: 'previous-turn', sapore_dispatch_status: 'unknown', sapore_control_fingerprint: 'execution-1:initial' }), syntheticEnv)).json();
  assert.equal(result.next_edge, 'handoff');
  assert.ok(!network.requests.some(item => item.path === '/internal/turns'));
});

test('a new verified human resume releases the old unknown reference but never replays the old inbound turn', async () => {
  const resumeAt = new Date(Date.now() - 2000).toISOString();
  const network = sessionNetwork('unknown');
  const handler = await loadFunction('sapore-session', async (input, init) => {
    if (String(input).endsWith('/workflow_executions/execution-1')) return Response.json({ data: {
      id: 'execution-1', status: 'running', whatsapp_conversation_id: 'conversation-1', workflow: { id: 'workflow-1' },
      events: [{ id: 'new-resume', event_type: 'execution_resumed', created_at: resumeAt, payload: { reason: 'human' } }],
    } });
    return network.fetch(input, init);
  });
  const result = await (await handler(workflowRequest({ sapore_turn_id: 'old-turn', sapore_dispatch_status: 'unknown', sapore_control_fingerprint: 'execution-1:old-handoff' }), {
    ...syntheticEnv, KAPSO_HUMAN_RESUME_EVENT_TYPE: 'execution_resumed', KAPSO_HUMAN_RESUME_REASON: 'human',
  })).json();
  assert.equal(result.next_edge, 'wait');
  assert.equal(result.vars.sapore_turn_id, '');
  assert.equal(result.vars.sapore_dispatch_status, 'reviewed_after_native_resume');
  assert.equal(network.requests.filter(item => item.path === '/internal/turns').length, 1);
  assert.equal(network.requests.filter(item => item.path.endsWith('/control') && item.body.event === 'resume').length, 1);
  assert.ok(!network.requests.some(item => item.path.endsWith('/authorize-send') || item.path.endsWith('/dispatched')));
});

test('equal native timestamps prefer Handoff over Resume regardless of lexicographic event IDs', async () => {
  const events = [
    { id: 'aaa-handoff', event_type: 'status_changed', created_at: '2026-09-08T10:00:00Z', payload: { status: 'handoff' } },
    { id: 'zzz-resume', event_type: 'execution_resumed', created_at: '2026-09-08T10:00:00Z', payload: { reason: 'human' } },
  ];
  const config = { KAPSO_HUMAN_RESUME_EVENT_TYPE: 'execution_resumed', KAPSO_HUMAN_RESUME_REASON: 'human' };
  const selection = selectNativeControl('execution-1', events, config);
  assert.equal(selection.controlFingerprint, 'execution-1:aaa-handoff');
  assert.equal(selection.humanResume, false);
  const network = sessionNetwork('pending');
  const handler = await loadFunction('sapore-session', async (input, init) => {
    if (String(input).endsWith('/workflow_executions/execution-1')) return Response.json({ data: {
      id: 'execution-1', status: 'running', whatsapp_conversation_id: 'conversation-1', workflow: { id: 'workflow-1' }, events,
    } });
    return network.fetch(input, init);
  });
  const result = await (await handler(workflowRequest(), { ...syntheticEnv, ...config })).json();
  assert.equal(result.vars.sapore_control_fingerprint, selection.controlFingerprint);
});
