import { readFile } from 'node:fs/promises';

export type CredentialReference = { id: string; name: string };
export type N8nArtifactInput = {
  backendOrigin: string;
  credentials: { inbound: CredentialReference; callback: CredentialReference; openai: CredentialReference };
};

/** Builds an inactive NEW workflow export. No network requests or credential material are used. */
export async function buildN8nWorkflow(input: N8nArtifactInput) {
  const origin = new URL(input.backendOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
    origin.pathname !== '/') throw new Error('A pinned HTTPS backend origin is required');
  for (const key of ['inbound', 'callback', 'openai'] as const) {
    const ref = input.credentials?.[key];
    if (!ref?.id?.trim() || !ref?.name?.trim() || /placeholder|replace[_ -]?me|<|>/i.test(ref.id)) {
      throw new Error(`Verified n8n ${key} credential id and name are required`);
    }
  }
  const prepare = (await readFile(new URL('./nodes/prepare-job.js', import.meta.url), 'utf8'))
    .replace('__SAPORE_BACKEND_ORIGIN__', JSON.stringify(origin.origin));
  const parse = await readFile(new URL('./nodes/parse-result.js', import.meta.url), 'utf8');
  const httpOptions = { timeout: 40000, redirect: { redirect: { followRedirects: false } },
    response: { response: { responseFormat: 'json' } } };
  const nodes = [
    { id: 'sapore-job-webhook', name: 'Authenticated job', type: 'n8n-nodes-base.webhook', typeVersion: 2,
      position: [0, 0], webhookId: 'sapore-sdr-v1-jobs',
      parameters: { httpMethod: 'POST', path: 'sapore-sdr-v1-jobs', authentication: 'headerAuth',
        responseMode: 'onReceived', options: { responseCode: 202, noResponseBody: true } },
      credentials: { httpHeaderAuth: input.credentials.inbound } },
    { id: 'sapore-prepare-job', name: 'Validate and prepare job', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [260, 0], parameters: { mode: 'runOnceForAllItems', jsCode: prepare } },
    { id: 'sapore-openai-response', name: 'Structured model response', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [520, 0], retryOnFail: false,
      parameters: { method: 'POST', url: 'https://api.openai.com/v1/responses', authentication: 'predefinedCredentialType',
        nodeCredentialType: 'openAiApi', sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.request) }}', options: httpOptions },
      credentials: { openAiApi: input.credentials.openai } },
    { id: 'sapore-parse-result', name: 'Validate response envelope', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [780, 0], parameters: { mode: 'runOnceForAllItems', jsCode: parse } },
    { id: 'sapore-backend-callback', name: 'Authenticated backend callback', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [1040, 0], retryOnFail: false,
      parameters: { method: 'POST', url: '={{ $json.callbackUrl }}', authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.completion) }}', options: { ...httpOptions, timeout: 8000 } },
      credentials: { httpHeaderAuth: input.credentials.callback } },
  ];
  const connections = Object.fromEntries(nodes.slice(0, -1).map((node, index) => [node.name, {
    main: [[{ node: nodes[index + 1]!.name, type: 'main', index: 0 }]],
  }]));
  return {
    name: 'Sapore SDR — async reasoning v1', active: false, nodes, connections,
    settings: { executionOrder: 'v1', executionTimeout: 55,
      saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveManualExecutions: false,
      saveExecutionProgress: false },
  };
}
