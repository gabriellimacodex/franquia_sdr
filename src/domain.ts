import { z } from 'zod';
import { createHash } from 'node:crypto';

export const ScopeSchema = z.object({ tenantId: z.string().min(1), brandId: z.string().min(1) }).strict();
export const FactFieldSchema = z.enum(['name', 'city', 'state', 'model', 'motivation', 'experience', 'operating_role', 'capital_available', 'investment_total', 'working_capital', 'opening_months', 'decision_role', 'email', 'phone']);
export const FactValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('number_range'), min: z.number().finite().nonnegative(), max: z.number().finite().nonnegative().nullable(), unit: z.enum(['BRL', 'months', 'percent', 'count']) }).strict(),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }).strict(),
]).refine(value => value.kind !== 'number_range' || value.max === null || value.max >= value.min, 'Range maximum must not be below minimum');
export const EvidenceSchema = z.object({ messageId: z.string().min(1), quote: z.string().min(1).max(4000) }).strict();
export const FactProposalSchema = z.object({
  field: FactFieldSchema,
  value: FactValueSchema,
  evidence: EvidenceSchema,
  attribution: z.enum(['candidate', 'partner', 'third_party', 'unknown']),
  capitalOrigin: z.enum(['own', 'credit', 'asset_sale', 'family', 'mixed', 'unknown']).nullable(),
  relationId: z.string().nullable(),
  replacesFactId: z.string().nullable(),
}).strict();
export type FactProposal = z.infer<typeof FactProposalSchema>;
export const LeadFactSchema = FactProposalSchema.extend({
  id: z.string().min(1),
  status: z.enum(['declared', 'confirmed', 'conflict', 'superseded', 'rejected']),
  confirmedBy: z.string().nullable(),
  createdAt: z.string().datetime(), origin: z.literal('candidate_message'),
}).strict();
export type LeadFact = z.infer<typeof LeadFactSchema>;
export const RelationProposalSchema = z.object({
  id: z.string().min(1), name: z.string().nullable(), role: z.enum(['partner', 'spouse', 'family', 'manager', 'referrer', 'other']), evidence: EvidenceSchema,
}).strict();
export const ReferralProposalSchema = z.object({
  name: z.string().nullable(), contact: z.string().nullable(), permissionToContact: z.literal(false), evidence: EvidenceSchema,
}).strict();
export const QualificationSchema = z.object({
  priority: z.enum(['A', 'B', 'C', 'qualifying', 'review']),
  temperature: z.enum(['hot', 'warm', 'cold', 'unknown']),
  reasons: z.array(z.string()), missingFields: z.array(FactFieldSchema), canHandoff: z.boolean(),
}).strict();
export type Qualification = z.infer<typeof QualificationSchema>;
export const TenantConfigSchema = ScopeSchema.extend({
  brandName: z.string().min(1), mode: z.enum(['homologation', 'production']),
  commercialPolicyApproved: z.boolean(), investmentMin: z.number().nonnegative().nullable(), investmentMax: z.number().nonnegative().nullable(),
  includesWorkingCapital: z.boolean().nullable(), hotTimingMonths: z.number().positive(),
  approvedTerritories: z.array(z.string()),
}).strict();
export type TenantConfig = z.infer<typeof TenantConfigSchema>;
export const KnowledgeSourceSchema = ScopeSchema.extend({
  id: z.string().min(1), title: z.string().min(1), content: z.string(),
  status: z.enum(['draft', 'approved', 'rejected']), active: z.boolean(),
  validFrom: z.string().datetime(), validUntil: z.string().datetime().nullable(),
  tags: z.array(z.string()),
  claims: z.array(z.object({ kind: z.enum(['investment', 'working_capital', 'royalties', 'revenue', 'payback', 'margin', 'territory', 'general']), text: z.string().min(1) }).strict()),
}).strict();
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
export const LeadStateSchema = ScopeSchema.extend({
  leadId: z.string().min(1), facts: z.array(LeadFactSchema),
  relations: z.array(RelationProposalSchema), referral: ReferralProposalSchema.nullable(),
  status: z.enum(['active', 'handoff', 'stopped', 'nurture']),
  qualification: QualificationSchema,
}).strict();
export type LeadState = z.infer<typeof LeadStateSchema>;
export const AgentDecisionSchema = z.object({
  bubbles: z.array(z.string().min(1).max(600)).max(2),
  proposals: z.array(FactProposalSchema).max(30), relations: z.array(RelationProposalSchema).max(10),
  referral: ReferralProposalSchema.nullable(), sourceRefs: z.array(z.string()).max(5),
  nextAction: z.enum(['continue', 'handoff', 'stop', 'nurture']), handoffReason: z.string().nullable(),
}).strict();
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
const jsonObject = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const jsonString = { type: 'string' };
const jsonNullableString = { type: ['string', 'null'] };
const jsonEvidence = jsonObject({ messageId: jsonString, quote: jsonString });
const jsonValue = { anyOf: [
  jsonObject({ kind: { type: 'string', enum: ['text'] }, text: jsonString }),
  jsonObject({ kind: { type: 'string', enum: ['number_range'] }, min: { type: 'number', minimum: 0 }, max: { type: ['number', 'null'], minimum: 0 }, unit: { type: 'string', enum: ['BRL', 'months', 'percent', 'count'] } }),
  jsonObject({ kind: { type: 'string', enum: ['boolean'] }, value: { type: 'boolean' } }),
] };
export const AGENT_OUTPUT_JSON_SCHEMA = jsonObject({
  bubbles: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 600 }, maxItems: 2 },
  proposals: { type: 'array', maxItems: 30, items: jsonObject({ field: { type: 'string', enum: FactFieldSchema.options }, value: jsonValue, evidence: jsonEvidence, attribution: { type: 'string', enum: ['candidate', 'partner', 'third_party', 'unknown'] }, capitalOrigin: { type: ['string', 'null'], enum: ['own', 'credit', 'asset_sale', 'family', 'mixed', 'unknown', null] }, relationId: jsonNullableString, replacesFactId: jsonNullableString }) },
  relations: { type: 'array', maxItems: 10, items: jsonObject({ id: jsonString, name: jsonNullableString, role: { type: 'string', enum: ['partner', 'spouse', 'family', 'manager', 'referrer', 'other'] }, evidence: jsonEvidence }) },
  referral: { anyOf: [jsonObject({ name: jsonNullableString, contact: jsonNullableString, permissionToContact: { type: 'boolean', enum: [false] }, evidence: jsonEvidence }), { type: 'null' }] },
  sourceRefs: { type: 'array', maxItems: 5, items: jsonString },
  nextAction: { type: 'string', enum: ['continue', 'handoff', 'stop', 'nurture'] },
  handoffReason: jsonNullableString,
});
export interface TrustedMessage { id: string; tenantId: string; brandId: string; leadId: string; role: 'user' | 'assistant' | 'operator'; text: string; createdAt?: string; conversationId?: string }

