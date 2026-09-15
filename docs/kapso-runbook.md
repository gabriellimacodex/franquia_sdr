# Sapore SDR: Kapso + n8n piloto interno

Status: artefatos locais, sem deploy, sem ativação e sem alteração de workflows existentes. Escopo fixo: `1052683654599692` (Cognita-franquias), apenas testadores autorizados com dados fictícios. CRM e agenda não fazem parte desta versão.

## Responsabilidades

Kapso é o dono da sessão, dos botões nativos Handoff/Resume e do único envio WhatsApp. O backend persiste identidade, histórico, revisão do contexto, jobs, briefing e reserva de envio. O novo n8n recebe um job autenticado, responde 202 imediatamente, chama OpenAI e devolve uma decisão estruturada ao backend. `task=conversation` usa `gpt-5.4-2026-03-05` e callback `/internal/n8n/jobs/{id}/complete`; `task=briefing` usa `gpt-5-mini` e `/internal/n8n/briefings/{id}/complete`, sem resposta ao candidato. Não existe envio WhatsApp no n8n.

Fluxo: Decide/guard → job pendente → Wait 10s → guard; resposta pronta → autorização única → um Send Text → registrar tentativa → Wait 10s → guard de entrega. O guard verifica o turno enviado antes de processar uma nova entrada: sent permite continuar/esperar; unknown leva ao Handoff nativo. Ambos os Wait retornam ao guard. Handoff é a primeira condição/aresta do Decide, inclusive para fallback. Duas bolhas são unidas em uma única mensagem com linha em branco.

## Artefatos e configuração

- `integrations/kapso/functions/*/index.js`: três Functions privadas, handler Cloudflare-compatible.
- `integrations/kapso/artifacts.ts`: grafo draft sem triggers e payload separado de trigger desativado.
- `integrations/n8n/artifacts.ts`: novo workflow inativo, referências de credenciais obrigatórias.
- `integrations/n8n/nodes/*`: preparação do job e extração segura da resposta. O schema de domínio vem do backend, não é duplicado no workflow.

Function `sapore-session`: secrets `KAPSO_API_KEY`, `KAPSO_FUNCTION_TOKEN`; configuração `SAPORE_API_URL` (origem HTTPS do backend), `KAPSO_NATIVE_CONTROL_VERIFIED=false`. Após verificar um evento REAL de Resume humano, definir `KAPSO_HUMAN_RESUME_EVENT_TYPE` e `KAPSO_HUMAN_RESUME_REASON` igualmente na Function e no backend. Reason vazio corresponde somente a reason ausente/vazio, nunca a qualquer motivo. Não copiar nomes do teste sintético para produção. As outras duas Functions usam apenas `SAPORE_API_URL` e `KAPSO_FUNCTION_TOKEN`.

Backend: `PUBLIC_API_URL` deve ser a mesma origem; `CHANNEL_ENABLED=false` e `NATIVE_CONTROL_VERIFIED=false` até concluir os testes abaixo. n8n deve usar três credenciais previamente verificadas: inbound Header Auth `Authorization: Bearer N8N_WEBHOOK_TOKEN`, callback Header Auth `Authorization: Bearer N8N_CALLBACK_TOKEN` e credencial nativa `openAiApi`. Os valores secretos ficam somente no gerenciador de credenciais, nunca no JSON do workflow. Origem de callback é fixada na geração do artefato, não aceita destinos arbitrários do job.

Imprimir payloads locais (sem rede):

```sh
node --import tsx integrations/kapso/print-artifact.ts functions
node --import tsx integrations/kapso/print-artifact.ts workflow verified-function-ids.json
node --import tsx integrations/kapso/print-artifact.ts disabled-trigger
node --import tsx integrations/n8n/print-artifact.ts verified-n8n-references.json
```

