import assert from 'node:assert/strict';
import test from 'node:test';
import { createLeadState, guardDecision, type AgentDecision, type GuardInput } from '../src/domain.js';
import { evaluationTenant, evaluationNow } from '../evaluations/scenarios.js';
import { guardQuestionReply } from '../src/question-reply.js';
import { guardFinancialDecision } from '../src/financial-reply.js';

const decision: AgentDecision = {
  bubbles: ['Legal — você está pensando em Osasco, certo?', 'Pra eu te orientar melhor, a operação seria tocada por você no dia a dia ou com um gestor/parceiro?'],
  proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null,
};
const input = (result: AgentDecision = decision): GuardInput => ({
  decision: result, tenant: evaluationTenant,
  lead: createLeadState(evaluationTenant.tenantId, evaluationTenant.brandId, 'fictional-lead'),
  sources: [], now: evaluationNow, latestMessage: 'To pensando em montar em Osaso',
});

test('laboratory keeps the city clarification literal and removes only the isolated extra qualification question', () => {
  const before = structuredClone(decision);
  const result = guardQuestionReply(input(), guardDecision, true);
  assert.equal(result.originalGuard.ok, false);
  assert.equal(result.guard.ok, true);
  assert.equal(result.repairCode, 'deferred_operating_question');
  if (!result.guard.ok || result.originalGuard.ok) return;
  assert.deepEqual(result.originalGuard.violations, ['multiple_questions']);
  assert.deepEqual(result.guard.decision, { ...decision, bubbles: [decision.bubbles[0]] });
  assert.deepEqual(decision, before, 'raw model decision must remain immutable');
});

test('a pure extra question is the only removable content; answers, quotes, URLs and compound questions remain rejected', () => {
  const variants = [
    ['Você mesma opera a loja. ' + decision.bubbles[1]],
    ['Antes de avançar, você opera? Quem decide?'],
    ['A cidade será confirmada pela equipe. ' + decision.bubbles[1]],
    ['Você opera a loja?'],
  ];
  for (const [second] of variants) {
    const result = guardQuestionReply(input({ ...decision, bubbles: [decision.bubbles[0], second] }), guardDecision, true);
    assert.equal(result.repairCode, null, second); assert.equal(result.guard.ok, false);
  }
  for (const first of ['Você pensa em Osasco? Quem decide?', 'Veja https://exemplo.invalid/?', 'Você disse “Osasco”, certo?', 'Você disse Osasco? Ainda preciso confirmar.']) {
    const result = guardQuestionReply(input({ ...decision, bubbles: [first, decision.bubbles[1]] }), guardDecision, true);
    assert.equal(result.repairCode, null, first); assert.equal(result.guard.ok, false);
  }
});

test('additional violations and any new memory extraction keep the original fallback', () => {
  const proposal: AgentDecision['proposals'][number] = {
    field: 'city', value: { kind: 'text', text: 'Osasco' },
    evidence: { messageId: 'm-city', quote: 'To pensando em montar em Osaso' },
    attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: null,
  };
  const variants: AgentDecision[] = [
    { ...decision, bubbles: ['O retorno é garantido. ' + decision.bubbles[0], decision.bubbles[1]] },
    { ...decision, bubbles: ['O investimento é R$ 1. ' + decision.bubbles[0], decision.bubbles[1]] },
    { ...decision, sourceRefs: ['not-approved'] },
    { ...decision, proposals: [proposal] },
    { ...decision, relations: [{ id: 'r1', name: 'Caio', role: 'family', evidence: proposal.evidence }] },
    { ...decision, referral: { name: 'Caio', contact: null, permissionToContact: false, evidence: proposal.evidence } },
  ];
  for (const variant of variants) {
    const result = guardQuestionReply(input(variant), guardDecision, true);
    assert.equal(result.repairCode, null); assert.deepEqual(result.guard, result.originalGuard);
    assert.equal(result.guard.ok, false);
  }
});

