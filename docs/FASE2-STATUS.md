# Fase 2 — Status (2026-09-15)

## Objetivo

API envia WhatsApp via Kapso Messages API. O node `send_text` do workflow Kapso **não** deve mais disparar o texto.

## Feito

- `Kapso.sendText` + `resolveWaId` em `src/kapso.ts`
- `POST /internal/turns/:id/deliver` — authorize + send + grava WAMID (`sent`)
- `store.confirmApiSend` / `failApiSend` / `recipientHint`
- `sapore-session`: em `ready` chama `/deliver` e retorna **`wait`** (não `send`); se já `sent`, só `wait`
- Deploy API `sapore-sdr:sprint4-nat-send-20260915-r9`
- Function Kapso `sapore-session` patch+deploy (202)
- Testes: `tests/kapso-api-send.test.ts` passando

## Anti double-send

1. Session não preenche `sapore_reply_text` no caminho novo  
2. Session não escolhe edge `send`  
3. Se o Decide ainda pollar um job `sent`, cai em `wait`

## Critério de saída (prova real)

Pendente do ping do Gabriel:

1. Inbound “oi”
2. n8n v2 execution success
3. Outbound no WhatsApp
4. `sdr.deliveries.message_id` = `wamid.…` e job `state=sent`

## Rollback

1. Reverter function session para a cópia em `backups/fase0-20260915/sapore-fase0/kapso-function-session.js` (authorize-send + route send)
2. Imagem API anterior (`r8`) sem `/deliver`
3. Ping de prova
