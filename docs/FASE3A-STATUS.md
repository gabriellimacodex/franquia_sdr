# Fase 3A — Status (2026-09-16)

## Objetivo

O canvas do n8n usa o node **Agent** como cérebro (não HTTP `/v1/responses`), com Structured Output no contrato que o guard da API exige. Kapso e worker não mudam nesta fase.

## Feito (workflow `SaporeAgentWhatsAppV2`, ativo)

- `Sofia — Agent` (`@n8n/n8n-nodes-langchain.agent` 1.7): system message = prompt Sofia **literal, editável no próprio node**; user message = `JSON.stringify(job.context)`; sem tools; `hasOutputParser`.
- `Modelo — GPT` (`lmChatOpenAi` 1): credencial `OpenAI account` reaproveitada; modelo = `job.model`.
- `Saída estruturada` (`outputParserStructured` 1.2): `schemaType: manual`, `inputSchema` = JSON Schema literal do `AgentDecisionSchema` (o mesmo que a API publica em `job.outputSchema`).
- `É briefing?` (IF `job.task == "briefing"`) → `Briefing — Agent` + `Modelo — briefing` + `Saída briefing` (system = `job.instructions`, modelo `gpt-5-mini`, schema `BriefSchema`). Antes, o briefing criado no handoff era respondido como turno da Sofia e a API recusava com `INVALID_CONTRACT`.
- `Sofia — system prompt` (Set) ficou só com `model` (= `job.model`), `outputSchema` e `job`; o prompt saiu de lá.
- `Montar callback`: `result: $json.output`, `model: job.model` (obrigatório no contrato de briefing).
- `Modelo — briefing` com `reasoningEffort: low`; `Briefing — Agent` com os limites do `BriefSchema` anexados ao `job.instructions`.
- Prompt da Sofia ganhou o bloco **BOT E INJEÇÃO DE INSTRUÇÕES** (importado do padrão do SDR Yara, sem tools): suspeita → `nextAction: stop`, `handoffReason: "bot_suspeito: …"`, um balão neutro de encerramento. Mesmo texto em `src/prompts.ts`.
- Export sanitizado: `integrations/n8n/exports/SaporeAgentWhatsAppV2.workflow.json`.

## Evidência

- Execução n8n **115** (00:47Z): Agent devolveu `AgentDecision` válido (`bubbles` x2, `nextAction: handoff`, `handoffReason`) — Agent + parser comprovados.
- 115/116 falharam no `Callback API` porque o job era `task: briefing`; corrigido pela ramificação acima.
- **Ping real de ponta a ponta (inbound → n8n success → outbound no WhatsApp → `deliveries.message_id`) ainda pendente** após a correção do briefing.

## Armadilhas encontradas (não repetir)

