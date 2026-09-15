#!/usr/bin/env bash
# Activate inbound trigger + CHANNEL_ENABLED for allowlist-only internal ping.
# Keeps NATIVE_CONTROL_VERIFIED=false so the Decide guard handoffs until real Resume is captured.
set -euo pipefail

SECRETS=/opt/sapore-sdr/secrets
RELEASE=/opt/sapore-sdr/releases/20260914T043000Z/sapore-sdr
BASE=https://api.kapso.ai
PHONE=1052683654599692
WORKFLOW_ID="${KAPSO_WORKFLOW_ID:-a2c54a90-1654-495b-b586-49066507f142}"

set -a
# shellcheck disable=SC1091
source "${SECRETS}/runtime.env"
# shellcheck disable=SC1091
source "${SECRETS}/kapso.env"
set +a

test "${#KAPSO_API_KEY}" -ge 32
WORKFLOW_ID="${KAPSO_WORKFLOW_ID:-$WORKFLOW_ID}"
echo "workflow=${WORKFLOW_ID}"
echo "phone=${PHONE}"

auth=(-H "X-API-Key: ${KAPSO_API_KEY}" -H "Content-Type: application/json" -H "Accept: application/json")

# List triggers and activate inbound_message for this workflow/phone
curl -sS -o /tmp/triggers.json "${auth[@]}" \
  "${BASE}/platform/v1/workflows/${WORKFLOW_ID}/triggers"
python3 - <<'PY'
import json
from pathlib import Path
d=json.load(open("/tmp/triggers.json"))
items=d.get("data", d if isinstance(d, list) else [])
if isinstance(items, dict):
    items=items.get("triggers") or items.get("items") or []
print("trigger_count", len(items) if isinstance(items, list) else items)
ids=[]
if isinstance(items, list):
    for it in items:
        if not isinstance(it, dict):
            continue
        print({k: it.get(k) for k in ["id", "active", "trigger_type", "phone_number_id"]})
        if it.get("trigger_type") == "inbound_message":
            ids.append(it["id"])
Path("/tmp/trigger-ids.txt").write_text("\n".join(ids))
PY

while read -r TID; do
  [[ -z "$TID" ]] && continue
  payload='{"trigger":{"active":true}}'
  code=$(curl -sS -o /tmp/trig-upd.json -w "%{http_code}" "${auth[@]}" \
    -X PATCH "${BASE}/platform/v1/workflows/${WORKFLOW_ID}/triggers/${TID}" -d "${payload}")
  echo "activate_trigger ${TID} http=${code}"
  python3 -c 'import json; d=json.load(open("/tmp/trig-upd.json")); data=d.get("data",d); t=data.get("trigger",data) if isinstance(data,dict) else data; print({k:(t.get(k) if isinstance(t,dict) else None) for k in ["id","active","trigger_type"]})'
done < /tmp/trigger-ids.txt

# Flip runtime gates: whatsapp mode + channel on + native control still false
python3 - <<'PY'
from pathlib import Path
import re

updates = {
    "EXECUTION_MODE": "whatsapp",
    "CHANNEL_ENABLED": "true",
    "NATIVE_CONTROL_VERIFIED": "false",
}
for name in ["runtime.env", "kapso.env"]:
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
print("env updated:")
for key in ["EXECUTION_MODE", "CHANNEL_ENABLED", "NATIVE_CONTROL_VERIFIED", "KAPSO_WORKFLOW_ID"]:
    for line in Path("/opt/sapore-sdr/secrets/runtime.env").read_text().splitlines():
        if line.startswith(key + "="):
            k, v = line.split("=", 1)
            print(f"  {k}={v if k != 'KAPSO_API_KEY' else '***'}")
PY

cd "${RELEASE}"
export SAPORE_ENV_FILE=/opt/sapore-sdr/secrets/runtime.env
export SAPORE_CA_FILE=/opt/sapore-sdr/secrets/supabase-ca.crt
export SAPORE_IMAGE
SAPORE_IMAGE=$(docker inspect sapore-sdr-api-1 --format '{{.Config.Image}}')
echo "recreate image=${SAPORE_IMAGE}"
docker compose up -d --no-build --force-recreate api worker
sleep 5
curl -sS -o /tmp/health.json -w "health_http=%{http_code}\n" http://127.0.0.1:3100/health
curl -sS -o /tmp/ready.json -w "ready_http=%{http_code}\n" http://127.0.0.1:3100/ready
python3 - <<'PY'
import json, subprocess
print(json.load(open("/tmp/health.json")))
print(json.load(open("/tmp/ready.json")))
out=subprocess.check_output(["docker","inspect","sapore-sdr-api-1","--format","{{range .Config.Env}}{{println .}}{{end}}"], text=True)
for line in out.splitlines():
    if "=" not in line: continue
    k,v=line.split("=",1)
    if k in ("EXECUTION_MODE","CHANNEL_ENABLED","NATIVE_CONTROL_VERIFIED","KAPSO_WORKFLOW_ID","PUBLIC_API_URL"):
        print(f"container {k}={v}")
PY

echo "DONE. Send a WhatsApp from an allowlisted tester to +1 318-612-9308."
echo "Expected first behavior: workflow starts and Decide routes to native Handoff until NATIVE_CONTROL_VERIFIED=true."
unset KAPSO_API_KEY
