const backendOrigin = __SAPORE_BACKEND_ORIGIN__;
const items = $input.all();
if (items.length !== 1) throw new Error('INVALID_JOB_COUNT');
const job = items[0].json.body;
const task = job?.task || 'conversation';
const scopedJobId = /^(?:\d{10,20}|lab-[0-9a-f]{32}):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!job || !scopedJobId.test(job.jobId) || !Number.isSafeInteger(job.contextVersion) || job.contextVersion < 0 ||
  typeof job.configVersion !== 'string' || !job.configVersion ||
  !['conversation', 'briefing'].includes(task) ||
  job.model !== (task === 'briefing' ? 'gpt-5-mini' : 'gpt-5.4-2026-03-05') ||
  typeof job.instructions !== 'string' || !job.instructions.trim() ||
  !job.context || typeof job.context !== 'object' || Array.isArray(job.context) ||
  !job.outputSchema || typeof job.outputSchema !== 'object' || Array.isArray(job.outputSchema) ||
  JSON.stringify(job).length > 256000) throw new Error('INVALID_JOB_ENVELOPE');
const callbackUrl = `${backendOrigin}/internal/n8n/${task === 'briefing' ? 'briefings' : 'jobs'}/${encodeURIComponent(job.jobId)}/complete`;
if (job.callbackUrl !== callbackUrl) throw new Error('CALLBACK_ORIGIN_MISMATCH');
let input = [{ role: 'user', content: JSON.stringify(job.context) }];
if (task === 'conversation' && job.jobId.startsWith('lab-')) {
  const { messages, ...metadata } = job.context;
  if (!Array.isArray(messages) || messages.length > 24 || messages.some(message =>
    !message || typeof message !== 'object' || Array.isArray(message) ||
    !['user', 'assistant', 'operator'].includes(message.role) ||
    typeof message.id !== 'string' || !message.id || typeof message.text !== 'string')) {
    throw new Error('INVALID_CONVERSATION_HISTORY');
  }
  // Replay the approved visible conversation with native roles, retaining evidence IDs.
  // Metadata remains user-level data; neither history nor sources become instructions.
  if (messages.length) input = [
    { role: 'user', content: JSON.stringify(metadata) },
    ...messages.map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: JSON.stringify(message) })),
  ];
}
return [{ json: {
  jobId: job.jobId, contextVersion: job.contextVersion, configVersion: job.configVersion,
  task, model: job.model, callbackUrl,
  request: {
    model: job.model, instructions: job.instructions, store: false, max_output_tokens: 1200, service_tier: 'default',
    input,
    text: { format: { type: 'json_schema', name: 'sapore_turn', strict: true, schema: job.outputSchema } },
  },
  modelRequestStartedAtMs: Date.now(),
} }];
