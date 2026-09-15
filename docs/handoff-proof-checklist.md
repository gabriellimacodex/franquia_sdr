# Prova Handoff / Resume (obrigatória antes de abrir envio)

Pré-condições: Functions deployed, workflow draft, trigger **ainda inativo**, `CHANNEL_ENABLED=false`, `NATIVE_CONTROL_VERIFIED=false`.

## Objetivo

Confirmar na conta Kapso real:

1. Evento nativo de Handoff é reconhecido pelo matcher.
2. Resume humano no Inbox não reenvia resposta antiga.
3. Nenhuma mensagem escapa após pausa entre autorização e Send Text.

## Como capturar (sem ativar o trigger Sapore)

Usar o Inbox do número `1052683654599692` com uma conversa de testador da allowlist.

1. Abrir conversa no Inbox Kapso.  
2. Acionar **Handoff** nativo.  
3. Em seguida **Resume**.  
4. Baixar/inspecionar a execução:  
   `GET /platform/v1/workflow_executions/{executionId}`  
   e a lista de eventos.  
5. Anotar: `event_type`, `payload.status`, `payload.reason`, `event id`, timestamps.

## Critério de aceite

- Matcher em `integrations/kapso/control-contract.ts` / Function `sapore-session` reconhece o Resume humano **sem** copiar nomes do teste sintético.  
- Se o evento real usar nomes diferentes, configurar no backend e na Function:  
  `KAPSO_HUMAN_RESUME_EVENT_TYPE` e `KAPSO_HUMAN_RESUME_REASON` (iguais nos dois lados).  
- Só então `NATIVE_CONTROL_VERIFIED=true`.

## Depois da prova (ainda com autorização explícita)

1. SQL/publisher: `responsible_user_id` + testers aplicados.  
2. Ativar trigger inbound (`active=true`) **somente** neste workflow.  
3. `CHANNEL_ENABLED=true` no `runtime.env` + recreate api/worker.  
4. Um ping para testador da allowlist.  
5. Validar opt-out e handoff humano.

## Não fazer

- Ativar trigger antes da prova.  
- Abrir anúncio / lead real.  
- Colar secrets no chat.
