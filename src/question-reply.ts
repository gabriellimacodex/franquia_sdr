import { AgentDecisionSchema, type GuardInput, type GuardResult } from './domain.js';
import { FinancialDecisionSchema } from './financial-reply.js';

export type QuestionGuardResult = {
  originalGuard: GuardResult;
  guard: GuardResult;
  repairCode: 'deferred_operating_question' | null;
};

/** A bounded presentation repair. The original model rejection remains available for audit. */
export function guardQuestionReply(input: GuardInput, guard: (input: GuardInput) => GuardResult, laboratory: boolean): QuestionGuardResult {
  const originalGuard = guard(input);
  const unchanged: QuestionGuardResult = { originalGuard, guard: originalGuard, repairCode: null };
  if (!laboratory || originalGuard.ok || originalGuard.violations.length !== 1
    || originalGuard.violations[0] !== 'multiple_questions' || input.lead.status !== 'active') return unchanged;
  const legacy = AgentDecisionSchema.safeParse(input.decision);
  const financial = FinancialDecisionSchema.safeParse(input.decision);
  const decision = legacy.success ? legacy.data
    : financial.success && financial.data.financialReply === null ? financial.data : null;
  // Never turn an unconfirmed interpretation (e.g. Osaso -> Osasco) into a saved fact.
  // New extractions require a separate, evidence-aware treatment; do not silently delete them.
  if (!decision || decision.nextAction !== 'continue' || decision.proposals.length
    || decision.relations.length || decision.referral !== null || decision.bubbles.length !== 2) return unchanged;
  if (decision.bubbles.some(bubble => !/^[^?]+\?$/.test(bubble.trim()) || /["“”‘’]|:\/\//.test(bubble))) return unchanged;
  const extraQuestion = decision.bubbles[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!/^(?:(?:pra|para) eu te orientar melhor, )?a operacao seria tocada por voce no dia a dia ou com um gestor\/parceiro\?$/.test(extraQuestion)) return unchanged;
  const repaired = guard({ ...input, decision: { ...decision, bubbles: [decision.bubbles[0]] } });
  return repaired.ok ? { originalGuard, guard: repaired, repairCode: 'deferred_operating_question' } : unchanged;
}
