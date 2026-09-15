#!/usr/bin/env bash
# Rotate webhook secret (was printed in a deploy log), update Kapso webhook,
# and recreate api/worker with runtime.env. Keeps CHANNEL_ENABLED=false.
set -euo pipefail

SECRETS=/opt/sapore-sdr/secrets
PHONE=1052683654599692
BASE=https://api.kapso.ai
RELEASE=/opt/sapore-sdr/releases/20260914T043000Z/sapore-sdr

set -a
# shellcheck disable=SC1091
source "${SECRETS}/runtime.env"
# shellcheck disable=SC1091
source "${SECRETS}/kapso.env"
set +a

echo "pre: KAPSO_API_KEY chars=${#KAPSO_API_KEY} WORKFLOW=${KAPSO_WORKFLOW_ID:-none}"

# Rotate webhook secret because previous value appeared in deploy stdout
NEW_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
echo "new_webhook_secret chars=${#NEW_SECRET}"

python3 - <<PY
from pathlib import Path
import re
secret = """${NEW_SECRET}"""
for name in ["kapso.env", "runtime.env"]:
    path = Path("${SECRETS}") / name
    text = path.read_text()
    if re.search(r"^KAPSO_WEBHOOK_SECRET=", text, re.M):
        text = re.sub(r"^KAPSO_WEBHOOK_SECRET=.*$", f"KAPSO_WEBHOOK_SECRET={secret}", text, flags=re.M)
    else:
        text = text.rstrip() + f"\nKAPSO_WEBHOOK_SECRET={secret}\n"
    # keep gates closed
    for key in ("CHANNEL_ENABLED", "NATIVE_CONTROL_VERIFIED"):
        if re.search(rf"^{key}=", text, re.M):
            text = re.sub(rf"^{key}=.*$", f"{key}=false", text, flags=re.M)
        else:
            text = text.rstrip() + f"\n{key}=false\n"
    path.write_text(text)
    path.chmod(0o600)
print("secrets files updated")
PY

set -a
# shellcheck disable=SC1091
source "${SECRETS}/kapso.env"
set +a

auth=(-H "X-API-Key: ${KAPSO_API_KEY}" -H "Content-Type: application/json" -H "Accept: application/json")

# List webhooks and update the one pointing to sdr-api
curl -sS -o /tmp/wh.json "${auth[@]}" \
  "${BASE}/platform/v1/whatsapp/phone_numbers/${PHONE}/webhooks"
python3 - <<'PY'
import json
from pathlib import Path
d=json.load(open("/tmp/wh.json"))
items=d.get("data", [])
if isinstance(items, dict):
    items=items.get("webhooks") or items.get("items") or []
print("webhook_count", len(items) if isinstance(items, list) else items)
ids=[]
if isinstance(items, list):
    for it in items:
        if isinstance(it, dict):
            url=it.get("url") or ""
            print({"id": it.get("id"), "active": it.get("active"), "url_host": url.split("/")[2:3]})
            if "sdr-api.cognitaai.com.br" in url:
                ids.append(it["id"])
Path("/tmp/wh-ids.txt").write_text("\n".join(ids))
PY

while read -r WID; do
  [[ -z "$WID" ]] && continue
  payload=$(python3 - <<PY
import json, os
print(json.dumps({
  "whatsapp_webhook": {
    "secret_key": os.environ["KAPSO_WEBHOOK_SECRET"],
    "active": True,
    "url": "https://sdr-api.cognitaai.com.br/webhooks/kapso",
    "payload_version": "v2",
  }
}))
PY
)
  code=$(curl -sS -o /tmp/wh-upd.json -w "%{http_code}" "${auth[@]}" \
    -X PATCH "${BASE}/platform/v1/whatsapp/phone_numbers/${PHONE}/webhooks/${WID}" -d "${payload}")
  echo "update_webhook ${WID} http=${code}"
  python3 -c 'import json; d=json.load(open("/tmp/wh-upd.json")); data=d.get("data",d); print({k:data.get(k) for k in ["id","active","url"] if isinstance(data,dict)})'
done < /tmp/wh-ids.txt

# Recreate containers with updated runtime.env
cd "${RELEASE}"
export SAPORE_ENV_FILE="${SECRETS}/runtime.env"
export SAPORE_CA_FILE="${SECRETS}/supabase-ca.crt"
export SAPORE_IMAGE=$(docker inspect sapore-sdr-api-1 --format '{{.Config.Image}}')
echo "using image=${SAPORE_IMAGE}"
echo "SAPORE_ENV_FILE=${SAPORE_ENV_FILE}"

# Verify CHANNEL_ENABLED false in env file
grep -E '^(CHANNEL_ENABLED|NATIVE_CONTROL_VERIFIED|KAPSO_WORKFLOW_ID)=' "${SECRETS}/runtime.env" | sed -E 's/(KAPSO_API_KEY|KAPSO_WEBHOOK_SECRET|KAPSO_FUNCTION_TOKEN)=.*/\1=***/'

docker compose up -d --no-build --force-recreate api worker

sleep 4
curl -sS -o /tmp/health.json -w "health_http=%{http_code}\n" http://127.0.0.1:3100/health
curl -sS -o /tmp/ready.json -w "ready_http=%{http_code}\n" http://127.0.0.1:3100/ready
cat /tmp/health.json; echo
cat /tmp/ready.json; echo

# Confirm container now has non-empty Kapso key/workflow, gates still false
python3 - <<'PY'
import subprocess
out=subprocess.check_output(["docker","inspect","sapore-sdr-api-1","--format","{{range .Config.Env}}{{println .}}{{end}}"], text=True)
for line in out.splitlines():
    if not line or "=" not in line: continue
    k,v=line.split("=",1)
    if k in ("KAPSO_API_KEY","KAPSO_WEBHOOK_SECRET","KAPSO_FUNCTION_TOKEN","KAPSO_WORKFLOW_ID","CHANNEL_ENABLED","NATIVE_CONTROL_VERIFIED","EXECUTION_MODE","PUBLIC_API_URL"):
        print(f"{k}: chars={len(v)}")
PY

echo "DONE postdeploy fix. Trigger remains inactive; outbound remains disabled."
unset KAPSO_API_KEY NEW_SECRET
