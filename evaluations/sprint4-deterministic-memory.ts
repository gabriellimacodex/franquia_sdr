import assert from 'node:assert/strict';
import type { DeterministicCase } from './sprint4-deterministic.spec.js';
import { AgentDecisionSchema, LeadStateSchema, RelationProposalSchema, createLeadState, deriveQualification, hasTrustedEvidence, mergeFactProposals, type AgentDecision, type FactProposal, type TrustedMessage } from '../src/domain.js';
import { reconcileMemoryReply } from '../src/memory-reply.js';
import { guardFinancialDecision } from '../src/financial-reply.js';
import type { Snapshot } from '../src/versioning.js';

const notice = 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.';
const answer = 'Você, Marina, administra a loja; Caio participa da decisão.';

function memoryFixture(snapshot: Snapshot, id: string, existingConflict = false) {
 const { tenantId, brandId } = snapshot.tenant;
 const scope = { tenantId, brandId }, leadId = 'deterministic-memory-' + id;
 const profile: TrustedMessage = { ...scope, leadId, conversationId: leadId + '-conversation', id: id + '-profile', role: 'user',
  text: 'Sou Marina Teste. Quero abrir em Vila Aurora e administrar a loja pessoalmente. Meu irmão Caio participa da decisão comigo. Tenho R$ 260.000,50 de recursos próprios disponíveis.',
  createdAt: '2026-09-13T12:00:00.000Z' };
 const correction: TrustedMessage = { ...profile, id: id + '-correction', text: 'Corrigindo: a cidade é Vila Horizonte, não Vila Aurora. Quem vai administrar a loja e quem participa da decisão?', createdAt: '2026-09-13T12:01:00.000Z' };
 const proposed = (field: FactProposal['field'], value: FactProposal['value']): FactProposal => ({ field, value,
  evidence: { messageId: profile.id, quote: profile.text }, attribution: 'candidate', capitalOrigin: field === 'capital_available' ? 'own' : null, relationId: null, replacesFactId: null });
 const proposals = [proposed('name', { kind: 'text', text: 'Marina Teste' }), proposed('city', { kind: 'text', text: 'Vila Aurora' }),
  proposed('operating_role', { kind: 'text', text: 'Administrar pessoalmente' }), proposed('decision_role', { kind: 'text', text: 'Caio participa da decisão comigo' }),
  proposed('capital_available', { kind: 'number_range', min: 260000.5, max: 260000.5, unit: 'BRL' })];
 const original = mergeFactProposals(createLeadState(tenantId, brandId, leadId), proposals, [profile], profile.createdAt);
 const relation = RelationProposalSchema.parse({ id: id + '-caio', name: 'Caio', role: 'family', evidence: { messageId: profile.id, quote: profile.text } });
 assert.ok(hasTrustedEvidence(original, relation.evidence, [profile]));
 original.relations = [relation];
 const city = original.facts.find(fact => fact.field === 'city');assert.ok(city);
 const correctionProposal: FactProposal = { ...proposals[1], value: { kind: 'text', text: 'Vila Horizonte' },
  evidence: { messageId: correction.id, quote: correction.text }, replacesFactId: city.id };
 const conflicted = mergeFactProposals(original, [correctionProposal], [correction], correction.createdAt);
 const before = existingConflict ? conflicted : original;
 const after = existingConflict ? mergeFactProposals(before, [], [correction], correction.createdAt) : conflicted;
 assert.deepEqual(after.facts.slice(0, original.facts.length), original.facts, 'merge preserves original facts, timestamps and evidence');
 assert.equal(after.facts.at(-1)?.status, 'conflict');
 assert.equal(after.facts.at(-1)?.replacesFactId, city.id);
 assert.equal(after.facts.at(-1)?.confirmedBy, null);
 assert.equal(after.facts.at(-1)?.createdAt, correction.createdAt);
 assert.equal(deriveQualification(after, snapshot.tenant).priority, 'review');
 LeadStateSchema.parse(before);LeadStateSchema.parse(after);
 return { original, before, after, correctionProposal, existingConflict,
  input: { scope, profile, correction, proposals, correctionProposal, existingConflict,
   outputContract: snapshot.outputContract ?? 'legacy-v1', testedLayer: 'deterministic-memory-repair-not-financial-guard-or-model' } };
}