export function createLeadState(tenantId: string, brandId: string, leadId: string): LeadState {
  return LeadStateSchema.parse({ tenantId, brandId, leadId, facts: [], relations: [], referral: null, status: 'active', qualification: { priority: 'qualifying', temperature: 'unknown', reasons: [], missingFields: [], canHandoff: false } });
}

export function hasTrustedEvidence(state: LeadState, evidence: z.infer<typeof EvidenceSchema>, messages: TrustedMessage[]): boolean {
  return messages.some(message => message.id === evidence.messageId && message.tenantId === state.tenantId && message.brandId === state.brandId && message.leadId === state.leadId && message.role === 'user' && message.text.includes(evidence.quote));
}

export function mergeFactProposals(state: LeadState, proposals: FactProposal[], messages: TrustedMessage[], now = new Date().toISOString()): LeadState {
  const next = structuredClone(state);
  for (const raw of proposals) {
    const parsed = FactProposalSchema.safeParse(raw);
    if (!parsed.success || !hasTrustedEvidence(state, parsed.data.evidence, messages)) continue;
    const proposal = parsed.data;
    const id = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
    if (next.facts.some(fact => fact.id === id)) continue;
    const hasConflict = next.facts.some(fact => sameSubject(fact, proposal) && !['superseded', 'rejected'].includes(fact.status) && JSON.stringify(fact.value) !== JSON.stringify(proposal.value));
    next.facts.push({ ...structuredClone(proposal), id, status: hasConflict || proposal.replacesFactId !== null ? 'conflict' : 'declared', confirmedBy: null, origin: 'candidate_message', createdAt: messages.find(message => message.id === proposal.evidence.messageId)?.createdAt ?? now });
  }
  return next;
}

