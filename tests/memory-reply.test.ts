import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDecisionSchema, createLeadState, mergeFactProposals, type AgentDecision, type FactProposal, type TrustedMessage } from '../src/domain.js';
import { reconcileMemoryReply } from '../src/memory-reply.js';

const original: TrustedMessage = { id: 'm1', tenantId: 't1', brandId: 'sapore', leadId: 'l1', role: 'user', text: 'Quero abrir em Vila Aurora.' };
const proposal: FactProposal = { field: 'city', value: { kind: 'text', text: 'Vila Aurora' }, evidence: { messageId: 'm1', quote: original.text }, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: null };
const before = mergeFactProposals(createLeadState('t1', 'sapore', 'l1'), [proposal], [original]);
const correction = { ...original, id: 'm2', text: 'Corrigindo: a cidade é Vila Horizonte, não Vila Aurora.' };
const correctionProposal: FactProposal = { ...proposal, value: { kind: 'text', text: 'Vila Horizonte' }, evidence: { messageId: 'm2', quote: correction.text }, replacesFactId: before.facts[0].id };
const after = mergeFactProposals(before, [correctionProposal], [correction]);
const reply: AgentDecision = { bubbles: ['Perfeito — atualizo para Vila Horizonte.', 'Você mesma pretende administrar a loja e seu irmão Caio participa da decisão; em quanto tempo pensa em abrir?'], proposals: [correctionProposal], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null };

test('a pending-conflict notice cannot be followed by a promise to use the disputed city', () => {
  const notice = 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.';
  const answer = 'Você mesma pretende administrar a loja e seu irmão Caio participa da decisão.';
  const generated = { ...reply, bubbles: [notice + '\n\nPerfeito, obrigada pela correção: vou considerar Vila Horizonte.', answer] };
  const unchanged = structuredClone({ generated, before, after });
  const result = reconcileMemoryReply(generated, before, after);
  assert.deepEqual(result.bubbles, [notice, answer]);
  assert.ok(AgentDecisionSchema.safeParse(result).success);
  assert.deepEqual({ ...result, bubbles: generated.bubbles }, generated);
  assert.deepEqual({ generated, before, after }, unchanged);
  assert.deepEqual(reconcileMemoryReply(result, before, after), result);
});

test('a negated promise stays intact without hiding a positive adoption in the next sentence', () => {
  const honest = 'Não vou considerar Vila Horizonte como cidade vigente antes da revisão.';
  const answer = 'Você administra a loja e Caio participa da decisão.';
  const generated = { ...reply, proposals: [], bubbles: [honest + ' Vou considerar Vila Horizonte.', answer] };
  const result = reconcileMemoryReply(generated, after, after);
  assert.ok(result.bubbles[0].includes(honest));
  assert.ok(!result.bubbles[0].includes(' Vou considerar Vila Horizonte.'));
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.equal(result.bubbles[1], answer);
  assert.deepEqual(reconcileMemoryReply({ ...generated, bubbles: [honest] }, after, after).bubbles, [honest]);
});

test('an explicit human-approval condition is not a promise to use the pending fact now', () => {
  const conditional = 'Se a equipe aprovar a correção, vou considerar Vila Horizonte.';
  const answer = 'Você administra a loja e Caio participa da decisão.';
  const generated = { ...reply, proposals: [], bubbles: [conditional, answer] };
  assert.deepEqual(reconcileMemoryReply(generated, after, after), generated);
  const mixed = { ...generated, bubbles: [conditional + ' Vou considerar Vila Horizonte.', answer] };
  const repaired = reconcileMemoryReply(mixed, after, after);
  assert.ok(repaired.bubbles[0].includes(conditional));
  assert.ok(!repaired.bubbles[0].includes(' Vou considerar Vila Horizonte.'));
  assert.equal(repaired.bubbles[1], answer);
});

test('future consideration is scoped to the disputed value, not other planning or a name prefix', () => {
  for (const text of [
    'Vou considerar seu prazo para conversar sobre a abertura em Vila Horizonte.',
    'Vamos considerar Caio na conversa sobre quem decide.',
    'Vou considerar Vila HorizonteNova como um exemplo fictício diferente.',
  ]) {
    const generated = { ...reply, proposals: [], bubbles: [text] };
    assert.deepEqual(reconcileMemoryReply(generated, after, after), generated);
  }
});

