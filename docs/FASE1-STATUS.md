# Fase 1 — Status (2026-09-15)

## Feito

- Workflow n8n criado: **`SaporeAgentWhatsAppV2`**
- Nome: **Sapore SDR — agente WhatsApp v2**
- Editor: https://sdr-n8n.cognitaai.com.br/workflow/SaporeAgentWhatsAppV2
- Webhook produção: `POST https://sdr-n8n.cognitaai.com.br/webhook/sapore-sdr-v2-jobs` (header auth = mesmo token inbound do v1)
- Node **Sofia — system prompt**: prompt franchise-sdr-v1.1 colado e editável no canvas
- Sem Code node no caminho (Set + HTTP + IF)
- Timeout OpenAI 120s; executionTimeout 180s
- Ramo sintético: `jobId` começando com `synthetic-` encerra após OpenAI (não chama WhatsApp/API)
- Backup do JSON: `n8n-v2-workflow.json` nesta pasta
- Kapso **não** foi alterada; worker ainda aponta para **v1** (`sapore-sdr-v1-jobs`)

## Teste sintético

- `POST` webhook v2 com `jobId=synthetic-fase1-001` → HTTP 200 (ACK)
- Execução n8n `104`: chegou em **OpenAI Responses**
- Prompt Sofia presente no request (confirmado no blob da execução)
- OpenAI respondeu **429 / `credit_balance_exhausted`**: *You have no credits remaining*
- Por isso a execução ficou `error` (falha **visível** e correta — não hang)

## Critério de saída

| Critério | Status |
|---|---|
| Abrir n8n e ler Sofia no node | **OK** |
| Execução verde com JSON válido | **OK** — execução `105` success (~1.7s) após crédito |
| Worker no v2 | **OK** — `N8N_WEBHOOK_URL` → `/webhook/sapore-sdr-v2-jobs` |

## Concluído

- Crédito OpenAI recarregado pelo Gabriel
- Sintético `synthetic-fase1-002` → success
- Worker recriado com path v2; backup `runtime.env.bak.fase1-*`
- Kapso intacta (ainda Decide/Send); conversa reaberta para o próximo ping

## Rollback Fase 1

1. Em `runtime.env`, trocar `sapore-sdr-v2-jobs` → `sapore-sdr-v1-jobs`
2. `docker compose up -d --force-recreate worker` no release atual
3. Ping de prova

## Próximo

Fase 2 — API envia via Kapso Messages API (sem depender do `send_text` do workflow), sem double-send.

**Decisão:** o HTTP `OpenAI Responses` da Fase 1 é ponte. Na **Fase 3A** o canvas troca para o **modo Agent** do n8n, com Structured Output = `AgentDecisionSchema` (o guard da API continua).