export type ConfirmFactResult = { ok: true; state: LeadState } | { ok: false; error: 'FACT_NOT_FOUND' | 'ACTOR_REQUIRED' | 'EXPLICIT_REPLACEMENT_REQUIRED' | 'INVALID_FACT_STATE' };
function sameSubject(a: FactProposal, b: FactProposal): boolean {
  const sameCapitalOrigin = a.field !== 'capital_available' || a.capitalOrigin === b.capitalOrigin;
  return a.field === b.field && a.attribution === b.attribution && a.relationId === b.relationId && sameCapitalOrigin;
}
/** Call only after authenticating a human operator. Never expose as an LLM tool. */
export function confirmFact(state: LeadState, factId: string, actorId: string, decision: 'accept' | 'replace' | 'reject'): ConfirmFactResult {
  if (!actorId.trim()) return { ok: false, error: 'ACTOR_REQUIRED' };
  const next = structuredClone(state);
  const fact = next.facts.find(item => item.id === factId);
  if (!fact) return { ok: false, error: 'FACT_NOT_FOUND' };
  if (['superseded', 'rejected'].includes(fact.status)) return { ok: false, error: 'INVALID_FACT_STATE' };
  if (decision === 'reject') { fact.status = 'rejected'; fact.confirmedBy = actorId; return { ok: true, state: next }; }
  const competing = next.facts.filter(item => item.id !== factId && sameSubject(item, fact) && !['superseded', 'rejected'].includes(item.status) && JSON.stringify(item.value) !== JSON.stringify(fact.value));
  if ((fact.status === 'conflict' || competing.length) && decision !== 'replace') return { ok: false, error: 'EXPLICIT_REPLACEMENT_REQUIRED' };
  if (decision === 'replace') {
    if (!fact.replacesFactId || !competing.some(item => item.id === fact.replacesFactId)) return { ok: false, error: 'EXPLICIT_REPLACEMENT_REQUIRED' };
    // Other unresolved alternatives must be reviewed individually rather than silently discarded.
    const previous = competing.find(item => item.id === fact.replacesFactId)!;
    previous.status = 'superseded';
  }
  fact.status = 'confirmed'; fact.confirmedBy = actorId;
  return { ok: true, state: next };
}

