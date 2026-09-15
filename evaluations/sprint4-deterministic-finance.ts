import type { DeterministicCase } from './sprint4-deterministic.spec.js';
import assert from 'node:assert/strict';
import { createLeadState, mergeFactProposals, type FactProposal, type GuardInput, type KnowledgeSource, type TrustedMessage } from '../src/domain.js';
import { FinancialDecisionSchema, guardFinancialDecision } from '../src/financial-reply.js';
import type { Snapshot } from '../src/versioning.js';
import { snapshotHash } from '../src/versioning.js';
import { testDatabase } from '../tests/db-helper.js';
import { scoped } from '../src/database.js';
import { retrieveKnowledge } from '../src/knowledge.js';

const now = '2026-09-11T15:00:00.000Z';
function fixture(snapshot: Snapshot, id: string) {
  const lead = createLeadState(snapshot.tenant.tenantId, snapshot.tenant.brandId, id + '-candidate');
  const message: TrustedMessage = { tenantId: lead.tenantId, brandId: lead.brandId, leadId: lead.leadId,
    id: id + '-message', conversationId: id + '-conversation', role: 'user', createdAt: now,
    text: 'Tenho R$ 260 mil de recursos próprios disponíveis.' };
  const proposal: FactProposal = { field: 'capital_available', value: { kind: 'number_range', min: 260000, max: 260000, unit: 'BRL' },
    evidence: { messageId: message.id, quote: message.text }, attribution: 'candidate', capitalOrigin: 'own', relationId: null, replacesFactId: null };
  const decision = FinancialDecisionSchema.parse({ bubbles: [], proposals: [proposal], relations: [], referral: null,
    sourceRefs: [snapshot.sources[0].id], nextAction: 'continue', handoffReason: null,
    financialReply: { capitalEvidence: proposal.evidence, investmentSourceId: snapshot.sources[0].id, followUp: 'none' } });
  const input: GuardInput = { decision, tenant: structuredClone(snapshot.tenant), lead,
    sources: structuredClone(snapshot.sources), now, trustedMessages: [message], conversationId: message.conversationId,
    latestMessageId: message.id, latestMessage: message.text };
  return { input, decision, proposal, message, lead };
}
function rejected(input: GuardInput, code: string) {
  const before = structuredClone(input.lead), guard = guardFinancialDecision(input);
  assert.equal(guard.ok, false, JSON.stringify(guard));
  if (guard.ok) throw new Error('Expected guard rejection');
  assert.ok(guard.violations.includes(code), JSON.stringify(guard.violations));
  assert.deepEqual(guard.safeDecision.proposals, []);
  assert.doesNotMatch(guard.safeDecision.bubbles.join(' '), /R\$|260[. ]?000/);
  const memory = mergeFactProposals(input.lead, guard.safeDecision.proposals, input.trustedMessages ?? [], now);
  assert.deepEqual(memory, before); assert.deepEqual(input.lead, before);
  return { input, observed: { guard, memory } };
}
async function sourceExclusion(snapshot: Snapshot, id: string, changes: Partial<KnowledgeSource>, reason: string) {
  const altered = structuredClone(snapshot);
  Object.assign(altered.sources[0], changes);
  const db = await testDatabase(), source = altered.sources[0], scope = snapshot.tenant;
  try {
    await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$3)', [scope.tenantId, scope.brandId, scope.brandName]);
    await scoped(db, scope, async tx => {
      await tx.query('INSERT INTO sdr.versions(tenant_id,brand_id,id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$3,$4,$5,$6)',
        [scope.tenantId, scope.brandId, id, JSON.stringify(altered), snapshotHash(altered), snapshot.model]);
      // Deliberately stale/misleading index metadata must not override the canonical snapshot.
      await tx.query("INSERT INTO sdr.knowledge_chunks(tenant_id,brand_id,version_id,id,title,content,approved,active,valid_from,valid_until,metadata) VALUES($1,$2,$3,$4,$5,$6,true,true,'2020-01-01T00:00:00Z',NULL,$7)",
        [scope.tenantId, scope.brandId, id, source.id, source.title, source.content, JSON.stringify({ sourceId: source.id })]);
    });
    const indexed = (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM sdr.knowledge_chunks')).rows[0].count;
    assert.equal(indexed, 1);
    const retrieval = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, id, 'investimento capital giro', undefined, now));
    assert.deepEqual(retrieval.sources, []);
    if (reason === 'INVALID_SNAPSHOT') {
      assert.equal(retrieval.mode, 'unavailable'); assert.equal(retrieval.error, reason);
    } else {
      assert.equal(retrieval.mode, 'lexical');
      assert.deepEqual(retrieval.excludedSources.map(item => ({ id: item.id, reason: item.reason })), [{ id: source.id, reason }]);
    }
    const { input } = fixture(snapshot, id); input.sources = retrieval.sources;
    const observed = rejected(input, 'unapproved_source_reference').observed;
    const direct = rejected({ ...input, sources: altered.sources }, 'unapproved_source_reference').observed;
    return { input: { guardInput: input, canonicalSources: altered.sources, indexMetadata: { approved: true, active: true, validFrom: '2020-01-01T00:00:00.000Z', validUntil: null } },
      observed: { indexed, retrieval, ...observed, directGuard: direct.guard } };
  } finally { await db.close(); }
}

