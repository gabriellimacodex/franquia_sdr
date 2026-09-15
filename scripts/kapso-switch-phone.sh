#!/usr/bin/env bash
# Switch Kapso phone number for Sapore pilot. Does not print secrets.
set -euo pipefail

SECRETS=/opt/sapore-sdr/secrets
BASE=https://api.kapso.ai
OLD_PHONE=1052683654599692
NEW_PHONE="${1:?usage: kapso-switch-phone.sh <new_phone_number_id>}"
WORKFLOW_ID="${KAPSO_WORKFLOW_ID:-a2c54a90-1654-495b-b586-49066507f142}"
PUBLIC_API_URL="${PUBLIC_API_URL:-https://sdr-api.cognitaai.com.br}"
RELEASE=/opt/sapore-sdr/releases/20260914T043000Z/sapore-sdr

set -a
# shellcheck disable=SC1091
source "${SECRETS}/runtime.env"
# shellcheck disable=SC1091
source "${SECRETS}/kapso.env"
set +a

test "${#KAPSO_API_KEY}" -ge 32
WORKFLOW_ID="${KAPSO_WORKFLOW_ID:-$WORKFLOW_ID}"
echo "OLD=${OLD_PHONE}"
echo "NEW=${NEW_PHONE}"
echo "WORKFLOW=${WORKFLOW_ID}"

auth=(-H "X-API-Key: ${KAPSO_API_KEY}" -H "Content-Type: application/json" -H "Accept: application/json")

# Verify new phone exists
curl -sS -o /tmp/new-phone.json -w "new_phone_http=%{http_code}\n" "${auth[@]}" \
  "${BASE}/platform/v1/whatsapp/phone_numbers/${NEW_PHONE}"
python3 - <<'PY'
import json
from pathlib import Path
d=json.loads(Path("/tmp/new-phone.json").read_text()).get("data", {})
print({k:d.get(k) for k in ["id","display_phone_number","name","status","quality_rating"]})
if d.get("status") not in (None, "CONNECTED") and d.get("status") != "CONNECTED":
    # still print; caller decides
    pass
PY

# Deactivate ALL triggers on the Sapore workflow first (avoid dual consumers)
curl -sS -o /tmp/trigs.json "${auth[@]}" \
  "${BASE}/platform/v1/workflows/${WORKFLOW_ID}/triggers"
python3 - <<'PY'
import json
from pathlib import Path
items=json.loads(Path("/tmp/trigs.json").read_text()).get("data", [])
Path("/tmp/all-trigger-ids.txt").write_text("\n".join(i["id"] for i in items if isinstance(i, dict) and i.get("id")))
print("existing_triggers", [{k:i.get(k) for k in ["id","active"]} for i in items])
PY
while read -r TID; do
  [[ -z "$TID" ]] && continue
  code=$(curl -sS -o /tmp/toff.json -w "%{http_code}" -X PATCH "${auth[@]}" \
    "${BASE}/platform/v1/triggers/${TID}" -d '{"trigger":{"active":false}}')
  echo "deactivate ${TID} http=${code}"
done < /tmp/all-trigger-ids.txt

# Disable old phone webhook(s) pointing to sdr-api if still present
curl -sS -o /tmp/old-wh.json "${auth[@]}" \
  "${BASE}/platform/v1/whatsapp/phone_numbers/${OLD_PHONE}/webhooks" || true
python3 - <<'PY'
import json
from pathlib import Path
try:
  items=json.loads(Path("/tmp/old-wh.json").read_text()).get("data", [])
except Exception:
  items=[]
ids=[]
for it in items if isinstance(items, list) else []:
  url=str(it.get("url") or "")
  if "sdr-api.cognitaai.com.br" in url and it.get("id"):
    ids.append(it["id"])
Path("/tmp/old-wh-ids.txt").write_text("\n".join(ids))
print("old_webhooks_to_disable", ids)
PY
while read -r WID; do
  [[ -z "$WID" ]] && continue
  code=$(curl -sS -o /tmp/whoff.json -w "%{http_code}" -X PATCH "${auth[@]}" \
    "${BASE}/platform/v1/whatsapp/phone_numbers/${OLD_PHONE}/webhooks/${WID}" \
    -d '{"whatsapp_webhook":{"active":false}}')
  echo "disable_old_webhook ${WID} http=${code}"
done < /tmp/old-wh-ids.txt

# Ensure webhook secret exists
python3 - <<'PY'
from pathlib import Path
import re, secrets
path=Path("/opt/sapore-sdr/secrets/kapso.env")
text=path.read_text()
m=re.search(r'^KAPSO_WEBHOOK_SECRET=(.*)$', text, re.M)
val=(m.group(1).strip() if m else '')
if len(val) < 32:
    val=secrets.token_hex(32)
    if m: text=re.sub(r'^KAPSO_WEBHOOK_SECRET=.*$', f'KAPSO_WEBHOOK_SECRET={val}', text, flags=re.M)
    else: text=text.rstrip()+f'\nKAPSO_WEBHOOK_SECRET={val}\n'
    path.write_text(text); path.chmod(0o600)
    print(f'webhook_secret generated chars={len(val)}')
else:
    print(f'webhook_secret kept chars={len(val)}')
PY
set -a
# shellcheck disable=SC1091
source "${SECRETS}/kapso.env"
set +a