export function deriveQualification(state: LeadState, tenant: TenantConfig): Qualification {
  const required: z.infer<typeof FactFieldSchema>[] = ['city', 'capital_available', 'opening_months', 'decision_role', 'operating_role'];
  const declared = state.facts.filter(fact => ['declared', 'confirmed'].includes(fact.status) && fact.attribution === 'candidate');
  const missingFields = required.filter(field => !declared.some(fact => fact.field === field));
  const result: Qualification = { priority: 'qualifying', temperature: 'unknown', reasons: [], missingFields, canHandoff: false };
  const finish = (priority: Qualification['priority'], reason: string): Qualification => ({ ...result, priority, temperature: priority === 'A' ? 'hot' : priority === 'B' ? 'warm' : priority === 'C' ? 'cold' : 'unknown', reasons: [...result.reasons, reason], canHandoff: priority === 'A' });
  if (state.tenantId !== tenant.tenantId || state.brandId !== tenant.brandId) return finish('review', 'scope_mismatch');
  if (state.status === 'stopped' || state.status === 'handoff') return finish('review', 'human_or_stop_requested');
  if (state.facts.some(fact => fact.status === 'conflict')) return finish('review', 'unresolved_fact_conflict');
  if (tenant.investmentMin === null) return finish('review', 'investment_source_missing');
  if (!tenant.commercialPolicyApproved) return finish('B', 'commercial_policy_pending');
  if (tenant.includesWorkingCapital === null) result.reasons.push('working_capital_composition_unknown');
  const capital = declared.find(fact => fact.field === 'capital_available' && fact.capitalOrigin === 'own') ?? declared.find(fact => fact.field === 'capital_available');
  if (!capital || capital.value.kind !== 'number_range' || capital.value.unit !== 'BRL') return finish('qualifying', 'capital_not_declared');
  if (capital.capitalOrigin && ['credit', 'asset_sale', 'family'].includes(capital.capitalOrigin)) return finish('B', 'capital_availability_pending');
  if (capital.value.max !== null && capital.value.max < tenant.investmentMin) {
    const alternative = declared.some(fact => fact.field === 'capital_available' && fact.id !== capital.id && fact.capitalOrigin !== null && ['credit', 'asset_sale', 'family', 'mixed'].includes(fact.capitalOrigin));
    return finish(alternative ? 'B' : 'C', alternative ? 'alternative_capital_declared' : 'capital_below_reference_no_alternative_declared');
  }
  if (missingFields.length) return finish('qualifying', 'qualification_incomplete');
  if (capital.value.min < tenant.investmentMin) return finish('B', 'capital_interval_crosses_reference');
  const timing = declared.find(fact => fact.field === 'opening_months')!;
  if (timing.value.kind !== 'number_range' || timing.value.unit !== 'months') return finish('qualifying', 'timing_not_declared');
  if (timing.value.max === null || timing.value.max > tenant.hotTimingMonths) return finish('B', 'long_or_uncertain_timing');
  const city = declared.find(fact => fact.field === 'city')!;
  if (city.value.kind !== 'text' || !tenant.approvedTerritories.some(territory => normalizeText(territory) === normalizeText(city.value.kind === 'text' ? city.value.text : ''))) return finish('B', 'territory_pending_validation');
  return finish('A', 'declared_fit_for_human_review');
}

function normalizeText(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }

export function detectControlIntent(text: string): 'stop' | 'handoff' | null {
  const normalized = normalizeText(text).replace(/\bnao (pare|quero parar)\b/g, '');
  if (/\bnao quero (?:mais )?(?:contato|receber mensagens)\b/.test(normalized)) return 'stop';
  if (/\b(pare|stop|cancelar atendimento|remova meu contato|exclua meu contato)\b/.test(normalized) || /\b(nao quero receber|nao me (mande|envie|chame)|pare de|retire meu (numero|contato))\b/.test(normalized)) return 'stop';
  if (/\bnao (quero|preciso|desejo)\b[^.!?]{0,30}\b(humano|pessoa|consultor|atendente)\b/.test(normalized)) return null;
  if (/\b(quero|preciso|prefiro|falar|conversar)\b[^.!?]{0,45}\b(humano|pessoa|consultor|atendente)\b/.test(normalized) || /\b(me transfira|me transferir|transferir para)\b/.test(normalized)) return 'handoff';
  return null;
}
export function selectSources(sources: KnowledgeSource[], tenantId: string, brandId: string, now: string, query = ''): KnowledgeSource[] {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) return [];
  const tokens = [...new Set(normalizeText(query).match(/[a-z0-9]{3,}/g) ?? [])];
  return sources.flatMap(raw => {
    const parsed = KnowledgeSourceSchema.safeParse(raw);
    if (!parsed.success) return [];
    const source = parsed.data;
    if (source.tenantId !== tenantId || source.brandId !== brandId || !source.active || source.status !== 'approved' || Date.parse(source.validFrom) > timestamp || (source.validUntil !== null && Date.parse(source.validUntil) <= timestamp)) return [];
    const searchable = normalizeText(`${source.title} ${source.tags.join(' ')} ${source.content}`);
    return [{ source, relevance: tokens.filter(token => searchable.includes(token)).length }];
  }).sort((a, b) => b.relevance - a.relevance || a.source.id.localeCompare(b.source.id)).slice(0, 5).map(item => item.source);
}