type MemoryFixture = ReturnType<typeof memoryFixture>;
function decision(fixture: MemoryFixture, bubbles: string[], nextAction: AgentDecision['nextAction'] = 'continue'): AgentDecision {
 return AgentDecisionSchema.parse({ bubbles, proposals: fixture.existingConflict ? [] : [fixture.correctionProposal], relations: fixture.original.relations,
  referral: null, sourceRefs: [], nextAction, handoffReason: nextAction === 'handoff' ? 'human_review' : nextAction === 'stop' ? 'opt_out' : null });
}
function repaired(fixture: MemoryFixture, reply: AgentDecision) {
 const unchanged = structuredClone({ reply, before: fixture.before, after: fixture.after });
 const result = reconcileMemoryReply(reply, fixture.before, fixture.after);
 AgentDecisionSchema.parse(result);
 assert.deepEqual({ reply, before: fixture.before, after: fixture.after }, unchanged, 'repair must not mutate memory or its input');
 assert.deepEqual({ ...result, bubbles: reply.bubbles }, reply, 'all non-text proposals, relations and controls are preserved');
 assert.deepEqual(reconcileMemoryReply(result, fixture.before, fixture.after), result, 'repair is idempotent');
 return { reply, result, omitted: [] as string[] };
}
function observation(fixture: MemoryFixture, results: ReturnType<typeof repaired>[]) {
 return { input: fixture.input, observed: { original: fixture.original, before: fixture.before, after: fixture.after, results } };
}