# Create webhook on NEW phone
webhook_payload=$(python3 - <<PY
import json, os
print(json.dumps({
  "whatsapp_webhook": {
    "url": "${PUBLIC_API_URL%/}/webhooks/kapso",
    "secret_key": os.environ["KAPSO_WEBHOOK_SECRET"],
    "events": [
      "whatsapp.message.received",
      "whatsapp.message.sent",
      "whatsapp.message.delivered",
      "whatsapp.message.read",
      "whatsapp.message.failed",
      "whatsapp.conversation.created",
      "whatsapp.conversation.ended"
    ],
    "payload_version": "v2",
    "active": True,
    "buffer_enabled": True,
    "buffer_window_seconds": 2,
    "max_buffer_size": 20
  }
}))
PY
)
code=$(curl -sS -o /tmp/new-wh.json -w "%{http_code}" -X POST "${auth[@]}" \
  "${BASE}/platform/v1/whatsapp/phone_numbers/${NEW_PHONE}/webhooks" -d "${webhook_payload}")
echo "create_new_webhook http=${code}"
python3 - <<'PY'
import json
from pathlib import Path
raw=Path("/tmp/new-wh.json").read_text()
try:
  d=json.loads(raw)
except Exception:
  print(raw[:400]); raise SystemExit(0)
data=d.get("data", d)
# never print secret_key
if isinstance(data, dict):
  print({k:data.get(k) for k in ["id","active","url","payload_version"]})
else:
  print(str(d)[:400])
PY

# Create ONE active inbound trigger on new phone
trigger_payload=$(python3 - <<PY
import json
print(json.dumps({
  "trigger": {
    "trigger_type": "inbound_message",
    "active": True,
    "phone_number_id": "${NEW_PHONE}"
  }
}))
PY
)
code=$(curl -sS -o /tmp/new-trig.json -w "%{http_code}" -X POST "${auth[@]}" \
  "${BASE}/platform/v1/workflows/${WORKFLOW_ID}/triggers" -d "${trigger_payload}")
echo "create_new_trigger http=${code}"
python3 - <<'PY'
import json
from pathlib import Path
d=json.loads(Path("/tmp/new-trig.json").read_text())
data=d.get("data", d)
print({k:data.get(k) for k in ["id","active","trigger_type","workflow_id"] if isinstance(data, dict)})
if isinstance(data, dict) and data.get("triggerable"):
  print("triggerable", {k:data["triggerable"].get(k) for k in ["phone_number_id","id"]})
PY

# Update env files
python3 - <<PY
from pathlib import Path
import re
new_phone = "${NEW_PHONE}"
updates = {
  "KAPSO_PHONE_NUMBER_ID": new_phone,
  "CHANNEL_ENABLED": "true",
  "NATIVE_CONTROL_VERIFIED": "false",
  "EXECUTION_MODE": "whatsapp",
  "KAPSO_WORKFLOW_ID": "${WORKFLOW_ID}",
}
for name in ["kapso.env", "runtime.env"]:
  path = Path("/opt/sapore-sdr/secrets") / name
  text = path.read_text() if path.exists() else ""
  for key, val in updates.items():
    if name == "kapso.env" and key == "EXECUTION_MODE":
      continue
    if re.search(rf"^{key}=", text, re.M):
      text = re.sub(rf"^{key}=.*$", f"{key}={val}", text, flags=re.M)
    else:
      text = text.rstrip() + f"\n{key}={val}\n"
  path.write_text(text)
  path.chmod(0o600)
print("env updated phone=", new_phone)
PY

# Update pilot.json if present
python3 - <<PY
import json
from pathlib import Path
p=Path("/opt/sapore-sdr/secrets/pilot.json")
if p.exists():
  d=json.loads(p.read_text())
  d["phoneNumberId"]="${NEW_PHONE}"
  p.write_text(json.dumps(d, indent=2, ensure_ascii=False)+"\n")
  p.chmod(0o600)
  print("pilot.json phone updated")
else:
  print("pilot.json missing on server")
PY

# Recreate containers
cd "${RELEASE}"
export SAPORE_ENV_FILE=/opt/sapore-sdr/secrets/runtime.env
export SAPORE_CA_FILE=/opt/sapore-sdr/secrets/supabase-ca.crt
export SAPORE_IMAGE
SAPORE_IMAGE=$(docker inspect sapore-sdr-api-1 --format '{{.Config.Image}}')
docker compose up -d --no-build --force-recreate api worker
sleep 4
curl -sS http://127.0.0.1:3100/health; echo
curl -sS http://127.0.0.1:3100/ready; echo

# Final inventory
curl -sS "${auth[@]}" "${BASE}/platform/v1/workflows/${WORKFLOW_ID}/triggers" -o /tmp/final-tr.json
python3 - <<'PY'
import json
from pathlib import Path
items=json.loads(Path("/tmp/final-tr.json").read_text()).get("data",[])
print("FINAL_TRIGGERS")
for i in items:
  t=i.get("triggerable") or {}
  print({"id": i.get("id"), "active": i.get("active"), "phone": t.get("phone_number_id")})
PY
curl -sS "${auth[@]}" "${BASE}/platform/v1/whatsapp/phone_numbers/${NEW_PHONE}/webhooks" -o /tmp/final-wh.json
python3 - <<'PY'
import json
from pathlib import Path
items=json.loads(Path("/tmp/final-wh.json").read_text()).get("data",[])
print("FINAL_WEBHOOKS")
for i in items:
  print({"id": i.get("id"), "active": i.get("active"), "url": i.get("url")})
PY

echo "DONE switch. Send WhatsApp to the NEW display number from an allowlisted tester."
unset KAPSO_API_KEY