export interface AgentContext { tenant: TenantConfig; lead: LeadState; sources: KnowledgeSource[]; qualification: Qualification; latestMessage: string; now: string }
export type BuildContextResult = { ok: true; context: AgentContext } | { ok: false; error: 'SCOPE_MISMATCH' };
export function buildAgentContext(input: { tenant: TenantConfig; lead: LeadState; sources: KnowledgeSource[]; now: string; latestMessage?: string }): BuildContextResult {
  if (input.tenant.tenantId !== input.lead.tenantId || input.tenant.brandId !== input.lead.brandId) return { ok: false, error: 'SCOPE_MISMATCH' };
  return { ok: true, context: { tenant: structuredClone(input.tenant), lead: structuredClone(input.lead), sources: selectSources(input.sources, input.tenant.tenantId, input.tenant.brandId, input.now, input.latestMessage), qualification: deriveQualification(input.lead, input.tenant), latestMessage: input.latestMessage ?? '', now: input.now } };
}
export interface ActionReceipt { tenantId: string; brandId: string; leadId: string; action: 'handoff' | 'material_sent'; status: 'succeeded'; id: string }
export interface GuardInput { decision: unknown; tenant: TenantConfig; lead: LeadState; sources: KnowledgeSource[]; now: string; latestMessage?: string; actionReceipts?: ActionReceipt[]; trustedMessages?: TrustedMessage[]; conversationId?: string; latestMessageId?: string }
export type GuardResult = { ok: true; decision: AgentDecision } | { ok: false; violations: string[]; safeDecision: AgentDecision };