test('equivalent future-adoption verbs cannot make the conflicting value current', () => {
  const answer = 'Você, Marina, administra a loja e Caio participa da decisão.';
  for (const claim of [
    'Considerarei Vila Horizonte daqui em diante.',
    'Vou usar Vila Horizonte como sua cidade.',
    'Vamos adotar Vila Horizonte como a cidade informada.',
    'Passarei a considerar Vila Horizonte como cidade vigente.',
  ]) {
    const result = reconcileMemoryReply({ ...reply, proposals: [], bubbles: [claim + ' ' + answer] }, after, after);
    assert.ok(!result.bubbles.join(' ').includes(claim), claim);
    assert.ok(result.bubbles.join(' ').includes(answer));
    assert.match(result.bubbles[0], /registrada para revisão/);
    assert.ok(AgentDecisionSchema.safeParse(result).success);
  }
});

test('stop preserves its control intent but cannot promise to adopt a pending correction', () => {
  const stopped: AgentDecision = { ...reply, nextAction: 'stop', handoffReason: 'opt_out', bubbles: ['Vou considerar Vila Horizonte.', 'Tudo bem. O atendimento automático será interrompido.'] };
  const result = reconcileMemoryReply(stopped, before, after);
  assert.doesNotMatch(result.bubbles.join(' '), /Vou considerar/);
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.equal(result.bubbles[1], stopped.bubbles[1]);
  assert.equal(result.nextAction, 'stop');
  assert.equal(result.handoffReason, 'opt_out');
  assert.deepEqual(result.proposals, stopped.proposals);
  assert.ok(!result.bubbles.some(bubble => bubble.includes('?')), 'repair must not restart collection after stop');
});

test('a future promise about the new city is scoped to an unresolved city conflict', () => {
  const answer = 'Você administra a loja; Caio participa da decisão.';
  const generated = { ...reply, proposals: [], bubbles: ['Vamos usar a nova cidade daqui em diante. ' + answer] };
  const result = reconcileMemoryReply(generated, after, after);
  assert.doesNotMatch(result.bubbles.join(' '), /Vamos usar a nova cidade/);
  assert.ok(result.bubbles.join(' ').includes(answer));
  assert.match(result.bubbles[0], /registrada para revisão/);
  const otherConflict = { ...after, facts: after.facts.map(fact => fact.status === 'conflict' ? { ...fact, field: 'name' as const } : fact) };
  assert.deepEqual(reconcileMemoryReply(generated, otherConflict, otherConflict), generated);
  assert.deepEqual(reconcileMemoryReply(generated, before, before), generated);
});

test('future-adoption repair preserves repeated-conflict controls and their independent answer', () => {
  const answer = 'Você, Marina, administra a loja, e Caio participa da decisão.';
  for (const nextAction of ['continue', 'nurture', 'handoff', 'stop'] as const) {
    const generated: AgentDecision = { ...reply, proposals: [], nextAction, handoffReason: nextAction === 'handoff' ? 'human_review' : null, bubbles: [answer, 'Vamos considerar Vila Horizonte daqui em diante.'] };
    const unchanged = structuredClone({ generated, after });
    const result = reconcileMemoryReply(generated, after, after);
    assert.equal(result.bubbles[0], answer);
    assert.match(result.bubbles[1], /registrada para revisão/);
    assert.doesNotMatch(result.bubbles.join(' '), /Vamos considerar/);
    assert.deepEqual({ ...result, bubbles: generated.bubbles }, generated);
    assert.deepEqual({ generated, after }, unchanged);
    assert.deepEqual(reconcileMemoryReply(result, after, after), result);
  }
});

