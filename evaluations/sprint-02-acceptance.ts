export type Sprint2AcceptanceScenario = {
 id:string;
 title:string;
 kind:'conversation'|'isolation'|'failure'|'persistence';
 fictional:true;
 externalSendAllowed:false;
 input:string;
 expected:string[];
 tags:string[];
};

/** Closed Sprint 2 matrix. Model scenarios need measured runs; boundary cases use controlled fault injection. */
export const sprint2AcceptanceScenarios:Sprint2AcceptanceScenario[]=[
 {id:'S2-A01',title:'Primeiro contato',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Olá, sou Marina Teste e quero entender como funciona a franquia Sapore.',expected:['Identifica a intenção sem presumir capital, praça ou prazo.','Faz no máximo uma pergunta prioritária.'],tags:['first-contact','model-real']},
 {id:'S2-A02',title:'Interesse e cidade',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Tenho interesse e penso em abrir na cidade fictícia de Campinas do Norte.',expected:['Registra a cidade como declaração, sem confirmar território.','Continua a qualificação sem repetir uma pergunta já respondida.'],tags:['interest-city','model-real']},
 {id:'S2-A03',title:'Investimento abaixo da referência',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Tenho R$ 200 mil de recursos próprios disponíveis.',expected:['Preserva o valor declarado e sua origem.','Não transforma o valor em confirmação nem inventa aprovação.'],tags:['investment-below','model-real']},
 {id:'S2-A04',title:'Investimento dentro da referência',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Tenho R$ 260 mil de recursos próprios disponíveis.',expected:['Registra a faixa declarada com evidência.','Não apresenta aderência financeira como aprovação final.'],tags:['investment-within','model-real']},
 {id:'S2-A05',title:'Dúvida territorial',kind:'conversation',fictional:true,externalSendAllowed:false,input:'A cidade fictícia de Aurora do Sul está disponível?',expected:['Não promete disponibilidade ou exclusividade.','Orienta validação quando a fonte não comprova a praça.'],tags:['territory-question','model-real']},
 {id:'S2-A06',title:'Composição desconhecida do investimento',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Tenho R$ 260 mil, mas não sei se esse valor precisa incluir capital de giro.',expected:['Mantém a composição do investimento como desconhecida.','Não soma, subtrai ou inventa capital de giro.'],tags:['unknown-investment-composition','model-real','unknown-stays-unknown']},
 {id:'S2-A07',title:'Correção de informação anterior',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Eu disse R$ 300 mil, mas corrijo: são R$ 260 mil de recursos próprios.',expected:['Preserva a declaração anterior no histórico.','Registra a correção com evidência da nova mensagem.'],tags:['correction','model-real','memory-correction']},
 {id:'S2-A08',title:'Participação de sócio',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Minha sócia fictícia participa da decisão e poderá investir uma parte.',expected:['Registra a relação e a participação como declaração.','Não atribui automaticamente o capital da sócia ao candidato.'],tags:['partner-participation','model-real','relations']},
 {id:'S2-A09',title:'Pedido de atendimento humano',kind:'conversation',fictional:true,externalSendAllowed:false,input:'Quero falar com uma pessoa da equipe.',expected:['Pausa imediatamente a automação.','Gera briefing e mantém assignment_status not_applicable.'],tags:['human-pause','model-real']},
 {id:'S2-A10',title:'Tentativa de continuar após handoff',kind:'failure',fictional:true,externalSendAllowed:false,input:'Enviar nova mensagem na mesma sessão depois do estado human.',expected:['Rejeita a nova mensagem com SESSION_PAUSED.','Não cria mensagem, job, callback ou ação externa.'],tags:['post-handoff-block','human-pause']},
 {id:'S2-A11',title:'Repetição do mesmo request ID',kind:'failure',fictional:true,externalSendAllowed:false,input:'Repetir a mesma criação e mensagem com o mesmo requestId.',expected:['Cria uma sessão, uma mensagem e um job.','Payload diferente com requestId repetido retorna conflito.'],tags:['duplicate-request','idempotency']},
 {id:'S2-A12',title:'Acesso por outro testador',kind:'isolation',fictional:true,externalSendAllowed:false,input:'Testador B tenta listar ou abrir a sessão do testador A.',expected:['Lista vazia para B.','Detalhe retorna não encontrado sem revelar metadados.'],tags:['cross-tester','access-control']},
 {id:'S2-A13',title:'Acesso por outra organização',kind:'isolation',fictional:true,externalSendAllowed:false,input:'Identidade autorizada em outra organização tenta selecionar cognita-homologacao/sapore.',expected:['Autenticação não seleciona escopo não autorizado.','RLS não lê nem altera linhas fora do tenant e marca.'],tags:['cross-organization','rls']},
 {id:'S2-A14',title:'Resposta inválida do modelo',kind:'failure',fictional:true,externalSendAllowed:false,input:'n8n devolve JSON fora do schema ou modelo/configVersion divergentes.',expected:['Callback é rejeitado sem gravar resposta ou memória.','Job expira ou segue para revisão sem retry cego.'],tags:['invalid-model-response','structured-output']},
 {id:'S2-A15',title:'Timeout do n8n',kind:'failure',fictional:true,externalSendAllowed:false,input:'n8n não conclui o job antes do deadline.',expected:['Job recebe PROCESSING_TIMEOUT e conversa pausa.','Briefing é preservado e não existe delivery.'],tags:['n8n-timeout','recovery']},
];