const brlAmount='r\\$\\s*(?:\\d{1,3}(?:\\.\\d{3})+|\\d+)(?:,\\d{1,2})?(?:\\s+mil)?';
const capitalAmount=`(?:${brlAmount}|\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d{1,3}(?:\\.\\d{3})*\\s+mil|\\d{1,3}k)\\b`;
function brlCents(value:string):number|null {
  const normalized=value.replace(/^r\$\s*/,'').replace(/\./g,'').trim();
  const thousands=/\s*mil$/.test(normalized)||/k$/.test(normalized);
  const [integer,fraction='']=normalized.replace(/\s*mil$/,'').replace(/k$/,'').split(',');
  const cents=(Number(integer)*100+Number(fraction.padEnd(2,'0')))*(thousands?1000:1);
  return Number.isSafeInteger(cents)&&cents>=0?cents:null;
}
export function currentOwnCapitalCents(input:GuardInput):number|null {
  if(!input.conversationId||!input.latestMessageId)return null;
  const messages=(input.trustedMessages??[]).filter(message=>message.id===input.latestMessageId);
  if(messages.length!==1)return null;
  const message=messages[0];
  if(message.role!=='user'||message.tenantId!==input.lead.tenantId||message.brandId!==input.lead.brandId||message.leadId!==input.lead.leadId||message.conversationId!==input.conversationId)return null;
  // Only this job's explicit, affirmative declaration of available own resources is eligible.
  // Historical facts, model proposals, third-party money and implied availability are not evidence here.
  const text=normalizeText(message.text);
  if(/\b(credito|emprestimo|emprestado|emprestada|financiamento|corrigindo|pertence|pertencem)\b|\bna verdade\b|\bnao (tenho|possuo|sao|estao|e meu|e proprio)\b/.test(text))return null;
  const canonical=new RegExp(`^(?:eu )?tenho (?<amount>${brlAmount}) de recursos proprios disponiveis(?: e pretendo abrir em (?:\\d{1,2}|um|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze) meses)?(?:\\.(?:\\s|$)|$)`);
  const canonicalAmount=canonical.exec(text)?.groups?.amount;
  if(canonicalAmount&&(text.match(/r\$/g)??[]).length===1) return brlCents(canonicalAmount);
  // Informal WhatsApp declarations, anchored at the start so prompt-injection prefixes cannot unlock the echo.
  const informal=new RegExp(`^(?:eu )?(?:estou cmo|estou com|tenho|possuo|disponho de) (?<amount>${capitalAmount})(?:\\s+(?:de )?(?:recursos? )?(?:proprios? )?(?:disponiveis?)?)?(?:\\s+para (?:esse |o )?projeto)?(?:[.!]|$)`);
  const informalAmount=informal.exec(text)?.groups?.amount;
  return informalAmount?brlCents(informalAmount):null;
}
const brandPriceClaim=/\b(franquia custa|investimento custa|investimento (e|da|de )|preco (aprovado|da)|cobre .{0,30}giro|inclui capital de giro|voce ja cobre|seus recursos cobrem|preco aprovado)\b/;
function maskCandidateCapitalEcho(text:string,capital:number|null):string {
  if(capital===null)return text;
  // Recap of the candidate's own declared amount is not a brand price. Keep digits when a
  // brand-price sentence in this bubble still uses that amount as if it were the franchise price.
  return text.replace(new RegExp(capitalAmount,'g'),(amount,offset:number)=>{
    if(brlCents(amount)!==capital)return amount;
    const from=Math.max(0,...['.','!','?'].map(sep=>{const i=text.lastIndexOf(sep,offset);return i<0?0:i+1;}));
    const to=Math.min(...['.','!','?'].map(sep=>{const i=text.indexOf(sep,offset);return i<0?text.length:i+1;}));
    if(brandPriceClaim.test(text.slice(from,to))||brandPriceClaim.test(text.slice(0,offset))) return amount;
    return ' ';
  });
}
export function guardDecision(input: GuardInput): GuardResult {
  const parsed = AgentDecisionSchema.safeParse(input.decision);
  const violations: string[] = [];
  const control = input.lead.status === 'stopped' ? 'stop' : detectControlIntent(input.latestMessage ?? '');
  const safeDecision: AgentDecision = { bubbles: control === 'stop' ? ['Tudo bem. O atendimento automático será interrompido.'] : ['Esse ponto precisa de revisão da equipe. Posso encaminhar o contexto para atendimento humano.'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: control === 'stop' ? 'stop' : 'handoff', handoffReason: control === 'stop' ? null : 'response_requires_review' };
  if (!parsed.success) return { ok: false, violations: ['invalid_output_schema'], safeDecision };
  const decision = parsed.data;
  if (input.tenant.tenantId !== input.lead.tenantId || input.tenant.brandId !== input.lead.brandId) violations.push('scope_mismatch');
  if (control === 'stop' && decision.nextAction !== 'stop') violations.push('stop_request_ignored');
  if (decision.nextAction === 'stop' && (decision.proposals.length || decision.relations.length || decision.referral || decision.bubbles.some(bubble => bubble.includes('?')))) violations.push('collection_after_stop');
  if (control === 'handoff' && decision.nextAction !== 'handoff') violations.push('handoff_request_ignored');
  if (input.lead.status === 'stopped' && decision.nextAction !== 'stop') violations.push('stopped_conversation');
  if (input.lead.status === 'handoff' && decision.nextAction !== 'handoff') violations.push('human_owns_conversation');
  if (decision.nextAction === 'handoff' && !decision.handoffReason?.trim()) violations.push('handoff_reason_missing');
  if (decision.bubbles.join(' ').split('?').length - 1 > 1) violations.push('multiple_questions');
  const sources = selectSources(input.sources, input.tenant.tenantId, input.tenant.brandId, input.now, input.latestMessage);
  if (decision.sourceRefs.some(id => !sources.some(source => source.id === id))) violations.push('unapproved_source_reference');
  const cited = sources.filter(source => decision.sourceRefs.includes(source.id));
  const receipts = (input.actionReceipts ?? []).filter(receipt => receipt.tenantId === input.tenant.tenantId && receipt.brandId === input.tenant.brandId && receipt.leadId === input.lead.leadId && receipt.status === 'succeeded' && receipt.id);
  const candidateCapital=currentOwnCapitalCents(input);
  for (const bubble of decision.bubbles) {
    const text = normalizeText(bubble);
    if (/(garantimos|garanto|asseguramos)[^.!?]{0,50}(retorno|rentabilidade|lucro|resultado|payback)/.test(text)) violations.push('return_guarantee');
    if (/(retorno|rentabilidade|lucro|resultado|payback)[^.!?]{0,50}(garantid|assegurad)|sem (nenhum )?risco/.test(text)) violations.push('return_guarantee');
    const territoryClaim = /(exclusividade|territorio|praca|cidade)[^.!?]{0,60}(garantid|reservad|aprovad|disponivel)|garant[^.!?]{0,30}(exclusividade|territorio|praca)/.test(text);
    if (territoryClaim && !cited.some(source => source.claims.some(claim => claim.kind === 'territory' && normalizeText(claim.text) === text))) violations.push('unsupported_territory_promise');
    if (/(reuniao|agenda|horario|convite)[^.!?]{0,35}(confirmad|agendad|criad|enviad)|agendei|marquei (a|sua) reuniao/.test(text)) violations.push('unavailable_scheduling_action');
    if (/(ja )?(acionei|avisei|notifiquei|transferi|encaminhei)|consultor (foi|esta) acionado/.test(text) && !receipts.some(receipt => receipt.action === 'handoff')) violations.push('unverified_handoff_action');
    if (/(enviei|enviado|enviada)[^.!?]{0,30}(material|apresentacao)|material[^.!?]{0,20}(enviado|enviada)/.test(text) && !receipts.some(receipt => receipt.action === 'material_sent')) violations.push('unverified_material_action');
    // Numerical commercial clauses must reproduce an approved claim exactly. This is deliberately
    // narrower than semantic entailment: surrounding conversational text may vary, figures may not.
    let unsupported = text;
    for (const source of cited) for (const claim of source.claims) unsupported = unsupported.split(normalizeText(claim.text)).join(' ');
    unsupported = maskCandidateCapitalEcho(unsupported,candidateCapital);
    const commercial = /r\$|\b(investimento|capital|giro|royalt|faturamento|margem|payback|retorno|lucro|rentabilidade|taxa)\b|%/.test(unsupported);
    const hasNumber = /\d|\b(dez|onze|doze|treze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta|quarenta|cinquenta|sessenta|cem|cento|duzentos|trezentos|quinhentos|mil|milhao|milhoes)\b/.test(unsupported);
    if (commercial && hasNumber) violations.push('unsupported_commercial_number');
    const smallWrittenNumber = /\b(dois|duas|tres|quatro|cinco|seis|sete|oito|nove)\b/.test(unsupported);
    if ((commercial || /\broyalties?\b/.test(unsupported)) && (smallWrittenNumber || hasNumber)) violations.push('unsupported_commercial_number');
  }
  if (violations.length) return { ok: false, violations: [...new Set(violations)], safeDecision };
  return { ok: true, decision };
}