test('future-adoption repair keeps a bounded answer with its amount and negation intact', () => {
  const answer = ('Não alterei o capital declarado de R$ 260.000,50. Você, Marina, administra a loja; Caio participa da decisão. ' + 'Essa é a informação declarada por você. '.repeat(11)).trimEnd();
  const generated = { ...reply, bubbles: ['Vou considerar Vila Horizonte. ' + answer, 'Quando você imagina a abertura?'] };
  assert.ok(AgentDecisionSchema.safeParse(generated).success);
  const result = reconcileMemoryReply(generated, before, after);
  assert.ok(AgentDecisionSchema.safeParse(result).success);
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.ok(result.bubbles[1].startsWith(answer), 'never truncate the amount, negation or independent answer');
  assert.doesNotMatch(result.bubbles.join(' '), /Vou considerar/);
  assert.deepEqual(reconcileMemoryReply(result, before, after), result);
});

test('an explicit city referent before the disputed value cannot bypass future-adoption repair', () => {
  const answer = 'Você, Marina, administra a loja, e Caio participa da decisão.';
  const generated = { ...reply, proposals: [], bubbles: ['Vou considerar a cidade de Vila Horizonte daqui em diante. ' + answer] };
  const result = reconcileMemoryReply(generated, after, after);
  assert.doesNotMatch(result.bubbles.join(' '), /Vou considerar a cidade de Vila Horizonte/);
  assert.ok(result.bubbles.join(' ').includes(answer));
  assert.match(result.bubbles[0], /registrada para revisão/);
});

test('a complete trailing human-approval condition preserves the promise and independent answer', () => {
  const conditional = 'Vou considerar Vila Horizonte somente se a equipe aprovar a correção.';
  const answer = 'Você, Marina, administra a loja, e Caio participa da decisão.';
  const generated = { ...reply, proposals: [], bubbles: [conditional + ' ' + answer] };
  assert.deepEqual(reconcileMemoryReply(generated, after, after), generated);
  const mixed = { ...generated, bubbles: [conditional + ' Vou considerar Vila Horizonte. ' + answer] };
  const result = reconcileMemoryReply(mixed, after, after);
  assert.ok(result.bubbles[0].includes(conditional));
  assert.ok(result.bubbles[0].includes(answer));
  assert.ok(!result.bubbles[0].includes(' Vou considerar Vila Horizonte.'));
});

test('a human-approval preface cannot exempt an immediate-use contradiction in the same sentence', () => {
  const answer = 'Você, Marina, administra a loja, e Caio participa da decisão.';
  const unsafe = 'Se a equipe aprovar a correção, vou considerar Vila Horizonte, mas ela já será nossa referência a partir de agora.';
  const generated = { ...reply, proposals: [], bubbles: [unsafe + ' ' + answer] };
  const result = reconcileMemoryReply(generated, after, after);
  assert.ok(!result.bubbles.join(' ').includes(unsafe));
  assert.doesNotMatch(result.bubbles.join(' '), /nossa referência a partir de agora/);
  assert.ok(result.bubbles.join(' ').includes(answer));
  assert.match(result.bubbles[0], /registrada para revisão/);
});

test('a new conflict preserves an independent answer in the first bubble before the follow-up', () => {
  const answer = 'Você, Marina, vai administrar a loja, e seu irmão Caio participa da decisão.';
  const generated = { ...reply, bubbles: [answer, 'Quando você imagina a abertura?'] };
  const unchanged = structuredClone({ generated, before, after });
  const result = reconcileMemoryReply(generated, before, after);
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.ok(result.bubbles[0].includes(answer), 'the correction notice must not replace the factual answer');
  assert.equal(result.bubbles[1], generated.bubbles[1]);
  assert.deepEqual({ generated, before, after }, unchanged);
  assert.deepEqual({ ...result, bubbles: generated.bubbles }, generated);
});

test('overflow preserves the complete first answer within two bounded bubbles instead of cutting it', () => {
  const answer = 'Você, Marina, vai administrar a loja; Caio participa da decisão. ' + 'Essa é a informação declarada por você. '.repeat(12);
  const followUp = 'Antes de continuar, ' + 'considerando o que conversamos, '.repeat(4) + 'quando você imagina a abertura?';
  const generated = { ...reply, bubbles: [answer, followUp] };
  assert.ok(AgentDecisionSchema.safeParse(generated).success);
  const result = reconcileMemoryReply(generated, before, after);
  assert.ok(AgentDecisionSchema.safeParse(result).success, 'the notice must not exceed the output contract');
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.equal(result.bubbles[1], answer);
  assert.ok(!result.bubbles.join(' ').includes('quando você imagina'), 'drop the whole follow-up, never cut the answer');
});

