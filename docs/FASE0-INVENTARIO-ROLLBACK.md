# Fase 0 — Inventário e rollback (2026-09-15)

Sem mudança de comportamento. Só evidência.

## IDs canônicos

| Peça | Valor |
|---|---|
| WhatsApp phone_number_id | `1093705843816293` (Cognita - Nat) |
| Kapso workflow | `a2c54a90-1654-495b-b586-49066507f142` |
| Kapso workflow name | Sapore SDR — controle de sessão v1 |
| Kapso workflow status | **active** |
| Kapso lock_version (backup) | 19 |
| Kapso trigger inbound | `140d43f1-8d4f-4d05-9998-058defbc77ab` **active** |
| Kapso function session | `676ecedd-1ba3-42bd-a5d4-0e005d61ce01` |
| Kapso function dispatched | `b0abed08-…` (ver `kapso-function-ids.json`) |
| Kapso function handoff | `fefcddbb-…` |
| Webhook telefone → API | `bece8a4d-10f5-4e57-9868-10f7c3f21167` **active** → `https://sdr-api.cognitaai.com.br/webhooks/kapso` |
| Webhook Rede Ideia | `ee62800d-9dc0-40e0-a3e7-540d52a0f2b8` **inactive** |
| API | `https://sdr-api.cognitaai.com.br` |
| n8n editor | `https://sdr-n8n.cognitaai.com.br` |
| n8n workflow | `SaporeAsyncV1Lab` — Sapore SDR — async reasoning v1 — **active** |
| n8n webhook path | `/webhook/sapore-sdr-v1-jobs` |
| Prompt publicado (banco) | `sapore-v1.1-153b9ac1c962` (Sofia) |

## Arquivos deste backup

Diretório: `Documents/FRANQUIAS/sapore-sdr/backups/fase0-20260915/`

- `sapore-fase0/` — Kapso meta, definition, triggers, webhooks, functions (código + meta)
- `sapore-fase0-n8n/` — n8n `workflow_entity` + `workflow_history` + chaves compose runners
- `sapore-fase0-kapso.tgz` / `sapore-fase0-n8n.tgz` — pacotes

Secrets de webhook foram redigidos nos JSON locais quando presentes.

## Consumidores de inbound (foto atual)

Hoje existem **dois** caminhos ativos para a Nat:

1. **Trigger de workflow** `140d43f1…` → canvas Kapso (Decide/Wait/Send)
2. **Webhook de telefone** `bece8a4d…` → `sdr-api` (mensagens + receipts)

Isso é o desenho atual (native control). Na Fase 3 do plano o trigger (1) sai; o webhook (2) fica sozinho. **Nunca ligar um segundo workflow trigger sem desligar o primeiro.**

Rede Ideia está inactive — OK.

## n8n — o que o canvas tem agora

Nodes no entity (ainda listados): Authenticated job, Validate and prepare job (Code), Structured model response, Validate response envelope (Code), Authenticated backend callback.

Connections ativas no backup: só `Authenticated job` → `Structured model response` (Code nodes fora do grafo de execução).

Settings no backup: `executionTimeout: 55` (atenção: curto; alinhar na Fase 1/4).

## Rollback paper (Fase 3+ — < 5 min)

Se o corte novo falhar:

1. Na VPS: `CHANNEL_ENABLED=false` em `runtime.env` / compose e recreate **api+worker** (congela outbound da API).
2. Kapso: `PATCH /platform/v1/triggers/140d43f1-8d4f-4d05-9998-058defbc77ab` com `active: true` (se tiver sido desativado).
3. Kapso: garantir workflow `a2c54a90-…` status `active`.
4. Worker: `N8N_WEBHOOK_URL` apontando para `/webhook/sapore-sdr-v1-jobs` (v1) se o v2 estiver quebrado; recreate worker.
5. `CHANNEL_ENABLED=true` + recreate api/worker.
6. Ping “oi” no WhatsApp da Nat.
7. Se execução Kapso antiga estiver `handoff`/`waiting` presa: `PATCH .../workflow_executions/{id}` → `status: ended` antes do ping.

**Não apagar** o workflow Kapso nem as functions. Só desativar/reativar trigger.

### Comandos de referência (sem secrets)

```bash
# Reativar trigger
curl -X PATCH "https://api.kapso.ai/platform/v1/triggers/140d43f1-8d4f-4d05-9998-058defbc77ab" \
  -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" \
  -d '{"trigger":{"active":true}}'

# Listar triggers do workflow
curl "https://api.kapso.ai/platform/v1/workflows/a2c54a90-1654-495b-b586-49066507f142/triggers" \
  -H "X-API-Key: $KAPSO_API_KEY"

# Listar webhooks do número
curl "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/1093705843816293/webhooks" \
  -H "X-API-Key: $KAPSO_API_KEY"
```

## Critério de saída da Fase 0 — CUMPRIDO

- [x] Inventário com IDs
- [x] Backup Kapso (definition + functions + triggers + webhooks)
- [x] Backup n8n (entity + history)
- [x] Confirmado: 1 trigger inbound active; 1 webhook API active; Rede Ideia inactive
- [x] Rollback paper escrito

**Próximo:** Fase 1 — n8n v2 com Sofia no canvas (sem matar Kapso ainda).
