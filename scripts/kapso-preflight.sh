#!/usr/bin/env bash
# Inventário Kapso do canal de teste. Não imprime secrets.
# Uso (na VPS, com KAPSO_API_KEY já exportada):
#   ./scripts/kapso-preflight.sh
set -euo pipefail

PHONE_NUMBER_ID="${KAPSO_PHONE_NUMBER_ID:-1052683654599692}"
BASE="${KAPSO_API_BASE_URL:-https://api.kapso.ai}"

if [[ -z "${KAPSO_API_KEY:-}" ]]; then
  echo "FAIL: KAPSO_API_KEY não está definida no ambiente."
  echo "Defina na VPS (sem colar no chat) e rode de novo."
  exit 1
fi

KEY_LEN=${#KAPSO_API_KEY}
if (( KEY_LEN < 32 )); then
  echo "FAIL: KAPSO_API_KEY parece curta demais (chars=$KEY_LEN)."
  exit 1
fi

echo "OK: KAPSO_API_KEY presente (chars=$KEY_LEN)"
echo "PHONE_NUMBER_ID=$PHONE_NUMBER_ID"
echo "BASE=$BASE"

auth=(-H "X-API-Key: ${KAPSO_API_KEY}" -H "Accept: application/json")

echo
echo "== Phone number =="
code=$(curl -sS -o /tmp/kapso-phone.json -w "%{http_code}" \
  "${auth[@]}" "${BASE}/platform/v1/whatsapp/phone_numbers/${PHONE_NUMBER_ID}" || true)
echo "HTTP $code"
if [[ "$code" != "200" ]]; then
  echo "FAIL: não foi possível ler o número. Confira chave/projeto."
  exit 1
fi
python3 - <<'PY'
import json
from pathlib import Path
data = json.loads(Path("/tmp/kapso-phone.json").read_text())
# Print only non-secret identifiers
payload = data.get("data", data)
keys = ["id", "display_phone_number", "status", "quality_rating", "name"]
print({k: payload.get(k) for k in keys if isinstance(payload, dict)})
PY

echo
echo "== Webhooks no número =="
code=$(curl -sS -o /tmp/kapso-webhooks.json -w "%{http_code}" \
  "${auth[@]}" "${BASE}/platform/v1/whatsapp/phone_numbers/${PHONE_NUMBER_ID}/webhooks" || true)
echo "HTTP $code"
python3 - <<'PY'
import json
from pathlib import Path
raw = Path("/tmp/kapso-webhooks.json").read_text()
try:
    data = json.loads(raw)
except Exception:
    print("body_not_json")
    raise SystemExit(0)
items = data.get("data", data if isinstance(data, list) else [])
if isinstance(items, dict):
    items = items.get("webhooks") or items.get("items") or [items]
print(f"webhook_count={len(items) if isinstance(items, list) else 'unknown'}")
if isinstance(items, list):
    for i, item in enumerate(items[:20]):
        if not isinstance(item, dict):
            continue
        print({
            "i": i,
            "id": item.get("id"),
            "url_host": (item.get("url") or item.get("callback_url") or "").split("/")[2:3] or None,
            "active": item.get("active", item.get("enabled")),
        })
PY

echo
echo "== Workflows (amostra) =="
code=$(curl -sS -o /tmp/kapso-workflows.json -w "%{http_code}" \
  "${auth[@]}" "${BASE}/platform/v1/workflows?limit=50" || true)
echo "HTTP $code"
python3 - <<'PY'
import json
from pathlib import Path
raw = Path("/tmp/kapso-workflows.json").read_text()
try:
    data = json.loads(raw)
except Exception:
    print("body_not_json")
    raise SystemExit(0)
items = data.get("data", data if isinstance(data, list) else [])
if isinstance(items, dict):
    items = items.get("workflows") or items.get("items") or []
print(f"workflow_count={len(items) if isinstance(items, list) else 'unknown'}")
if isinstance(items, list):
    for item in items[:30]:
        if not isinstance(item, dict):
            continue
        print({
            "id": item.get("id"),
            "name": item.get("name"),
            "status": item.get("status") or item.get("state"),
        })
PY

echo
echo "DONE: inventário concluído. Não ative CHANNEL_ENABLED ainda."
echo "Próximo: conferir triggers do número e absence de workflow duplicado."
