#!/usr/bin/env bash
# Estado real do piloto Sapore — SOMENTE LEITURA.
# Não altera nada, não envia WhatsApp, não imprime valor de segredo (só tamanho).
# Uso: ./scripts/estado-real.sh [caminho/runtime.env]
# A saída é segura para colar em chat.

ENV_FILE="${1:-/opt/sapore-sdr/runtime.env}"
API_URL="${API_URL:-https://sdr-api.cognitaai.com.br}"
PHONE_ID="${PHONE_ID:-1093705843816293}"
WORKFLOW_ID="${WORKFLOW_ID:-a2c54a90-1654-495b-b586-49066507f142}"

line() { printf '\n== %s\n' "$1"; }
val() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '"'"'"'\r'; }
# Nunca imprime o valor: só quantos caracteres tem.
chars() { local v; v="$(val "$1")"; printf '%-28s %s\n' "$1" "${#v} chars"; }
flag() { printf '%-28s %s\n' "$1" "$(val "$1")"; }
jqf() { command -v jq >/dev/null && jq -r "$1" 2>/dev/null || cat; }

printf 'ESTADO REAL — %s\nhost: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname)"
printf 'env file: %s (%s)\n' "$ENV_FILE" "$([ -r "$ENV_FILE" ] && echo legivel || echo 'NAO LEGIVEL')"

line "1. Processos"
if command -v docker >/dev/null; then
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' 2>&1 | head -20
else
  echo 'docker ausente'
fi
command -v pm2 >/dev/null && pm2 list 2>&1 | head -20

line "2. Gates de liberação (os que decidem se envia WhatsApp)"
for k in EXECUTION_MODE CHANNEL_ENABLED NATIVE_CONTROL_VERIFIED RETENTION_ENABLED \
         PORT PUBLIC_API_URL LAB_ORIGIN N8N_WEBHOOK_URL KAPSO_PHONE_NUMBER_ID \
         KAPSO_WORKFLOW_ID KAPSO_HUMAN_RESUME_EVENT_TYPE KAPSO_HUMAN_RESUME_REASON; do flag "$k"; done

line "3. Segredos presentes (tamanho apenas, nunca o valor)"
for k in DATABASE_URL KAPSO_API_KEY KAPSO_WEBHOOK_SECRET KAPSO_FUNCTION_TOKEN \
         N8N_WEBHOOK_TOKEN N8N_CALLBACK_TOKEN OPENAI_API_KEY SUPABASE_ANON_KEY; do chars "$k"; done
a="$(val N8N_WEBHOOK_TOKEN)"; b="$(val N8N_CALLBACK_TOKEN)"; c="$(val KAPSO_FUNCTION_TOKEN)"
if [ "$a" = "$b" ] || [ "$a" = "$c" ] || [ "$b" = "$c" ]; then
  echo 'ALERTA: tokens internos repetidos — a API recusa subir assim'
else
  echo 'tokens internos distintos: ok'
fi

line "4. API"
for p in /health /ready; do
  printf '%-10s %s\n' "$p" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$API_URL$p" 2>&1)"
done
printf '%-10s %s (esperado 401)\n' "/v1/versions/draft" \
  "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$API_URL/v1/versions/draft" 2>&1)"

line "5. Kapso — consumidores de inbound (dual consumer = incidente)"
K="$(val KAPSO_API_KEY)"
if [ -z "$K" ]; then echo 'KAPSO_API_KEY ausente no env — pulando'; else
  echo "-- triggers do workflow $WORKFLOW_ID (ativo=true significa canvas Decide/Send ligado)"
  curl -sS --max-time 15 -H "X-API-Key: $K" \
    "https://api.kapso.ai/platform/v1/workflows/$WORKFLOW_ID/triggers" \
    | jqf '.data[]? | "\(.id)  active=\(.active)  \(.trigger_type // .type // "")"'
  echo "-- webhooks do numero $PHONE_ID"
  curl -sS --max-time 15 -H "X-API-Key: $K" \
    "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/$PHONE_ID/webhooks" \
    | jqf '.data[]? | "\(.id)  active=\(.active)  \(.url)"'
  echo "-- execucoes presas (running/waiting/handoff) neste workflow"
  curl -sS --max-time 15 -H "X-API-Key: $K" \
    "https://api.kapso.ai/platform/v1/workflows/$WORKFLOW_ID/workflow_executions?limit=20" \
    | jqf '[.data[]? | select(.status|test("running|waiting|handoff"))] | "presas: \(length)"'
fi

line "6. Banco (somente SELECT)"
D="$(val DATABASE_URL)"
if [ -z "$D" ] || ! command -v psql >/dev/null; then echo 'psql ou DATABASE_URL ausente — pulando'; else
  psql "$D" -qAF' | ' --pset=footer=off <<'SQL' 2>&1 | head -40
\echo -- canais (enabled decide se a API pode enviar)
SELECT phone_number_id, enabled, (responsible_user_id IS NOT NULL) AS tem_responsavel FROM sdr.channels;
\echo -- allowlist
SELECT count(*) AS testers FROM sdr.testers;
\echo -- jobs por estado (ultimas 24h)
SELECT state, count(*) FROM sdr.jobs WHERE created_at > now() - interval '24 hours' GROUP BY state ORDER BY 2 DESC;
\echo -- ultimas entregas: wamid preenchido = Fase 2 provada
SELECT job_id, state, (message_id IS NOT NULL) AS tem_wamid, created_at FROM sdr.deliveries ORDER BY created_at DESC LIMIT 5;
\echo -- versao publicada em uso
SELECT id, published_at IS NOT NULL AS publicada FROM sdr.versions ORDER BY created_at DESC LIMIT 3;
SQL
fi

line "FIM — saida sem segredos, pode colar no chat"
