import type { AgentDecision, LeadState } from './domain.js';

const pendingCorrection = 'Recebi sua correção e ela ficou registrada para revisão da equipe. O dado anterior ainda não foi substituído.';

function claimsAppliedCorrection(text: string, conflicts: LeadState['facts']): boolean {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const claims = /\b(?:atualiz(?:o|ei|ado|ada|amos)|corrig(?:i|ido|ida|imos)|substitu(?:o|i|ido|ida|imos)|ajust(?:o|ei|ado|ada|amos)|alter(?:o|ei|ado|ada|amos)|aplic(?:o|amos|ado|ada|ados|adas)|apliquei|(?:vou|vamos)\s+(?:atualizar|corrigir|substituir|ajustar|alterar|aplicar))\b/g;
  const adopting = /\b(?:(?:vou|vamos)\s+(?:considerar|usar|adotar)|considerarei|passarei\s+a\s+considerar)\s+/g;
  return [...normalized.matchAll(claims)].some(match => !/\bnao\s+(?:(?:foi|foram|esta|estao|sera|serao)\s+)?$/.test(normalized.slice(0, match.index)))
    || [...normalized.matchAll(adopting)].some(match => !/\b(?:nao|nunca|jamais)\s+$/.test(normalized.slice(0, match.index))
      && conflicts.some(fact => {
        if (fact.value.kind !== 'text') return false;
        const value = fact.value.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        const following = normalized.slice(match.index + match[0].length);
        const target = fact.field === 'city' ? following.replace(/^a cidade de\s+/, '') : following;
        const referent = fact.field === 'city' && /^a nova cidade\b/.test(target) ? 'a nova cidade' : value;
        if (!referent.length || !target.startsWith(referent) || /^[\p{L}\p{N}_]/u.test(target.slice(referent.length))) return false;
        const remainder = target.slice(referent.length).trim();
        const conditionalPrefix = /^se a equipe aprovar a correcao,$/.test(normalized.slice(0, match.index).trim());
        return !(conditionalPrefix && /^[.!?]?$/.test(remainder))
          && !/^somente se a equipe aprovar a correcao[.!?]?$/.test(remainder);
      }));
}

/** Align acknowledgement with the committed memory; never resolve a conflict on the model's behalf. */
export function reconcileMemoryReply(decision: AgentDecision, before: LeadState, after: LeadState): AgentDecision {
  const previousIds = new Set(before.facts.map(fact => fact.id));
  const conflicts = after.facts.filter(fact => fact.status === 'conflict');
  if (!conflicts.length) return decision;
  const isNewConflict = decision.nextAction !== 'handoff' && decision.nextAction !== 'stop' && conflicts.some(fact => !previousIds.has(fact.id));
  let noticeAdded = false;
  const bubbles = decision.bubbles.flatMap((bubble, index) => {
    // Keep complete sentences verbatim, never split decimal/thousands separators or clauses.
    const sentences = [...new Intl.Segmenter('pt-BR', { granularity: 'sentence' }).segment(bubble)]
      .map(({ segment }) => ({ text: segment, applied: claimsAppliedCorrection(segment, conflicts) }));
    const applied = sentences.some(sentence => sentence.applied);
    const retained = applied ? sentences.filter(sentence => !sentence.applied).map(sentence => sentence.text).join('').trim() : bubble;
    if (retained === pendingCorrection || retained.startsWith(pendingCorrection + '\n\n')) {
      if (noticeAdded) {
        const withoutDuplicate = retained.slice(pendingCorrection.length).trim();
        return withoutDuplicate ? [withoutDuplicate] : [];
      }
      noticeAdded = true;
      return [retained];
    }
    if (((isNewConflict && index === 0) || applied) && !noticeAdded) {
      noticeAdded = true;
      const combined = [pendingCorrection, retained].filter(Boolean).join('\n\n');
      return combined.length <= 600 ? [combined] : [pendingCorrection, retained];
    }
    return retained ? [retained] : [];
  });
  if (isNewConflict && !noticeAdded) bubbles.push(pendingCorrection);
  const unique = [...new Set(bubbles)];
  if (unique.length > 2) {
    const combined = unique.slice(1).join('\n\n');
    // Preserve the earlier answer whole; omit a later bubble only if neither packing fits.
    if (combined.length <= 600) unique.splice(1, unique.length - 1, combined);
    else if ((unique[0] + '\n\n' + unique[1]).length <= 600) unique.splice(0, 2, unique[0] + '\n\n' + unique[1]);
  }
  return { ...decision, bubbles: unique.slice(0, 2) };
}
