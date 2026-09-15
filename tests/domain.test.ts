import assert from 'node:assert/strict';
import test from 'node:test';
import { createLeadState, mergeFactProposals, confirmFact, deriveQualification, detectControlIntent, selectSources, guardDecision, buildAgentContext, AgentDecisionSchema, AGENT_OUTPUT_JSON_SCHEMA, type FactProposal, type TrustedMessage, type TenantConfig } from '../src/domain.js';
import { qualificationScenarios, controlScenarios, sourceScenarios, guardScenarios, evaluationTenant, evaluationNow, readyLead, decision } from '../evaluations/scenarios.js';
import { CONVERSATION_MODEL, BRIEFING_MODEL } from '../src/prompts.js';

const message: TrustedMessage = { id: 'm1', tenantId: 't1', brandId: 'sapore', leadId: 'l1', role: 'user', text: 'Tenho entre 250 e 280 mil de recursos próprios.' };
const budget: FactProposal = { field: 'capital_available', value: { kind: 'number_range', min: 250000, max: 280000, unit: 'BRL' }, evidence: { messageId: 'm1', quote: message.text }, attribution: 'candidate', capitalOrigin: 'own', relationId: null, replacesFactId: null };
const tenant: TenantConfig = { tenantId: 't1', brandId: 'sapore', brandName: 'Sapore', mode: 'homologation', commercialPolicyApproved: true, investmentMin: 250000, investmentMax: 280000, includesWorkingCapital: null, hotTimingMonths: 3, approvedTerritories: ['Campinas'] };

test('memory preserves the declared interval and origin without letting the model confirm it', () => {
  const state = createLeadState('t1', 'sapore', 'l1');
  const next = mergeFactProposals(state, [budget], [message]);
  assert.equal(next.facts.length, 1);
  assert.deepEqual(next.facts[0].value, budget.value);
  assert.equal(next.facts[0].capitalOrigin, 'own');
  assert.equal(next.facts[0].status, 'declared');
  assert.equal(next.facts[0].confirmedBy, null);
  assert.equal(state.facts.length, 0);
});

test('explicit control requests precede qualification without confusing negation or Pará', () => {
  for (const fixture of controlScenarios) assert.equal(detectControlIntent(fixture.utterance), fixture.expected, fixture.id);
});

test('retrieval selects only active approved sources belonging to this brand at the current time', () => {
  for (const fixture of sourceScenarios) assert.equal(selectSources([fixture.source], evaluationTenant.tenantId, evaluationTenant.brandId, evaluationNow, 'investimento').length, fixture.selected ? 1 : 0, fixture.id);
});

test('communication guard rejects unsupported commercial promises and fabricated completed actions', () => {
  for (const fixture of guardScenarios) {
    const result = guardDecision({ decision: fixture.decision, tenant: evaluationTenant, lead: readyLead(), sources: fixture.sources, now: evaluationNow, latestMessage: fixture.utterance });
    assert.equal(result.ok, fixture.allowed, fixture.id);
    if (!result.ok) assert.ok(result.safeDecision.bubbles.length <= 2);
  }
});

test('fictional qualification scenarios use declared capital, timing and territory policies', () => {
  for (const fixture of qualificationScenarios) {
    const result = deriveQualification(fixture.state, fixture.tenant);
    assert.equal(result.temperature, fixture.expected, fixture.id);
    assert.equal(result.canHandoff, fixture.canHandoff, fixture.id);
    assert.equal(result.priority, fixture.priority, fixture.id);
  }
});

test('qualification keeps unknown separate and never elevates a declaration to confirmed capital', () => {
  const state = mergeFactProposals(createLeadState('t1', 'sapore', 'l1'), [budget], [message]);
  assert.equal(deriveQualification(state, tenant).temperature, 'unknown');
  assert.equal(deriveQualification(state, tenant).canHandoff, false);
  const confirmed = confirmFact(state, state.facts[0].id, 'operator', 'accept');
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  assert.equal(deriveQualification(confirmed.state, { ...tenant, commercialPolicyApproved: false }).priority, 'B');
  assert.equal(deriveQualification(confirmed.state, { ...tenant, tenantId: 'other' }).temperature, 'unknown');
});