export const memoryCases: DeterministicCase[] = [{
 id: 'D22', fixture: 'Fresh scoped Marina/Caio profile, canonical city correction and four control intents; stop passes the real guard without collection; no provider or engine integration.',
 expected: 'Remove the recognized adoption promise, emit one honest pending-conflict notice, preserve independent answer, proposals and controls.',
 run(snapshot) {
  const fixture = memoryFixture(snapshot, 'D22');
  const correctionAt = fixture.input.correction.createdAt;assert.ok(correctionAt);
  const results = (['continue', 'nurture', 'handoff', 'stop'] as const).map(action => {
   const reply = decision(fixture, [notice + '\n\nPerfeito, obrigada pela correção: vou considerar Vila Horizonte.', answer], action);
   const guard = (value: AgentDecision) => guardFinancialDecision({ decision: { ...value, financialReply: null },
    tenant: snapshot.tenant, lead: fixture.before, sources: snapshot.sources, now: correctionAt,
    trustedMessages: [fixture.input.profile, fixture.input.correction], conversationId: fixture.input.correction.conversationId,
    latestMessageId: fixture.input.correction.id, latestMessage: fixture.input.correction.text });
   if (action === 'stop') {
    // Existing facts/relations stay in memory; stop must not propose collecting them again.
    reply.proposals = [];reply.relations = [];
    const beforeGuard = guard(reply);assert.ok(beforeGuard.ok, 'stop must reach repair through the real guard');
    const row = repaired(fixture, beforeGuard.decision);
    assert.deepEqual(row.result.bubbles, [notice, answer]);
    const afterGuard = guard(row.result);assert.ok(afterGuard.ok, 'repaired stop remains guard-valid');
    assert.deepEqual(afterGuard.decision, row.result);
    return { ...row, guards: { before: beforeGuard, after: afterGuard } };
   }
   const row = repaired(fixture, reply);
   assert.deepEqual(row.result.bubbles, [notice, answer]);
   return row;
  });
  const observed = observation(fixture, results);
  observed.input.testedLayer = 'deterministic-memory-repair-with-stop-guard-check-not-model-or-engine-integration';
  return observed;
 },
}, {
 id: 'D23', fixture: 'Existing scoped city conflict; honest negation followed by positive adoption in a separate sentence.',
 expected: 'Preserve the negation and independent answer; remove the positive adoption and retain the unresolved conflict.',
 run(snapshot) {
  const fixture = memoryFixture(snapshot, 'D23', true);
  const honest = 'Não vou considerar Vila Horizonte como cidade vigente antes da revisão.';
  const row = repaired(fixture, decision(fixture, [honest + ' Vou considerar Vila Horizonte.', answer]));
  assert.deepEqual(row.result.bubbles, [notice + '\n\n' + honest, answer]);
  const safe = repaired(fixture, decision(fixture, [honest, answer]));
  assert.deepEqual(safe.result, safe.reply, 'negation alone is not a positive adoption');
  return observation(fixture, [row, safe]);
 },
}, {
 id: 'D24', fixture: 'Existing scoped city conflict with a complete leading or trailing human-approval condition.',
 expected: 'Preserve both conditional formulations verbatim without recording human approval or resolving the conflict.',
 run(snapshot) {
  const fixture = memoryFixture(snapshot, 'D24', true);
  const results = ['Se a equipe aprovar a correção, vou considerar Vila Horizonte.',
   'Vou considerar Vila Horizonte somente se a equipe aprovar a correção.'].map(conditional => {
   const row = repaired(fixture, decision(fixture, [conditional, answer]));
   assert.deepEqual(row.result, row.reply);
   return row;
  });
  assert.equal(fixture.after.facts.filter(fact => fact.status === 'confirmed').length, 0);
  return observation(fixture, results);
 },
}, {
 id: 'D25', fixture: 'Existing scoped city conflict; a human-approval preface followed by immediate-use contradiction in the same sentence.',
 expected: 'Remove the contradictory sentence conservatively, retain the separate answer and honest notice, never resolve memory.',
 run(snapshot) {
  const fixture = memoryFixture(snapshot, 'D25', true);
  const unsafe = 'Se a equipe aprovar a correção, vou considerar Vila Horizonte, mas ela já será nossa referência a partir de agora.';
  const row = repaired(fixture, decision(fixture, [unsafe + ' ' + answer]));
  assert.deepEqual(row.result.bubbles, [notice + '\n\n' + answer]);
  assert.ok(!row.result.bubbles.join(' ').includes(unsafe));
  return observation(fixture, [row]);
 },
}, {
 id: 'D26', fixture: 'New scoped city conflict; long independent answer with a BRL amount and negation, plus short or overflowing follow-up.',
 expected: 'Preserve the independent answer whole within two 600-character bubbles; keep a fitting follow-up or explicitly record its complete conservative omission. This is not financial-guard approval.',
 run(snapshot) {
  const fixture = memoryFixture(snapshot, 'D26');
  const longAnswer = ('Não alterei o capital declarado de R$ 260.000,50. ' + answer + ' ' + 'Essa é a informação declarada por você. '.repeat(11)).trimEnd();
  assert.ok((notice + '\n\n' + longAnswer).length > 600, 'fixture must exercise notice separation');
  const shortQuestion = 'Quando você imagina a abertura?';
  const longQuestion = 'Antes de continuar, ' + 'considerando o que conversamos, '.repeat(4) + 'quando você imagina a abertura?';
  const results = [shortQuestion, longQuestion].map((question, index) => {
   const row = repaired(fixture, decision(fixture, ['Vou considerar Vila Horizonte. ' + longAnswer, question]));
   if (index === 0) {
    assert.deepEqual(row.result.bubbles, [notice, longAnswer + '\n\n' + question]);
   } else {
    assert.ok((longAnswer + '\n\n' + question).length > 600, 'fixture must require complete omission rather than clipping');
    assert.deepEqual(row.result.bubbles, [notice, longAnswer]);
    row.omitted = [question];
   }
   return row;
  });
  return observation(fixture, results);
 },
}];