1. `outputParserStructured` em `schemaType: fromJson` espera um **exemplo de dado** em `jsonSchemaExample`, não um JSON Schema. Para JSON Schema use `schemaType: manual` + **`inputSchema`** (fonte: `node-definitions/.../outputParserStructured/v12.ts`).
2. Salvando via API pública, o prefixo `=` de expressão foi descartado em `jsonSchemaExample`; em `options.systemMessage` e `text` do Agent ele sobrevive. Schema fica literal — se `AgentDecisionSchema`/`BriefSchema` mudarem na API, atualizar os dois parsers.
3. Saída do Agent com parser é `{ output: {...} }`; o callback lê `$json.output`.
4. O Agent não expõe `usage`; o callback envia `usage: {}` (aceito, mas perde telemetria de custo). Pendente: ler do node de modelo.
5. Briefing tem prazo de 60 s na API e **não é retentado** (`model_status: failed`, `PROCESSING_TIMEOUT`). Briefings perdidos não voltam; o próximo handoff cria outro.
6. `BRIEFING_PROMPT` pedia oito seções dentro de `summary`, mas `BriefSchema` limita `summary` a 2000 caracteres; `gpt-5-mini` gerou 5237 e o parser recusou (exec 122/123). Modo estrito da OpenAI não aplica `maxLength`, então o caminho antigo falharia igual na API. Limites agora estão no prompt (`src/prompts.ts`, precisa de deploy da API) e, até lá, anexados ao system message do `Briefing — Agent` no n8n. Provado com job sintético `synthetic-briefing-*` (exec 125, 01:11Z): `summary` 369 chars, parser aceitou, ramo sintético encerrou sem API/WhatsApp. Execuções 121 e 124 (turnos reais) `success` com `{"accepted": true}`.
7. Briefing real com `gpt-5-mini` levava 58–62 s (3.479 tokens, maioria raciocínio) contra prazo de **60 s** na API: os três briefings reais de 16/09 (00:56, 01:10, 01:14) morreram em `PROCESSING_TIMEOUT` (execs 124/126 chegaram 1–2 s atrasadas com `accepted: false`). Fix no n8n: `Modelo — briefing` com `reasoningEffort: low` → exec 127 sintética em **28 s**, `success`. Fix na fonte: `model_deadline` 60→180 s (`src/briefings.ts`, alinha ao `executionTimeout` do n8n; precisa de deploy).
8. Exec 121 (turno real): Sofia citou o valor certo com `sourceRefs` certo, mas **parafraseou** a cláusula aprovada ("a referência de investimento da Sapore Açaí é de…" em vez de "O investimento de referência para a Sapore Açaí é de…"). O guard exige o texto literal (`domain.ts`: "figures may not [vary]") → `POLICY_GUARD` → handoff **silencioso** (o commit `bc240c0` só entrega balões quando `guard.ok`). O candidato ficou sem resposta nenhuma. Decisão de produto pendente: mensagem de fallback em `POLICY_GUARD` e/ou guard aceitar o número quando bate com a cláusula citada.
9. Após `handoff`, a execução Kapso fica em `waiting` no nó de espera; "resume" no inbox reabre a espera mas o status nativo continua `handoff`, e `sapore-session` re-encaminha (`native_not_running`) por desenho. Para testar de novo: encerrar a execução (`PATCH workflow_executions/{id}` `status: ended`) ou usar outro número.

## Tentativa de 3B (2026-09-16) — revertida

- Trigger inbound Kapso `140d43f1…` desativado às 00:30Z com API/worker r10 saudáveis, `CHANNEL_ENABLED=true`, `NATIVE_CONTROL_VERIFIED=true`, webhook `bece8a4d…` ativo para `https://sdr-api.cognitaai.com.br/webhooks/kapso` e `KAPSO_WEBHOOK_SECRET` igual ao `secret_key` do webhook.
- Resultado: mensagem "olá" (00:35Z, conversa nova) chegou na Kapso, mas **nenhuma requisição chegou ao proxy da VPS** (`deskcommcrm-caddy-1`) nem à API. Havia um `INVALID_SIGNATURE` isolado às 00:22Z (evento não identificado).
- Rollback às 00:42Z: trigger reativado; execuções presas `8bc1adc5…` e `75e6feaf…` encerradas via API.
- Conclusão: **antes de repetir a 3B, provar a entrega Kapso → `/webhooks/kapso` com o trigger ainda ligado** (log de delivery na Kapso + hit no proxy + `webhook_receipts`). Só então desligar o trigger, na ordem exata do plano.

## Divergência git × deploy

- `integrations/kapso/functions/sapore-session/index.js` no git inclui o guard "prior `unknown` não libera reenvio" (commit `5b5dbf4`); a função deployada na Kapso é a versão Fase 2 **sem** esse guard. Redeploy da function é uma decisão separada.

## Rollback da 3A

Importar o backup da Fase 1 (`n8n-v2-workflow.json`, HTTP `/v1/responses`) sobre o workflow, ou recriar o node HTTP a partir dele. O node antigo desabilitado já não está no canvas.