test('evidence must be a real user quote from the same tenant, brand and lead; replay is idempotent', () => {
  const state = createLeadState('t1', 'sapore', 'l1');
  for (const wrongMessage of [
    { ...message, tenantId: 't2' }, { ...message, brandId: 'other' }, { ...message, leadId: 'l2' },
    { ...message, role: 'assistant' as const }, { ...message, text: 'Outra coisa.' },
  ]) assert.equal(mergeFactProposals(state, [budget], [wrongMessage]).facts.length, 0);
  assert.equal(mergeFactProposals(state, [{ ...budget, status: 'confirmed' } as FactProposal], [message]).facts.length, 0);
  const first = mergeFactProposals(state, [budget], [message]);
  assert.equal(mergeFactProposals(first, [budget], [message]).facts.length, 1);
});

test('conflicting proposals retain confirmed facts until an operator explicitly replaces them', () => {
  const initial = mergeFactProposals(createLeadState('t1', 'sapore', 'l1'), [budget], [message]);
  const confirmed = confirmFact(initial, initial.facts[0].id, 'operator-1', 'accept');
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  const correction = { ...message, id: 'm2', text: 'Corrigindo: tenho 220 mil próprios.' };
  const proposal: FactProposal = { ...budget, value: { kind: 'number_range', min: 220000, max: 220000, unit: 'BRL' }, evidence: { messageId: 'm2', quote: correction.text }, replacesFactId: initial.facts[0].id };
  const next = mergeFactProposals(confirmed.state, [proposal], [correction]);
  assert.equal(next.facts[0].status, 'confirmed');
  assert.equal(next.facts[1].status, 'conflict');
  assert.equal(confirmFact(next, next.facts[1].id, 'operator-1', 'accept').ok, false);
  const replacement = confirmFact(next, next.facts[1].id, 'operator-1', 'replace');
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;
  assert.equal(replacement.state.facts[0].status, 'superseded');
  assert.equal(replacement.state.facts[1].status, 'confirmed');
  assert.equal(next.facts[0].status, 'confirmed');
});

test('different capital origins remain separate declarations without becoming a conflict or a sum', () => {
  const ownMessage = { ...message, text: 'Tenho 200 mil de recursos próprios.' };
  const own: FactProposal = { ...budget, value: { kind: 'number_range', min: 200000, max: 200000, unit: 'BRL' }, evidence: { messageId: ownMessage.id, quote: ownMessage.text } };
  const creditMessage = { ...message, id: 'credit', text: 'Posso tentar um crédito de 100 mil.' };
  const credit: FactProposal = { ...budget, value: { kind: 'number_range', min: 100000, max: 100000, unit: 'BRL' }, capitalOrigin: 'credit', evidence: { messageId: 'credit', quote: creditMessage.text } };
  const next = mergeFactProposals(createLeadState('t1', 'sapore', 'l1'), [own, credit], [ownMessage, creditMessage]);
  assert.deepEqual(next.facts.map(fact => fact.status), ['declared', 'declared']);
  assert.equal(deriveQualification(next, tenant).priority, 'B');
  assert.deepEqual(next.facts.map(fact => fact.value), [own.value, credit.value]);
});

test('strict output contracts and context isolation preserve the stopped state on unsafe output', () => {
  assert.equal(CONVERSATION_MODEL, 'gpt-5.4-2026-03-05');
  assert.equal(BRIEFING_MODEL, 'gpt-5-mini');
  assert.equal(AGENT_OUTPUT_JSON_SCHEMA.additionalProperties, false);
  assert.equal(AgentDecisionSchema.safeParse(decision(['Um', 'Dois', 'Três'])).success, false);
  assert.equal(AgentDecisionSchema.safeParse({ ...decision(['Olá.']), confirmed: true }).success, false);
  assert.equal(AgentDecisionSchema.safeParse({ ...decision(['Olá.']), handoffReason: undefined }).success, false);
  const lead = readyLead();
  assert.deepEqual(buildAgentContext({ tenant: { ...evaluationTenant, brandId: 'other' }, lead, sources: [], now: evaluationNow }), { ok: false, error: 'SCOPE_MISMATCH' });
  lead.status = 'stopped';
  const result = guardDecision({ decision: decision(['Qual seu orçamento?']), tenant: evaluationTenant, lead, sources: [], now: evaluationNow });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.safeDecision.nextAction, 'stop');
});