test('a separate correction notice keeps both original bubbles when they fit together', () => {
  const answer = 'Você, Marina, administra a loja; Caio participa da decisão. ' + 'Essa é a informação declarada por você. '.repeat(12);
  const followUp = 'Quando você imagina a abertura?';
  const generated = { ...reply, bubbles: [answer, followUp] };
  const result = reconcileMemoryReply(generated, before, after);
  assert.ok(AgentDecisionSchema.safeParse(result).success);
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.equal(result.bubbles[1], answer + '\n\n' + followUp);
});

test('a mixed first bubble loses only the applied-correction sentence, not the independent answer', () => {
  const answer = 'Você, Marina, vai administrar a loja, e Caio participa da decisão.';
  const generated = { ...reply, bubbles: ['Atualizei a cidade para Vila Horizonte. ' + answer, 'Quando você imagina a abertura?'] };
  const result = reconcileMemoryReply(generated, before, after);
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.ok(result.bubbles[0].includes(answer));
  assert.doesNotMatch(result.bubbles.join(' '), /Atualizei/);
  assert.equal(result.bubbles[1], generated.bubbles[1]);
  assert.ok(AgentDecisionSchema.safeParse(result).success);
  assert.deepEqual(result.proposals, generated.proposals);
});

test('reconciling a repaired new-conflict reply again does not duplicate the notice or lose content', () => {
  const generated = { ...reply, bubbles: ['Você, Marina, administra a loja, e Caio participa da decisão.', 'Quando você imagina a abertura?'] };
  const once = reconcileMemoryReply(generated, before, after);
  assert.deepEqual(reconcileMemoryReply(once, before, after), once);
});

test('an existing canonical notice in the later bubble is emitted once without displacing the first answer', () => {
  const answer = 'Você, Marina, administra a loja, e Caio participa da decisão.';
  const notice = 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.';
  const generated = { ...reply, bubbles: [answer, notice] };
  const result = reconcileMemoryReply(generated, before, after);
  assert.equal(result.bubbles.join('\n\n').split(notice).length - 1, 1);
  assert.ok(result.bubbles.join('\n\n').includes(answer));
  assert.deepEqual(reconcileMemoryReply(result, before, after), result);
});

test('sentence repair preserves a negation and a quoted amount with thousands and decimal separators', () => {
  const independent = 'Não alterei o capital declarado de R$ 260.000,50. Você, Marina, vai administrar a loja.';
  const generated = { ...reply, bubbles: ['Atualizei a cidade para Vila Horizonte. ' + independent, 'Caio participa da decisão.'] };
  const result = reconcileMemoryReply(generated, before, after);
  assert.ok(result.bubbles[0].includes(independent), 'preserve the complete original sentences, including their negation and amount');
  assert.doesNotMatch(result.bubbles.join(' '), /Atualizei/);
  assert.equal(result.bubbles[1], generated.bubbles[1]);
  assert.ok(AgentDecisionSchema.safeParse(result).success);
});

test('a dependent applied-change confirmation cannot survive the removal of the preceding claim', () => {
  const answer = 'Você, Marina, opera a loja; Caio participa da decisão.';
  const generated = { ...reply, bubbles: ['Atualizei a cidade para Vila Horizonte. A alteração já está aplicada no cadastro. ' + answer] };
  const result = reconcileMemoryReply(generated, before, after);
  assert.doesNotMatch(result.bubbles.join(' '), /Atualizei|já está aplicada/);
  assert.ok(result.bubbles.join(' ').includes(answer));
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.ok(AgentDecisionSchema.safeParse(result).success);
  assert.deepEqual(after.facts.map(fact => fact.status), ['declared', 'conflict']);
});