test('an independently answered sourced price is preserved verbatim in the retained bubble', () => {
  const base = input();
  const first = 'O investimento aprovado vai de R$ 250 mil a R$ 280 mil. A composição, incluindo giro, ainda precisa de validação. Você pensa em Osasco, certo?';
  const result = guardQuestionReply({ ...base,
    sources: [{ id: 'investment', tenantId: base.tenant.tenantId, brandId: base.tenant.brandId,
      title: 'Investimento fictício aprovado', content: 'Fonte da avaliação local', status: 'approved', active: true,
      validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, tags: ['investment'],
      claims: [{ kind: 'investment', text: 'O investimento aprovado vai de R$ 250 mil a R$ 280 mil.' }] }],
    decision: { ...decision, bubbles: [first, decision.bubbles[1]], sourceRefs: ['investment'] },
  }, guardDecision, true);
  assert.equal(result.repairCode, 'deferred_operating_question'); assert.ok(result.guard.ok);
  assert.equal(result.guard.decision.bubbles[0], first); assert.deepEqual(result.guard.decision.sourceRefs, ['investment']);
});

test('the full contract guard runs twice and the repaired decision is idempotent', () => {
  const observed: unknown[] = [];
  const tracked: typeof guardDecision = value => { observed.push(structuredClone(value.decision)); return guardDecision(value); };
  const repaired = guardQuestionReply(input(), tracked, true);
  assert.ok(repaired.guard.ok); assert.equal(observed.length, 2);
  assert.deepEqual(observed[0], decision); assert.deepEqual(observed[1], repaired.guard.decision);
  const again = guardQuestionReply(input(repaired.guard.decision), tracked, true);
  assert.equal(again.repairCode, null); assert.equal(observed.length, 3); assert.deepEqual(again.guard, repaired.guard);
});

test('control, non-laboratory and non-continue decisions take precedence over repair', () => {
  const cases: GuardInput[] = [
    { ...input(), latestMessage: 'Quero falar com um humano.' },
    { ...input(), latestMessage: 'Pare de me mandar mensagens.' },
    ...(['handoff', 'stopped', 'nurture'] as const).map(status => ({ ...input(), lead: { ...input().lead, status } })),
    ...(['handoff', 'stop', 'nurture'] as const).map(nextAction => input({ ...decision, nextAction, handoffReason: 'Revisão humana' })),
  ];
  for (const value of cases) {
    const result = guardQuestionReply(value, guardDecision, true);
    assert.equal(result.repairCode, null); assert.deepEqual(result.guard, result.originalGuard);
  }
  const external = guardQuestionReply(input(), guardDecision, false);
  assert.equal(external.repairCode, null); assert.deepEqual(external.guard, external.originalGuard);
});

test('financial-v2 revalidation cannot bypass a newly revealed structured-capital requirement', () => {
  const financial = { ...decision, financialReply: null };
  const base = { ...input(), decision: financial };
  const repaired = guardQuestionReply(base, guardFinancialDecision, true);
  assert.equal(repaired.guard.ok, true); assert.equal(repaired.repairCode, 'deferred_operating_question');
  const latest = 'Tenho R$ 260 mil de recursos próprios disponíveis.';
  const withCapital = { ...base, latestMessage: latest, latestMessageId: 'money', conversationId: 'conversation',
    trustedMessages: [{ id: 'money', text: latest, role: 'user' as const, tenantId: base.tenant.tenantId,
      brandId: base.tenant.brandId, leadId: base.lead.leadId, conversationId: 'conversation' }] };
  const required = guardQuestionReply(withCapital, guardFinancialDecision, true);
  assert.equal(required.originalGuard.ok, false); assert.equal(required.guard.ok, false);
  assert.equal(required.repairCode, null);
  assert.deepEqual(required.guard, required.originalGuard, 'failed revalidation must preserve the original model rejection');
  const structured = guardQuestionReply({ ...base, decision: { ...financial, financialReply: { capitalEvidence: null, investmentSourceId: null, followUp: 'experience' } } }, guardFinancialDecision, true);
  assert.equal(structured.repairCode, null); assert.equal(structured.guard.ok, false);
});