export const financeCases: DeterministicCase[] = [{
  id: 'D01', expected: 'Renderer separates candidate capital from the approved brand reference; merge creates one declared, evidenced fact.',
  fixture: 'Fictional current own-capital declaration; real financial guard and domain merge; no model.',
  run(snapshot) {
    const { input, lead, proposal, message } = fixture(snapshot, 'D01');
    const guard = guardFinancialDecision(input); assert.ok(guard.ok, JSON.stringify(guard));
    assert.deepEqual(guard.decision.bubbles, [
      'Você informou R$ 260.000,00 de recursos próprios disponíveis. Esse é um valor declarado por você, não o preço da franquia. '
      + snapshot.sources[0].claims[0].text + ' A composição desse valor, incluindo giro, taxa e implantação, ainda precisa de validação.',
    ]);
    const memory = mergeFactProposals(lead, guard.decision.proposals, [message], now);
    assert.equal(memory.facts.length, 1); assert.equal(memory.facts[0].status, 'declared');
    assert.equal(memory.facts[0].confirmedBy, null); assert.equal(memory.facts[0].origin, 'candidate_message');
    assert.equal(memory.facts[0].createdAt, message.createdAt);
    assert.deepEqual(memory.facts[0].evidence, proposal.evidence); assert.deepEqual(memory.facts[0].value, proposal.value);
    assert.deepEqual(lead.facts, []);
    return { input, observed: { guard, memory } };
  },
}, {
  id: 'D02', expected: 'Fabricated quotation is rejected without a monetary fact or public amount.',
  fixture: 'Current message exists, but the proposed quotation does not occur in it.',
  run(snapshot) {
    const { input, decision } = fixture(snapshot, 'D02');
    decision.proposals[0].evidence.quote = 'Tenho R$ 999 mil de recursos próprios disponíveis.';
    decision.financialReply!.capitalEvidence = { ...decision.proposals[0].evidence };
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D03', expected: 'A quotation attributed to a different canonical message cannot establish current capital.',
  fixture: 'An earlier message exists with the same text but a different ID; the proposal points to that ID.',
  run(snapshot) {
    const { input, decision, message } = fixture(snapshot, 'D03');
    const earlier = { ...message, id: 'D03-earlier', createdAt: '2026-09-10T12:00:00.000Z' };
    input.trustedMessages = [earlier, message];
    decision.proposals[0].evidence.messageId = earlier.id;
    decision.financialReply!.capitalEvidence = { ...decision.proposals[0].evidence };
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D04', expected: 'Foreign-tenant message cannot support capital or alter the current lead.',
  fixture: 'The current message ID and quotation collide, but the canonical message has another tenant.',
  run(snapshot) {
    const { input, message } = fixture(snapshot, 'D04'); message.tenantId = 'fictional-other-tenant';
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D05', expected: 'Foreign-brand message cannot support capital or alter the current lead.',
  fixture: 'Matching message ID and quotation in the same tenant but a different brand.',
  run(snapshot) {
    const { input, message } = fixture(snapshot, 'D05'); message.brandId = 'fictional-other-brand';
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D06', expected: 'Another candidate cannot supply evidence for this lead.',
  fixture: 'Matching tenant, brand, message ID and quotation but another canonical candidate ID.',
  run(snapshot) {
    const { input, message } = fixture(snapshot, 'D06'); message.leadId = 'fictional-other-candidate';
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D07', expected: 'The financial guard rejects evidence from another conversation before merge.',
  fixture: 'Same tenant, brand and candidate, but the canonical message belongs to another conversation.',
  run(snapshot) {
    const { input, message } = fixture(snapshot, 'D07'); message.conversationId = 'fictional-other-conversation';
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D08', expected: 'Assistant text cannot establish a candidate declaration.',
  fixture: 'Current ID, quotation and scope match, but the canonical message role is assistant.',
  run(snapshot) {
    const { input, message } = fixture(snapshot, 'D08'); message.role = 'assistant';
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D09', expected: 'An old monetary declaration is not released as current financial evidence.',
  fixture: 'Capital occurs only in the earlier turn; current message concerns operation, without money.',
  run(snapshot) {
    const { input, message } = fixture(snapshot, 'D09');
    message.createdAt = '2026-09-10T12:00:00.000Z';
    const current = { ...message, id: 'D09-current', createdAt: now, text: 'Quero trabalhar pessoalmente na operação.' };
    input.trustedMessages = [message, current]; input.latestMessageId = current.id; input.latestMessage = current.text;
    return rejected(input, 'unsupported_financial_proposal');
  },
}, {
  id: 'D11', expected: 'Expired canonical source is excluded by real retrieval and rejected by both guard entry paths.',
  fixture: 'Ephemeral PGlite; snapshot copy expires the source while the index falsely remains active and unexpired.',
  run: snapshot => sourceExclusion(snapshot, 'D11', { validUntil: '2026-09-11T14:59:59.000Z' }, 'expired'),
}, {
  id: 'D12', expected: 'Inactive canonical source is excluded by retrieval and cannot license a financial reply.',
  fixture: 'Ephemeral PGlite; snapshot copy disables the source while the index falsely remains active.',
  run: snapshot => sourceExclusion(snapshot, 'D12', { active: false }, 'disabled'),
}, {
  id: 'D13', expected: 'Unapproved canonical source is excluded by retrieval and cannot license a financial reply.',
  fixture: 'Ephemeral PGlite; source is draft in a snapshot copy while its index claims approval.',
  run: snapshot => sourceExclusion(snapshot, 'D13', { status: 'draft' }, 'unapproved'),
}, {
  id: 'D14', expected: 'Foreign tenant/brand source is never selected; a matching commercial amount does not authorize its use.',
  fixture: 'Ephemeral PGlite; copies independently adulterate source tenant and brand, retaining its ID and exact commercial claim.',
  async run(snapshot) {
    const tenant = await sourceExclusion(snapshot, 'D14-tenant', { tenantId: 'fictional-other-tenant' }, 'INVALID_SNAPSHOT');
    const brand = await sourceExclusion(snapshot, 'D14-brand', { brandId: 'fictional-other-brand' }, 'INVALID_SNAPSHOT');
    return { input: [tenant.input, brand.input], observed: [tenant.observed, brand.observed] };
  },
}, {
  id: 'D15', expected: 'Repeated eligible source ID is ambiguous even when both copies contain the approved amount.',
  fixture: 'Two independent copies of the same approved source are supplied in model context.',
  run(snapshot) {
    const { input } = fixture(snapshot, 'D15'); input.sources.push(structuredClone(input.sources[0]));
    return rejected(input, 'ambiguous_investment_reference');
  },
}, {
  id: 'D16', expected: 'Candidate capital cannot authorize an invented franchise price; fallback contains no monetary proposal.',
  fixture: 'The real current capital is repurposed as a price in model-authored prose, with a valid proposal and source ID.',
  run(snapshot) {
    const { input, decision } = fixture(snapshot, 'D16'); decision.financialReply = null;
    decision.bubbles = ['A franquia custa R$ 260 mil, exatamente o capital que você declarou.'];
    return rejected(input, 'unsupported_commercial_number');
  },
}, {
  id: 'D17', expected: 'An unsupported claim that declared capital covers working capital is rejected.',
  fixture: 'Model prose asserts coverage although the pinned brand source leaves the composition unvalidated.',
  run(snapshot) {
    const { input, decision } = fixture(snapshot, 'D17'); decision.financialReply = null;
    decision.bubbles = ['Seus R$ 260 mil cobrem a implantação e todo o capital de giro.'];
    return rejected(input, 'unsupported_commercial_number');
  },
}, {
  id: 'D18', expected: 'Literal credit/third-party messages cannot be extracted as the candidate own available capital.',
  fixture: 'Two fictional declarations with exact quotes; model falsely sets candidate ownership and own origin.',
  run(snapshot) {
    const attempts = [
      'Pretendo conseguir R$ 260 mil por empréstimo, mas o banco ainda não aprovou.',
      'Meu irmão tem R$ 260 mil, mas não prometeu investir no meu projeto.',
    ].map((text, index) => {
      const { input, message, decision } = fixture(snapshot, 'D18-' + index);
      message.text = text; input.latestMessage = text;
      decision.proposals[0].evidence.quote = text;
      decision.financialReply!.capitalEvidence = { ...decision.proposals[0].evidence };
      return rejected(input, 'unsupported_financial_proposal');
    });
    return { input: attempts.map(item => item.input), observed: attempts.map(item => item.observed) };
  },
}, {
  id: 'D19', expected: 'An exact quotation does not authorize a different extracted value or an invented total.',
  fixture: 'Current declared value is 260000 BRL; adversarial proposals substitute 300000 or double it to 520000.',
  run(snapshot) {
    const attempts = [300000, 520000].map(value => {
      const { input, decision } = fixture(snapshot, 'D19-' + value);
      decision.proposals[0].value = { kind: 'number_range', min: value, max: value, unit: 'BRL' };
      return rejected(input, 'unsupported_financial_proposal');
    });
    return { input: attempts.map(item => item.input), observed: attempts.map(item => item.observed) };
  },
}, {
  id: 'D20', expected: 'Compatible changed capital remains a new evidenced conflict; prior fact and timestamps remain unchanged.',
  fixture: 'Real merge creates an earlier declared 200000 BRL fact; current explicit 260000 BRL declaration references it as a correction.',
  run(snapshot) {
    const { input, lead, message, decision, proposal } = fixture(snapshot, 'D20');
    const earlier: TrustedMessage = { ...message, id: 'D20-earlier', createdAt: '2026-09-10T12:00:00.000Z', text: 'Tenho R$ 200 mil de recursos próprios disponíveis.' };
    const previousProposal: FactProposal = { ...proposal, value: { kind: 'number_range', min: 200000, max: 200000, unit: 'BRL' },
      evidence: { messageId: earlier.id, quote: earlier.text } };
    const before = mergeFactProposals(lead, [previousProposal], [earlier], now), preserved = structuredClone(before);
    assert.equal(before.facts[0].status, 'declared');
    decision.proposals[0].replacesFactId = before.facts[0].id;
    input.lead = before; input.trustedMessages = [earlier, message];
    const guard = guardFinancialDecision(input); assert.ok(guard.ok, JSON.stringify(guard));
    const memory = mergeFactProposals(before, guard.decision.proposals, input.trustedMessages, now);
    assert.equal(memory.facts.length, 2); assert.deepEqual(memory.facts[0], preserved.facts[0]);
    assert.equal(memory.facts[1].status, 'conflict'); assert.equal(memory.facts[1].confirmedBy, null);
    assert.equal(memory.facts[1].replacesFactId, before.facts[0].id); assert.equal(memory.facts[1].createdAt, message.createdAt);
    assert.deepEqual(memory.facts[1].evidence, proposal.evidence); assert.deepEqual(memory.facts[1].value, proposal.value);
    assert.deepEqual(before, preserved); assert.ok(memory.facts.every(fact => !['confirmed', 'superseded'].includes(fact.status)));
    return { input, observed: { guard, memory } };
  },
}, {
  id: 'D21', expected: 'Replacement of an incompatible or foreign-candidate fact is rejected before merge; all existing facts remain unchanged.',
  fixture: 'Separate wrong-field and foreign-candidate targets, created by real domain merge from fictional canonical messages.',
  run(snapshot) {
    const attempts = ['incompatible', 'foreign-candidate'].map(kind => {
      const { input, lead, message, decision, proposal } = fixture(snapshot, 'D21-' + kind);
      const earlier: TrustedMessage = { ...message, id: message.id + '-earlier', createdAt: '2026-09-10T12:00:00.000Z',
        text: kind === 'incompatible' ? 'Vou trabalhar pessoalmente na operação.' : 'Tenho R$ 200 mil de recursos próprios disponíveis.' };
      let targetLead = lead;
      let targetProposal: FactProposal;
      if (kind === 'incompatible') {
        targetProposal = { ...proposal, field: 'operating_role', value: { kind: 'text', text: 'operação pessoal' }, capitalOrigin: null,
          evidence: { messageId: earlier.id, quote: earlier.text } };
      } else {
        targetLead = createLeadState(lead.tenantId, lead.brandId, 'D21-foreign-owner'); earlier.leadId = targetLead.leadId;
        targetProposal = { ...proposal, value: { kind: 'number_range', min: 200000, max: 200000, unit: 'BRL' },
          evidence: { messageId: earlier.id, quote: earlier.text } };
      }
      const targetMemory = mergeFactProposals(targetLead, [targetProposal], [earlier], now), preserved = structuredClone(targetMemory);
      assert.equal(targetMemory.facts.length, 1);
      if (kind === 'incompatible') input.lead = targetMemory;
      decision.proposals[0].replacesFactId = targetMemory.facts[0].id;
      const result = rejected(input, 'invalid_financial_replacement');
      assert.deepEqual(targetMemory, preserved);
      return { input: { guardInput: input, replacementOwner: targetMemory }, observed: { ...result.observed, replacementOwnerAfter: targetMemory } };
    });
    return { input: attempts.map(item => item.input), observed: attempts.map(item => item.observed) };
  },
}];
