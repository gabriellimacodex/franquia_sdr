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

## Deploy r11 (2026-09-16, 05:34Z)

- Migração `004_candidate_reset` aplicada pelo SQL Editor (coluna confirmada via `information_schema`), ledger registrado.
- Imagem `sapore-sdr:sprint5-media-20260916-r11` construída na release `/opt/sapore-sdr/releases/20260916T050550Z/sapore-sdr` (commit `6e1b3ef`; `src/` idêntico a `f751910`). Um `docker build` puro agora funciona: `Dockerfile` checa `tsconfig.docker.json` (código embarcado, sem `tests/`/`evaluations/`).
- Regressão dentro da imagem (Node 22, rede `none`): 580 na primeira rodada + 31/31 nos cinco arquivos que dependiam de `docs/`/`compose*.yaml` (montados) e da fixture de `turns` (corrigida em `f751910`). Local (Node 24): 585/585.
- Troca com zero jobs de WhatsApp ativos: `compose up -d` com `SAPORE_IMAGE=r11`, `runtime.env` e CA inalterados. `/health` e `/ready` 200; `CHANNEL_ENABLED=true`, `NATIVE_CONTROL_VERIFIED=true`, `RETENTION_ENABLED=false`. Rollback: mesmo comando com `sprint4-nat-send-20260915-r10` na release `20260914T043000Z`.
- Function Kapso `sapore-session` (`676ecedd…`) PATCH + deploy às 05:35:12Z com o código de `f751910` (mídia + guard anti-reenvio + `/deliver`). Backup do código anterior = git `bc240c0` (idêntico ao que estava em produção).
- Primeiro briefing real aceito pela API: exec n8n 128 (05:12Z, 29 s, `accepted: true`) — ainda na r10, com prazo de 60 s; r11 dá 180 s.

## r12 — um envio por balão (2026-09-16)

- `/internal/turns/:id/deliver` envia **um `sendText` por balão** (antes juntava com `\n\n` numa mensagem só). Cada WAMID é gravado como mensagem do agente (`Store.recordAgentMessage`) **antes** de confirmar, porque o histórico do provedor replica todo outbound como remetente desconhecido e um WAMID não reconhecido vira "humano assumiu" (`controlTx handoff`). `deliveries.message_id` guarda o primeiro WAMID; os demais vivem em `sdr.messages`.
- Falha no primeiro balão → `failApiSend` como antes; falha num balão posterior → confirma o que foi enviado e não reenvia (sem reenvio cego).
- Teste de rota cobre os dois envios, o registro dos WAMIDs e o replay do histórico sem pausa. O teste `sprint4-journal` "two real processes racing…" é flake de timing (falhou uma vez na suíte completa, 13/13 isolado duas vezes).

## Divergência git × deploy (histórico; resolvida pela r11)

- `integrations/kapso/functions/sapore-session/index.js` no git inclui o guard "prior `unknown` não libera reenvio" (commit `5b5dbf4`); a função deployada na Kapso é a versão Fase 2 **sem** esse guard. Redeploy da function é uma decisão separada.
- API (imagem r10 em produção) ainda **não** contém: limites do `BRIEFING_PROMPT`, prazo de briefing 180 s, bloco anti-bot em `src/prompts.ts` (cópia de referência; o n8n já tem), o comando `#reset` de tester, e imagem/PDF/cartão de contato → texto (`src/media.ts`; o mapeamento de tipos em `sapore-session/index.js` também mudou e **precisa de redeploy da function na Kapso**, senão imagens continuam chegando como `unsupported`). O `#reset` exige a migração `004_candidate_reset` (`ALTER TABLE sdr.candidates ADD COLUMN reset_at`) aplicada pelo runner com a conexão administrativa **antes** de subir a imagem — o runtime só usa a coluna, não a cria.

## Rollback da 3A

Importar o backup da Fase 1 (`n8n-v2-workflow.json`, HTTP `/v1/responses`) sobre o workflow, ou recriar o node HTTP a partir dele. O node antigo desabilitado já não está no canvas.