`verified-function-ids.json` contém `{ "session": "UUID real", "dispatched": "UUID real", "handoff": "UUID real" }`. O arquivo n8n contém `{ "backendOrigin": "https://origem-real", "credentials": { "inbound": { "id": "id real", "name": "nome real" }, "callback": { "id": "id real", "name": "nome real" }, "openai": { "id": "id real", "name": "nome real" } } }`. São referências, não chaves. IDs exemplificativos nunca devem ser enviados à API.

Para um projeto CLI já vinculado, seguir source-sync `kapso pull`, preservar árvore/mapa existentes, incorporar as Functions novas e o grafo, `kapso build`, `kapso push --dry-run`. Este diretório não fabrica `.kapso/project.json`/remote-map nem se vincula à conta. O gerador Platform API é a alternativa explícita enquanto não há projeto CLI autenticado. Antes de qualquer upload, validar o grafo com `automate-whatsapp/scripts/validate-graph.js --definition-file arquivo.json`; warnings bloqueiam. Payload de create n8n via API pode exigir remover `active` do JSON importável; nunca chamar endpoint de ativação nesta fase.

## Leituras de pré-voo e controle

Todas as chamadas Kapso usam `X-API-Key`; não registrar cabeçalhos.

- `GET /platform/v1/whatsapp/phone_numbers/1052683654599692/webhooks`: inventariar consumidores.
- `GET /platform/v1/workflows` e `GET /platform/v1/workflows/{id}/triggers`: identificar todos os triggers ligados ao número e impedir respostas duplicadas. Não desligar automaticamente fluxos alheios.
- `GET /platform/v1/whatsapp/conversations/{conversationId}/flow_executions?limit=100`: resolver um único owner vivo deste workflow.
- `GET /platform/v1/workflow_executions/{executionId}`: verificar conversa, workflow, status e eventos. Backend repete leitura imediatamente antes da reserva de envio.
- `GET /meta/whatsapp/v24.0/1052683654599692/messages?conversation_id=...&limit=100&fields=kapso(direction,content,transcript,media_url,status,origin)`: recarregar últimos eventos do canal. Identidade canônica: `GET /platform/v1/whatsapp/contacts/{bsuid_ou_telefone}` → `data.id`.

A descoberta do owner falha fechada se não houver exatamente uma execução viva. Status waiting não significa stop. Um Resume humano novo só é reconciliado após ingerir mensagens humanas pendentes; o backend lê o evento nativo e persiste seu ID/horário verificados, ignorando horário informado pelo cliente. Handoff atrasado só é ignorado quando seu horário do provedor é estritamente anterior a um Resume nativo verificado da mesma execução, sob lock. Horários iguais, ausentes ou sem prova seguem Handoff. Stop exige novo consentimento explícito; nem Resume genérico nem Handoff de fallback o reabrem.

Um Resume humano novo, com fingerprint diferente, permite seguir após revisão de um envio unknown, mas preserva o registro antigo como unknown, limpa a referência pendente da Function e nunca o reenvia. Sem mensagem do candidato posterior ao horário nativo do Resume, o fluxo apenas espera. Esse comportamento não substitui a prova WAMID pendente de implementação.

## Limitações e teste obrigatório antes de liberar

O timeout documentado de Wait é no mínimo 10s. Timeout não altera last_user_input; nova mensagem cancela o timer. Por isso cada passagem recarrega as mensagens reais e usa WAMID, nunca a string antiga de last_user_input. Jobs têm deadline backend de 60s; timeout de HTTP OpenAI é 40s e execução n8n é 55s. Recusa, resposta incompleta, erro de schema, indisponibilidade ou falha no callback encerram n8n e o deadline backend transfere para humano; não fabricam uma resposta ao candidato.

A documentação pública não garante os nomes exatos dos eventos de Resume humano, o checkpoint de retomada, rearmamento de timer, nem cancelamento atômico de envio em curso. O helper `integrations/kapso/control-contract.ts` e a Function usam o mesmo seletor: último evento com ID que tenha `payload.status=handoff`, tipo exato `workflow.execution.handoff` ou tipo+reason de Resume humano configurados. Horários nativos iguais/ambíguos favorecem Handoff, não ordem lexicográfica de UUID como cronologia. Fingerprint é `executionId:eventId` (`initial` se nenhum). Resumes de timeout/user_input e transições running/waiting são ignorados. Esse contrato e o evento interno real de Handoff precisam ser validados na conta. Mantenha ambos os gates false até:

