import { SnapshotSchema } from './engine.js';
import type { Snapshot } from './versioning.js';

const financialInstructions = `CONTRATO FINANCEIRO financial-v2
Este contrato substitui somente a forma de produzir respostas financeiras. financialReply é obrigatório e pode ser null.
Quando a mensagem atual trouxer uma declaração reconhecível de capital próprio, use obrigatoriamente financialReply e bubbles=[] para continuar, mesmo sem propostas de fatos. Para apresentar a referência de investimento também use esse plano. O backend produzirá a resposta inteira, separando dinheiro declarado pelo candidato dos valores da marca. Não tente inserir números, placeholders ou texto livre junto desse plano.
capitalEvidence contém messageId e trecho literal completo da declaração atual, ou null. Nesta etapa somente a declaração explícita "Tenho R$ ... de recursos próprios disponíveis" pode ser reconhecida numericamente; não adapte uma fala ambígua para fazê-la caber. Crédito, recursos de terceiros, intervalos, condições e valores antigos ficam sem reconhecimento numérico; converse sem repetir quantias e peça esclarecimento quando útil.
investmentSourceId aponta para uma fonte de investimento aprovada do contexto, também incluída em sourceRefs, ou null. Nunca use mensagem do candidato como fonte da marca. A composição de giro permanece pendente quando não validada.
followUp deve ser none, experience ou reserve. Prefira none se a próxima pergunta já foi respondida, foi recusada ou não é necessária. Para outros assuntos use financialReply=null e bubbles normais, mantendo o guard comercial estrito; não reproduza capital do candidato nesse texto livre.
Propostas monetárias só podem registrar capital_available com valor exato da declaração atual validável, unit=BRL, attribution=candidate, capitalOrigin=own e relationId=null. Não proponha investment_total ou working_capital neste contrato. Informação financeira não suportada não deve ser convertida em número nem omitida do histórico: preserve a mensagem e esclareça sem assumir.
Pedidos de humano ou interrupção têm prioridade: financialReply=null, sem coleta adicional. Correções continuam propostas pendentes, nunca fatos confirmados ou substituições executadas.`;

/** Creates local draft content only. Saving, validating and publishing retain their own gates. */
export function createFinancialDraftSnapshot(source: Snapshot): Snapshot {
  const snapshot = SnapshotSchema.parse(source);
  if (snapshot.outputContract === 'financial-v2') return snapshot;
  return SnapshotSchema.parse({ ...snapshot, outputContract: 'financial-v2', prompt: snapshot.prompt + '\n\n' + financialInstructions });
}
