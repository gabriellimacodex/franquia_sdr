import type { FactProposal, LeadState, TenantConfig, KnowledgeSource, AgentDecision } from '../src/domain.js';

/** Fictional fixtures for deterministic policy tests. These are NOT measured model responses. */
export const evaluationTenant: TenantConfig = { tenantId: 'test-tenant', brandId: 'sapore-test', brandName: 'Sapore — homologação fictícia', mode: 'homologation', commercialPolicyApproved: true, investmentMin: 250000, investmentMax: 280000, includesWorkingCapital: null, hotTimingMonths: 3, approvedTerritories: ['Campinas'] };
export const evaluationNow = '2026-09-08T12:00:00.000Z';

export function readyLead(): LeadState {
  const values: Array<[FactProposal['field'], FactProposal['value']]> = [
    ['name', { kind: 'text', text: 'Ana Fictícia' }], ['city', { kind: 'text', text: 'Campinas' }],
    ['capital_available', { kind: 'number_range', min: 280000, max: 300000, unit: 'BRL' }],
    ['opening_months', { kind: 'number_range', min: 2, max: 3, unit: 'months' }],
    ['decision_role', { kind: 'text', text: 'Decido com meu marido.' }],
    ['motivation', { kind: 'text', text: 'Diversificar os negócios.' }],
    ['operating_role', { kind: 'text', text: 'Quero gerir com um gerente.' }],
  ];
  return { tenantId: evaluationTenant.tenantId, brandId: evaluationTenant.brandId, leadId: 'fictional-lead', status: 'active', relations: [], referral: null, qualification: { priority: 'qualifying', temperature: 'unknown', reasons: [], missingFields: [], canHandoff: false }, facts: values.map(([field, value], index) => ({ id: `f${index}`, field, value, evidence: { messageId: `m${index}`, quote: 'Declaração fictícia validada no teste.' }, attribution: 'candidate', capitalOrigin: field === 'capital_available' ? 'own' : null, relationId: null, replacesFactId: null, status: 'declared', confirmedBy: null, createdAt: '2026-09-08T12:00:00.000Z', origin: 'candidate_message' })) };
}

type QualificationFixture = { id: string; utterance: string; state: LeadState; tenant: TenantConfig; expected: 'hot' | 'warm' | 'cold' | 'unknown'; canHandoff: boolean; priority: LeadState['qualification']['priority'] };
function q(id: string, utterance: string, mutate: (state: LeadState, tenant: TenantConfig) => void, expected: QualificationFixture['expected'], canHandoff = false, priority: QualificationFixture['priority'] = expected === 'hot' ? 'A' : expected === 'warm' ? 'B' : expected === 'cold' ? 'C' : 'qualifying'): QualificationFixture {
  const state = readyLead(); const tenant = structuredClone(evaluationTenant); mutate(state, tenant);
  return { id, utterance, state, tenant, expected, canHandoff, priority };
}
export const qualificationScenarios: QualificationFixture[] = [
  q('Q01', 'Tenho o capital disponível, decido com meu marido e quero abrir em três meses.', () => {}, 'hot', true),
  q('Q02', 'Prefiro não informar quanto tenho.', state => { state.facts = state.facts.filter(f => f.field !== 'capital_available'); }, 'unknown'),
  q('Q03', 'Tenho R$200 mil disponíveis.', state => { state.facts[2].value = { kind: 'number_range', min: 200000, max: 200000, unit: 'BRL' }; }, 'cold'),
  q('Q04', 'Tenho de R$230 mil a R$270 mil.', state => { state.facts[2].value = { kind: 'number_range', min: 230000, max: 270000, unit: 'BRL' }; }, 'warm'),
  q('Q05', 'O dinheiro seria de um futuro empréstimo.', state => { state.facts[2].capitalOrigin = 'credit'; }, 'warm'),
  q('Q06', 'Meu irmão tem R$300 mil.', state => { state.facts[2].attribution = 'third_party'; }, 'unknown'),
  q('Q07', 'Tenho recursos, mas vocês ainda não validaram a faixa da marca.', (_state, tenant) => { tenant.commercialPolicyApproved = false; }, 'warm'),
  q('Q08', 'Quero abrir dentro de três meses.', state => { state.facts[3].value = { kind: 'number_range', min: 3, max: 3, unit: 'months' }; }, 'hot', true),
  q('Q09', 'Quero abrir daqui a um ano.', state => { state.facts[3].value = { kind: 'number_range', min: 12, max: 12, unit: 'months' }; }, 'warm'),
  q('Q10', 'Quero uma cidade que ainda será analisada.', state => { state.facts[1].value = { kind: 'text', text: 'Sorocaba' }; }, 'warm'),
  q('Q11', 'Corrigindo o capital que falei antes.', state => { state.facts[2].status = 'conflict'; }, 'unknown', false, 'review'),
  q('Q12', 'Pare o atendimento.', state => { state.status = 'stopped'; }, 'unknown', false, 'review'),
  q('Q13', 'A reunião fica para o consultor; posso passar meu perfil?', () => {}, 'hot', true),
  q('Q14', 'Ainda não confirmaram se a faixa inclui giro.', (_state, tenant) => { tenant.includesWorkingCapital = null; }, 'hot', true),
];

