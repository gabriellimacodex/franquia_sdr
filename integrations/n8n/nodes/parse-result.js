const modelResponseReceivedAtMs = Date.now();
const prepared = $('Validate and prepare job').first().json;
const items = $input.all();
if (items.length !== 1) throw new Error('INVALID_RESPONSE_COUNT');
const response = items[0].json;
const modelMatches = response.model === prepared.model ||
  (prepared.task === 'briefing' && prepared.model === 'gpt-5-mini' && /^gpt-5-mini-\d{4}-\d{2}-\d{2}$/.test(response.model));
if (response.status !== 'completed' || !Array.isArray(response.output) || !modelMatches) throw new Error('MODEL_RESPONSE_NOT_COMPLETED');
const content = response.output.filter(item => item.type === 'message').flatMap(item => item.content || []);
if (content.some(item => item.type === 'refusal')) throw new Error('MODEL_REFUSAL');
const texts = content.filter(item => item.type === 'output_text').map(item => item.text);
if (texts.length !== 1 || typeof texts[0] !== 'string' || texts[0].length > 128000) throw new Error('INVALID_MODEL_OUTPUT');
let result;
try { result = JSON.parse(texts[0]); } catch { throw new Error('INVALID_MODEL_JSON'); }
if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('INVALID_MODEL_JSON');
// Same-execution n8n wall-clock interval: HTTP plus node overhead, not pure model inference.
// Invalid clocks or older prepared items must never prevent a valid completion callback.
const modelRoundTripMs = modelResponseReceivedAtMs - prepared.modelRequestStartedAtMs;
const timings = prepared.task === 'conversation' && Number.isSafeInteger(prepared.modelRequestStartedAtMs) &&
  prepared.modelRequestStartedAtMs >= 0 && Number.isSafeInteger(modelRoundTripMs) &&
  modelRoundTripMs >= 0 && modelRoundTripMs <= 180000 ? { modelRoundTripMs } : undefined;
// The backend alone validates the supplied domain schema, evidence, freshness and send policy.
return [{ json: { callbackUrl: prepared.callbackUrl, completion: {
  jobId: prepared.jobId, contextVersion: prepared.contextVersion, configVersion: prepared.configVersion,
  model: response.model, usage: response.usage || {}, result,
  ...(timings ? { timings } : {}),
} } }];
