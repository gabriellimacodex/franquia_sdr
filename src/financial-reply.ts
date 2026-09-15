import { z } from 'zod';
import { AGENT_OUTPUT_JSON_SCHEMA, AgentDecisionSchema, EvidenceSchema, currentOwnCapitalCents, guardDecision, selectSources, type GuardInput, type GuardResult } from './domain.js';

export const FinancialDecisionSchema = AgentDecisionSchema.extend({
  financialReply: z.object({
    capitalEvidence: EvidenceSchema.nullable(),
    investmentSourceId: z.string().min(1).nullable(),
    followUp: z.enum(['none', 'experience', 'reserve']),
  }).strict().nullable(),
}).strict();

export const FINANCIAL_OUTPUT_JSON_SCHEMA = {
  ...AGENT_OUTPUT_JSON_SCHEMA,
  required: [...AGENT_OUTPUT_JSON_SCHEMA.required, 'financialReply'],
  properties: { ...AGENT_OUTPUT_JSON_SCHEMA.properties,
    financialReply: { anyOf: [{ type: 'object', additionalProperties: false,
      required: ['capitalEvidence', 'investmentSourceId', 'followUp'],
      properties: {
        capitalEvidence: { anyOf: [{ type: 'object', additionalProperties: false, required: ['messageId', 'quote'],
          properties: { messageId: { type: 'string', minLength: 1 }, quote: { type: 'string', minLength: 1, maxLength: 4000 } },
        }, { type: 'null' }] },
        investmentSourceId: { type: ['string', 'null'], minLength: 1 },
        followUp: { type: 'string', enum: ['none', 'experience', 'reserve'] },
      },
    }, { type: 'null' }] },
  },
};

function evidencedCapitalCents(input: GuardInput, evidence: z.infer<typeof EvidenceSchema>): number | null {
  const cents = currentOwnCapitalCents(input);
  const message = input.trustedMessages?.find(message => message.id === input.latestMessageId);
  if (cents === null || !message || evidence.messageId !== message.id || !message.text.includes(evidence.quote)) return null;
  const quotedCents = currentOwnCapitalCents({ ...input, trustedMessages: [{ ...message, text: evidence.quote }] });
  return quotedCents === cents ? cents : null;
}

/** A financial response is a complete server-rendered message, never a value substituted
 * into model prose. Candidate evidence does not license a price or coverage claim. */
export function guardFinancialDecision(input: GuardInput): GuardResult {
  const fail = (violation: string): GuardResult => {
    const rejected = guardDecision({ ...input, decision: null });
    if (rejected.ok) throw new Error('Invalid output must fail closed');
    return { ...rejected, violations: [violation] };
  };
  const parsed = FinancialDecisionSchema.safeParse(input.decision);
  if (!parsed.success) return fail('invalid_output_schema');
  const { financialReply, ...decision } = parsed.data;
  // A literal quote alone does not prove the model extracted the right amount or owner.
  // V2 currently supports only exact, current own-capital declarations; no inferred totals/giro.
  for (const proposal of decision.proposals) {
    const monetary = ['capital_available', 'investment_total', 'working_capital'].includes(proposal.field)
      || (proposal.value.kind === 'number_range' && proposal.value.unit === 'BRL');
    if (!monetary) continue;
    const cents = evidencedCapitalCents(input, proposal.evidence);
    if (cents === null || proposal.field !== 'capital_available' || proposal.attribution !== 'candidate'
      || proposal.capitalOrigin !== 'own' || proposal.relationId !== null || proposal.value.kind !== 'number_range'
      || proposal.value.unit !== 'BRL' || proposal.value.min !== cents / 100 || proposal.value.max !== cents / 100) {
      return fail('unsupported_financial_proposal');
    }
    if (proposal.replacesFactId !== null && !input.lead.facts.some(fact => fact.id === proposal.replacesFactId
      && ['declared', 'confirmed', 'conflict'].includes(fact.status) && fact.field === 'capital_available'
      && fact.attribution === 'candidate' && fact.capitalOrigin === 'own' && fact.relationId === null
      && fact.value.kind === 'number_range' && fact.value.unit === 'BRL')) return fail('invalid_financial_replacement');
  }
  // V2 never enables the legacy free-text capital exception.
  const base = guardDecision({ ...input, decision, trustedMessages: [] });
  if (!base.ok) return base;
  if (financialReply === null) {
    // The canonical message, not the model's choice of proposals/action, selects the safe path.
    if (currentOwnCapitalCents(input) === null) return base;
    if (decision.nextAction === 'continue' || decision.nextAction === 'nurture') return fail('structured_capital_reply_required');
    return { ok: true, decision: { ...base.decision, bubbles: [decision.nextAction === 'stop'
      ? 'Tudo bem. O atendimento automático será interrompido.'
      : 'O contexto ficará disponível para revisão da equipe. O atendimento automático será pausado.'] } };
  }
  if (decision.bubbles.length || decision.nextAction !== 'continue') return fail('financial_reply_mixed_with_prose_or_control');
  const parts: string[] = [];
  if (financialReply.capitalEvidence) {
    const cents = evidencedCapitalCents(input, financialReply.capitalEvidence);
    if (cents === null) return fail('untrusted_candidate_capital');
    const amount = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
    parts.push(`Você informou R$ ${amount} de recursos próprios disponíveis. Esse é um valor declarado por você, não o preço da franquia.`);
  }
  if (financialReply.investmentSourceId) {
    const matching = input.sources.filter(source => source?.id === financialReply.investmentSourceId);
    if (matching.length !== 1) return fail('ambiguous_investment_reference');
    const source = selectSources(matching, input.tenant.tenantId, input.tenant.brandId, input.now)
      .find(source => decision.sourceRefs.includes(source.id));
    const claims = source?.claims.filter(claim => claim.kind === 'investment') ?? [];
    if (claims.length !== 1) return fail('unapproved_investment_reference');
    parts.push(claims[0].text);
    if (input.tenant.includesWorkingCapital === null) parts.push('A composição desse valor, incluindo giro, taxa e implantação, ainda precisa de validação.');
  }
  if (!parts.length) return fail('empty_financial_reply');
  const bubbles = [parts.join(' ')];
  if (financialReply.followUp === 'experience') bubbles.push('Você já teve experiência com varejo, alimentação ou gestão de equipe?');
  if (financialReply.followUp === 'reserve') bubbles.push('Você pretende separar uma reserva para a operação, além do valor de implantação?');
  // Run all ordinary controls/promises/question checks on the final source + follow-up.
  // Only the fully server-authored candidate declaration is outside the commercial-number check.
  const nonCandidateParts = financialReply.capitalEvidence ? parts.slice(1) : parts;
  const finalGuard = guardDecision({ ...input, trustedMessages: [], decision: { ...decision,
    bubbles: [...(nonCandidateParts.length ? [nonCandidateParts.join(' ')] : []), ...bubbles.slice(1)],
  } });
  if (!finalGuard.ok) return finalGuard;
  const rendered = AgentDecisionSchema.safeParse({ ...decision, bubbles });
  return rendered.success ? { ok: true, decision: rendered.data } : fail('invalid_rendered_financial_reply');
}