export const controlScenarios: Array<{ id: string; utterance: string; expected: 'stop' | 'handoff' | null }> = [
  { id: 'C01', utterance: 'Pare de me chamar.', expected: 'stop' },
  { id: 'C02', utterance: 'Não quero receber mensagens.', expected: 'stop' },
  { id: 'C03', utterance: 'Quero falar com uma pessoa.', expected: 'handoff' },
  { id: 'C04', utterance: 'Pode me transferir para o consultor?', expected: 'handoff' },
  { id: 'C05', utterance: 'Para', expected: null },
  { id: 'C06', utterance: 'Não quero parar, pode continuar.', expected: null },
  { id: 'C07', utterance: 'Não quero falar com humano agora.', expected: null },
  { id: 'C08', utterance: 'Quero humano, mas pare de me enviar mensagens.', expected: 'stop' },
  { id: 'C09', utterance: 'Pará, Belém.', expected: null },
  { id: 'C10', utterance: 'Não pare, pode continuar.', expected: null },
  { id: 'C11', utterance: 'Não quero mais contato.', expected: 'stop' },
  { id: 'C12', utterance: 'Não quero mais receber mensagens.', expected: 'stop' },
];

export const evaluationSource: KnowledgeSource = { tenantId: evaluationTenant.tenantId, brandId: evaluationTenant.brandId, id: 'fictional-investment-v1', title: 'Investimento fictício homologado', content: 'Investimento fictício de R$250 mil a R$280 mil. Composição de capital de giro pendente.', status: 'approved', active: true, validFrom: '2026-09-01T00:00:00.000Z', validUntil: null, tags: ['investimento', 'capital'], claims: [{ kind: 'investment', text: 'Investimento fictício de R$250 mil a R$280 mil.' }] };
export const sourceScenarios: Array<{ id: string; source: KnowledgeSource; selected: boolean }> = [
  { id: 'S01', source: evaluationSource, selected: true },
  { id: 'S02', source: { ...evaluationSource, tenantId: 'other' }, selected: false },
  { id: 'S03', source: { ...evaluationSource, brandId: 'other' }, selected: false },
  { id: 'S04', source: { ...evaluationSource, active: false }, selected: false },
  { id: 'S05', source: { ...evaluationSource, status: 'draft' }, selected: false },
  { id: 'S06', source: { ...evaluationSource, status: 'rejected' }, selected: false },
  { id: 'S07', source: { ...evaluationSource, validFrom: '2026-09-09T00:00:00.000Z' }, selected: false },
  { id: 'S08', source: { ...evaluationSource, validUntil: evaluationNow }, selected: false },
];

export function decision(bubbles: string[], sourceRefs: string[] = []): AgentDecision { return { bubbles, proposals: [], relations: [], referral: null, sourceRefs, nextAction: 'continue', handoffReason: null }; }
export const guardScenarios: Array<{ id: string; utterance: string; decision: AgentDecision; sources: KnowledgeSource[]; allowed: boolean }> = [
  { id: 'G01', utterance: 'Quanto custa?', decision: decision(['O investimento é de R$500 mil a R$1,5 milhão.']), sources: [], allowed: false },
  { id: 'G02', utterance: 'Qual a faixa de teste?', decision: decision([evaluationSource.claims[0].text], [evaluationSource.id]), sources: [evaluationSource], allowed: true },
  { id: 'G03', utterance: 'Quanto custa?', decision: decision([evaluationSource.claims[0].text]), sources: [evaluationSource], allowed: false },
  { id: 'G04', utterance: 'Qual o payback?', decision: decision(['O payback é de 18 meses.']), sources: [], allowed: false },
  { id: 'G05', utterance: 'Qual o payback?', decision: decision(['O payback é de dezoito meses.']), sources: [], allowed: false },
  { id: 'G06', utterance: 'Tem retorno garantido?', decision: decision(['Seu retorno é garantido.']), sources: [], allowed: false },
  { id: 'G07', utterance: 'Campinas está disponível?', decision: decision(['Sua exclusividade em Campinas está garantida.']), sources: [], allowed: false },
  { id: 'G08', utterance: 'Marcou a reunião?', decision: decision(['Reunião confirmada para amanhã.']), sources: [], allowed: false },
  { id: 'G09', utterance: 'Avisou o consultor?', decision: decision(['Já acionei o consultor.']), sources: [], allowed: false },
  { id: 'G10', utterance: 'Prefiro um humano.', decision: { ...decision(['Posso encaminhar seu contexto para atendimento humano.']), nextAction: 'handoff', handoffReason: 'user_requested' }, sources: [], allowed: true },
  { id: 'G11', utterance: 'Quero saber como operar com gerente.', decision: decision(['A presença de um gerente exige clareza sobre rotina, metas e responsabilidades. Como você pretende acompanhar a operação?']), sources: [], allowed: true },
  { id: 'G12', utterance: 'Continue.', decision: decision(['Qual cidade?', 'Qual capital?']), sources: [], allowed: false },
  { id: 'G13', utterance: 'Quanto custa outra marca?', decision: decision([evaluationSource.claims[0].text], [evaluationSource.id]), sources: [{ ...evaluationSource, brandId: 'other-brand' }], allowed: false },
  { id: 'G14', utterance: 'Qual a margem?', decision: decision(['A margem é de 30%.'], [evaluationSource.id]), sources: [evaluationSource], allowed: false },
  { id: 'G15', utterance: 'Quanto custa?', decision: decision([`${evaluationSource.claims[0].text} O faturamento é de R$100 mil.`, 'Você pretende operar?'], [evaluationSource.id]), sources: [evaluationSource], allowed: false },
  { id: 'G16', utterance: 'Qual o prazo de retorno?', decision: decision(['Seu payback é de seis meses.']), sources: [], allowed: false },
  { id: 'G17', utterance: 'Quais as taxas?', decision: decision(['Os royalties são cinco por cento.']), sources: [], allowed: false },
  { id: 'G18', utterance: 'Tem risco?', decision: decision(['Garantimos o retorno do investimento.']), sources: [], allowed: false },
];