1. Capturar payload sintético real, estados e eventos antes/durante/depois de Handoff/Resume e confirmar o matcher explícito.
2. Assumir no Inbox durante modelo lento, durante polling, entre autorização e Send Text e imediatamente após Send Text. Nenhuma resposta ainda não despachada pode escapar após pausa. Mensagem já entregue ao provedor não pode ser recolhida; documentar esse limite.
3. Retomar somente no Inbox, confirmar que execução volta ao guard e recarrega histórico sem reenviar resposta anterior nem reentrar imediatamente em Handoff.
4. Testar duas mensagens rápidas, webhook duplicado/fora de ordem, reinício do backend, callback atrasado, Stop, mídia sem transcrição e operação só com BSUID.
5. Confirmar WAMID/origem de envio nativo em eventos reais e correlação de entrega. Sem correlação inequívoca: unknown + humano, nunca retry cego.
6. Confirmar que nenhum workflow legado responde ao número, credenciais pertencem à conta correta, responsável humano está definido e allowlist tem somente testadores fictícios.

Uma reserva de envio é compare-and-set: a segunda autorização recebe unknown. O checkpoint após Send Text registra tentativa, não sucesso. A API não documenta chave de idempotência para outbound; não tratar `biz_opaque_callback_data` como deduplicação. Há uma janela inevitável entre a última leitura e o envio nativo: o teste de controle nativo deve demonstrar sua interrupção; caso contrário, não ativar esta arquitetura.

## Webhooks, privacidade e operação

Validar HMAC-SHA256 dos bytes brutos em `X-Webhook-Signature`, deduplicar `X-Idempotency-Key` e WAMID, e retornar 200 rapidamente após persistência durável. O adapter recebe `X-Webhook-Event`, processa batches `{type,batch:true,data:[...]}`, resolve contato canônico e não cria jobs. Inbound é agrupado por conversa para uma única ingestão; consultas de contatos independentes têm concorrência máxima quatro e cache de promises somente durante o request. Isso evita uma consulta de identidade por mensagem, inclusive para contatos não autorizados. O objetivo de ACK abaixo de 10s ainda precisa ser medido com rede/banco reais e batch de 100 mensagens; não há garantia de latência sob indisponibilidade. Kapso pode repetir e desagrupar batches; ordem não é garantia. Transições sent/delivered/read são monotônicas sob lock, sem retrocesso em callbacks concorrentes. `verifyNativeSend` é um hook de prova ainda não configurado; sem ele só WAMIDs já conhecidos são confirmados. Texto igual e origin cloud_api não comprovam origem nativa. Nunca persistir conteúdo de contatos fora da allowlist. n8n não salva dados de execuções de sucesso/erro/manual por padrão; logs do backend só têm códigos e métricas sem texto, áudio ou secrets. Limpar dados do piloto conforme a política do projeto.

Rollback operacional: primeiro fechar gates de envio, preservar jobs/recibos unknown e usar Handoff nativo para conversas ativas; só alterar o trigger novo com autorização. Não apagar histórico nem retomar envios ambíguos.

## Referências oficiais

- [Function node](https://docs.kapso.ai/docs/flows/step-types/function-node), [Wait for response](https://docs.kapso.ai/docs/flows/step-types/wait-for-response-node), [Handoff](https://docs.kapso.ai/docs/flows/step-types/handoff-node).
- [Inbox automation](https://docs.kapso.ai/docs/platform/inbox/automation), [execução](https://docs.kapso.ai/api/platform/v1/functions/workflows/retrieve-workflow-execution), [execuções da conversa](https://docs.kapso.ai/api/platform/v1/functions/whatsapp-conversations/list-conversation-workflow-executions).
- [n8n Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook), [n8n HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