test('a negated application statement stays intact while a following positive application is removed', () => {
  const honest = 'A alteração não foi aplicada; depende de revisão.';
  const answer = 'Você, Marina, administra a loja, e Caio participa da decisão.';
  const generated = { ...reply, bubbles: [honest + ' Apliquei o novo dado no cadastro. ' + answer] };
  const result = reconcileMemoryReply(generated, after, after);
  assert.ok(result.bubbles[0].includes(honest));
  assert.ok(result.bubbles[0].includes(answer));
  assert.doesNotMatch(result.bubbles.join(' '), /Apliquei/);
  assert.deepEqual(reconcileMemoryReply({ ...reply, bubbles: [honest] }, after, after).bubbles, [honest]);
});

test('a claim inseparable from the answer keeps the conservative fallback instead of extracting a clause', () => {
  const generated = { ...reply, bubbles: ['Atualizei a cidade para Vila Horizonte, e você, Marina, administra a loja.', 'Caio participa da decisão.'] };
  const result = reconcileMemoryReply(generated, before, after);
  assert.equal(result.bubbles[0], 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.');
  assert.equal(result.bubbles[1], generated.bubbles[1]);
  assert.deepEqual(result.proposals, generated.proposals);
});

test('a newly conflicting correction gets an honest acknowledgement without discarding the independent answer', () => {
  const result = reconcileMemoryReply(reply, before, after);
  assert.equal(result.bubbles[0], 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.');
  assert.equal(result.bubbles[1], reply.bubbles[1]);
  assert.deepEqual(result.proposals, reply.proposals);
  assert.equal(result.nextAction, 'continue');
  assert.deepEqual(after.facts.map(fact => fact.status), ['declared', 'conflict']);
  assert.equal(reply.bubbles[0], 'Perfeito — atualizo para Vila Horizonte.');
});

test('known applied-correction claims are replaced in any bubble, including later turns', () => {
  for (const claim of ['Já corrigi a cidade.', 'Atualizei seu cadastro.', 'Vou substituir pelo novo endereço.', 'Perfeito — ajustei esse dado.']) {
    const generated = { ...reply, proposals: [], bubbles: ['Obrigado.', claim] };
    const result = reconcileMemoryReply(generated, after, after);
    assert.deepEqual(result.bubbles, ['Obrigado.', 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.']);
  }
});

test('control decisions and a safe correction acknowledgement are not rewritten', () => {
  const safe = { ...reply, bubbles: ['A correção ainda não foi aplicada; está pendente de revisão.'] };
  assert.deepEqual(reconcileMemoryReply(safe, after, after), safe);
  for (const nextAction of ['stop', 'handoff'] as const) {
    const control = { ...reply, nextAction, bubbles: ['Tudo bem. O atendimento automático será interrompido.'] };
    assert.deepEqual(reconcileMemoryReply(control, before, after), control);
  }
  assert.deepEqual(reconcileMemoryReply(reply, before, before), reply);
});

test('a negated correction claim preserves its independent question without hiding a positive claim nearby', () => {
  const honest = { ...reply, proposals: [], bubbles: ['Ainda não atualizei seu cadastro; a correção depende de revisão. Em quanto tempo pensa em abrir?'] };
  assert.deepEqual(reconcileMemoryReply(honest, after, after), honest);
  const contradictory = { ...honest, bubbles: ['Atualizei a cidade. Não alterei o capital.'] };
  assert.match(reconcileMemoryReply(contradictory, after, after).bubbles[0], /registrada para revisão/);
});

test('handoff keeps its control intent but cannot claim that a pending correction was already applied', () => {
  const handoff: AgentDecision = { ...reply, nextAction: 'handoff', handoffReason: 'human_review', bubbles: ['Atualizei para Vila Horizonte.', 'Esse ponto precisa de revisão da equipe.'] };
  const result = reconcileMemoryReply(handoff, before, after);
  assert.match(result.bubbles[0], /registrada para revisão/);
  assert.equal(result.bubbles[1], handoff.bubbles[1]);
  assert.equal(result.nextAction, 'handoff');
  assert.equal(result.handoffReason, 'human_review');
});
