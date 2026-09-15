#!/usr/bin/env bash
# Update Kapso function code for new phone, sync secrets, enable native control for send.
set -euo pipefail
SECRETS=/opt/sapore-sdr/secrets
BASE=https://api.kapso.ai
PHONE=1093705843816293
RELEASE=/opt/sapore-sdr/releases/20260914T043000Z/sapore-sdr
WORKDIR="${WORKDIR:?set WORKDIR with updated function sources}"

set -a
# shellcheck disable=SC1091
source "${SECRETS}/runtime.env"
# shellcheck disable=SC1091
source "${SECRETS}/kapso.env"
set +a

auth=(-H "X-API-Key: ${KAPSO_API_KEY}" -H "Content-Type: application/json" -H "Accept: application/json")

SESSION=676ecedd-1ba3-42bd-a5d4-0e005d61ce01
DISPATCHED=b0abed08-a98f-4c7c-9050-30c357aa9425
HANDOFF=fefcddbb-4bfa-474c-a133-625b3ce966a7

update_fn() {
  local fid="$1" slug="$2"
  local code_file="${WORKDIR}/functions/${slug}/index.js"
  test -f "$code_file"
  local payload
  payload=$(python3 - <<PY
import json
print(json.dumps({
  "function": {
    "name": "${slug}",
    "code": open("${code_file}").read(),
    "public_endpoint": False,
    "invoke_response_mode": "passthrough",
  }
}))
PY
)
  local code
  code=$(curl -sS -o "/tmp/upd-${slug}.json" -w "%{http_code}" -X PATCH "${auth[@]}" \
    "${BASE}/platform/v1/functions/${fid}" -d "${payload}")
  echo "update_${slug} http=${code}"
  if [[ "${code}" != "200" ]]; then python3 -c "print(open('/tmp/upd-${slug}.json').read()[:400])"; exit 1; fi
  code=$(curl -sS -o "/tmp/dep-${slug}.json" -w "%{http_code}" -X POST "${auth[@]}" \
    "${BASE}/platform/v1/functions/${fid}/deploy" -d '{}')
  echo "deploy_${slug} http=${code}"
}

update_fn "$SESSION" sapore-session
update_fn "$DISPATCHED" sapore-dispatched
update_fn "$HANDOFF" sapore-handoff

set_secret() {
  local fid="$1" name="$2" value="$3"
  local body
  body=$(python3 -c "import json,sys; print(json.dumps({'secret':{'name':sys.argv[1],'value':sys.argv[2]}}))" "$name" "$value")
  local code
  code=$(curl -sS -o /tmp/sec.json -w "%{http_code}" -X POST "${auth[@]}" \
    "${BASE}/platform/v1/functions/${fid}/secrets" -d "${body}")
  echo "secret ${name} on ${fid:0:8} http=${code}"
}

for fid in "$SESSION" "$DISPATCHED" "$HANDOFF"; do
  set_secret "$fid" SAPORE_API_URL "https://sdr-api.cognitaai.com.br"
  set_secret "$fid" KAPSO_FUNCTION_TOKEN "$KAPSO_FUNCTION_TOKEN"
  set_secret "$fid" KAPSO_PHONE_NUMBER_ID "$PHONE"
  set_secret "$fid" KAPSO_NATIVE_CONTROL_VERIFIED true
done
set_secret "$SESSION" KAPSO_API_KEY "$KAPSO_API_KEY"

# Flip runtime native control verified
python3 - <<'PY'
from pathlib import Path
import re
for name in ["runtime.env", "kapso.env"]:
    path = Path("/opt/sapore-sdr/secrets") / name
    text = path.read_text()
    updates = {
        "NATIVE_CONTROL_VERIFIED": "true",
        "CHANNEL_ENABLED": "true",
        "EXECUTION_MODE": "whatsapp",
        "KAPSO_PHONE_NUMBER_ID": "1093705843816293",
    }
    for key, val in updates.items():
        if name == "kapso.env" and key == "EXECUTION_MODE":
            continue
        if re.search(rf"^{key}=", text, re.M):
            text = re.sub(rf"^{key}=.*$", f"{key}={val}", text, flags=re.M)
        else:
            text = text.rstrip() + f"\n{key}={val}\n"
    path.write_text(text)
    path.chmod(0o600)
print("runtime native control enabled")
PY

cd "${RELEASE}"
export SAPORE_ENV_FILE=/opt/sapore-sdr/secrets/runtime.env
export SAPORE_CA_FILE=/opt/sapore-sdr/secrets/supabase-ca.crt
export SAPORE_IMAGE
SAPORE_IMAGE=$(docker inspect sapore-sdr-api-1 --format '{{.Config.Image}}')
docker compose up -d --no-build --force-recreate api worker
sleep 5
curl -sS http://127.0.0.1:3100/health; echo
python3 - <<'PY'
import subprocess
out=subprocess.check_output(["docker","inspect","sapore-sdr-api-1","--format","{{range .Config.Env}}{{println .}}{{end}}"], text=True)
for line in out.splitlines():
    if "=" not in line: continue
    k,v=line.split("=",1)
    if k in ("NATIVE_CONTROL_VERIFIED","CHANNEL_ENABLED","EXECUTION_MODE","KAPSO_PHONE_NUMBER_ID","KAPSO_WORKFLOW_ID"):
        print(f"container {k}={v}")
PY

# verify function auth with Bearer
code=$(curl -sS -o /tmp/sess.json -w "%{http_code}" -X POST \
  -H "content-type: application/json" \
  -H "Authorization: Bearer ${KAPSO_FUNCTION_TOKEN}" \
  "https://sdr-api.cognitaai.com.br/internal/kapso/session" \
  -d '{"brand_id":"sapore","phone_number_id":"1093705843816293","conversation_id":"d7af9c01-4bf9-46c9-a06a-0cfbe733d09f","contact_id":"5511957166850","message_id":"probe","message_text":"oi","execution_id":"probe"}')
echo "session_probe_http=${code}"
python3 -c "print(open('/tmp/sess.json').read()[:500])"

echo "DONE. Send a new WhatsApp message to +55 11 93621-2410."
unset KAPSO_API_KEY
