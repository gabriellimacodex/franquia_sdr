import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadState, type GuardInput, type TrustedMessage } from '../src/domain.js';
import { FINANCIAL_OUTPUT_JSON_SCHEMA, FinancialDecisionSchema, guardFinancialDecision } from '../src/financial-reply.js';
import { initialSnapshot } from '../src/seed.js';

const scope = { tenantId: 'cognita-homologacao', brandId: 'sapore' };
const snapshot = initialSnapshot(scope);
const lead = createLeadState(scope.tenantId, scope.brandId, 'candidate');
const message: TrustedMessage = { ...scope, leadId: lead.leadId, conversationId: 'conversation', id: 'message', role: 'user', text: 'Tenho R$ 260 mil de recursos próprios disponíveis e pretendo abrir em três meses. Júlia participa da decisão, mas não aporta dinheiro. Esse investimento inclui capital de giro?' };
const evidence = { messageId: message.id, quote: message.text };
const decision = {
  bubbles: [], proposals: [], relations: [], referral: null, sourceRefs: [snapshot.sources[0].id], nextAction: 'continue', handoffReason: null,
  financialReply: { capitalEvidence: evidence, investmentSourceId: snapshot.sources[0].id, followUp: 'experience' },
};
function check(raw: unknown = decision, changes: Partial<GuardInput> = {}) {
  return guardFinancialDecision({ decision: raw, tenant: snapshot.tenant, lead, sources: snapshot.sources, now: '2026-09-11T15:00:00.000Z', trustedMessages: [message], conversationId: message.conversationId, latestMessageId: message.id, latestMessage: message.text, ...changes });
}

test('structured finance renders candidate money separately from the literal approved brand reference', () => {
  const result = check();
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.decision.bubbles, [
    'Você informou R$ 260.000,00 de recursos próprios disponíveis. Esse é um valor declarado por você, não o preço da franquia. O investimento de referência para a Sapore Açaí é de R$ 250 mil a R$ 280 mil. A composição desse valor, incluindo giro, taxa e implantação, ainda precisa de validação.',
    'Você já teve experiência com varejo, alimentação ou gestão de equipe?',
  ]);
  assert.equal(result.decision.bubbles.join(' ').includes('vocês têm'), false);
  assert.equal('financialReply' in result.decision, false);
});

test('the recap reference must quote the canonical current declaration, not unrelated or forged evidence', () => {
  for (const capitalEvidence of [
    { ...evidence, messageId: 'old-message' },
    { ...evidence, quote: 'Júlia participa da decisão' },
    { ...evidence, quote: 'Tenho R$ 999 mil de recursos próprios disponíveis.' },
  ]) {
    const result = check({ ...decision, financialReply: { ...decision.financialReply, capitalEvidence } });
    assert.equal(result.ok, false, JSON.stringify(capitalEvidence));
  }
  assert.equal(check({ ...decision, financialReply: { ...decision.financialReply, capitalEvidence: { ...evidence, quote: message.text.split('. ')[0] + '.' } } }).ok, true);
});

test('all v2 monetary proposals require the same validated value, owner, origin and evidence even without a recap', () => {
  const proposal = { field: 'capital_available', value: { kind: 'number_range', min: 260000, max: 260000, unit: 'BRL' }, evidence, attribution: 'candidate', capitalOrigin: 'own', relationId: null, replacesFactId: null };
  for (const financialReply of [decision.financialReply, null]) {
    assert.equal(check({ ...decision, financialReply, proposals: [proposal] }).ok, financialReply !== null);
    for (const change of [
      { value: { ...proposal.value, min: 999000, max: 999000 } },
      { value: { ...proposal.value, max: null } },
      { attribution: 'partner' }, { capitalOrigin: 'credit' }, { relationId: 'julia' },
      { field: 'investment_total' }, { field: 'working_capital' }, { field: 'experience' },
      { evidence: { ...evidence, quote: 'Júlia participa da decisão' } },
    ]) assert.equal(check({ ...decision, financialReply, proposals: [{ ...proposal, ...change }] }).ok, false, JSON.stringify(change));
  }
});

test('rendering never bypasses promise and total-question guards even for an approved source', () => {
  for (const text of [
    snapshot.sources[0].claims[0].text + ' Garantimos retorno.',
    snapshot.sources[0].claims[0].text + ' Quer investir?',
  ]) {
    const sources = [{ ...snapshot.sources[0], claims: [{ kind: 'investment' as const, text }] }];
    assert.equal(check(decision, { sources }).ok, false, text);
  }
});

test('v2 output schema is an explicit strict nullable extension of the legacy contract', () => {
  const schema = FINANCIAL_OUTPUT_JSON_SCHEMA;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('financialReply'));
  const financial = schema.properties.financialReply as { anyOf: { type: string, required?: string[], additionalProperties?: boolean }[] };
  assert.deepEqual(financial.anyOf[0].required, ['capitalEvidence', 'investmentSourceId', 'followUp']);
  assert.equal(financial.anyOf[0].additionalProperties, false);
  assert.equal(financial.anyOf[1].type, 'null');
  assert.equal(FinancialDecisionSchema.safeParse(decision).success, true);
  assert.equal(FinancialDecisionSchema.safeParse({ ...decision, financialReply: undefined }).success, false);
});
