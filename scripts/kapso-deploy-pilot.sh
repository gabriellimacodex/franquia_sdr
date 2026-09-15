#!/usr/bin/env bash
# Deploy Sapore Kapso Functions + draft workflow + inactive trigger + phone webhook.
# Does NOT enable CHANNEL_ENABLED or activate inbound trigger.
# Secrets: source /opt/sapore-sdr/secrets/kapso.env (never echo KAPSO_API_KEY).
set -euo pipefail

ROOT="${SAPORE_ROOT:-/opt/sapore-sdr}"
SECRETS="${ROOT}/secrets"
RELEASE_LINK="${ROOT}/current"
PHONE_NUMBER_ID="${KAPSO_PHONE_NUMBER_ID:-1052683654599692}"
BASE="${KAPSO_API_BASE_URL:-https://api.kapso.ai}"
PUBLIC_API_URL="${PUBLIC_API_URL:-https://sdr-api.cognitaai.com.br}"
WORKDIR="${WORKDIR:-${ROOT}/scratch/kapso-deploy-$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ ! -f "${SECRETS}/kapso.env" ]]; then
  echo "FAIL: missing ${SECRETS}/kapso.env"
  exit 1
fi

set -a
# runtime first (PUBLIC_API_URL etc.), then kapso.env wins for Kapso secrets
if [[ -f "${SECRETS}/runtime.env" ]]; then
  # shellcheck disable=SC1090
  source "${SECRETS}/runtime.env"
fi
# shellcheck disable=SC1090
source "${SECRETS}/kapso.env"
set +a

if [[ -z "${KAPSO_API_KEY:-}" || ${#KAPSO_API_KEY} -lt 32 ]]; then
  echo "FAIL: KAPSO_API_KEY missing/short chars=${#KAPSO_API_KEY}"
  exit 1
fi

# Ensure function/webhook tokens exist (generate once, never print values)
python3 - <<PY
from pathlib import Path
import secrets, re
path = Path("${SECRETS}/kapso.env")
text = path.read_text()
changed = False
def ensure(key):
    global text, changed
    m = re.search(rf'^{key}=(.*)$', text, re.M)
    val = m.group(1).strip() if m else ''
    if len(val) < 32:
        token = secrets.token_hex(32)
        if m:
            text = re.sub(rf'^{key}=.*$', f'{key}={token}', text, count=1, flags=re.M)
        else:
            text = text.rstrip() + f"\n{key}={token}\n"
        changed = True
        print(f'{key}: generated chars={len(token)}')
    else:
        print(f'{key}: kept chars={len(val)}')
ensure('KAPSO_FUNCTION_TOKEN')
ensure('KAPSO_WEBHOOK_SECRET')
if 'KAPSO_PHONE_NUMBER_ID=' not in text:
    text = text.rstrip() + f"\nKAPSO_PHONE_NUMBER_ID=${PHONE_NUMBER_ID}\n"
    changed = True
if changed:
    path.write_text(text)
    path.chmod(0o600)
PY

set -a
# shellcheck disable=SC1090
source "${SECRETS}/kapso.env"
set +a

mkdir -p "${WORKDIR}/functions"
echo "WORKDIR=${WORKDIR}"
echo "PHONE=${PHONE_NUMBER_ID}"
echo "PUBLIC_API_URL=${PUBLIC_API_URL}"
echo "KAPSO_API_KEY chars=${#KAPSO_API_KEY}"

# Expect function sources already copied to WORKDIR/functions/<slug>/index.js
for slug in sapore-session sapore-dispatched sapore-handoff; do
  test -f "${WORKDIR}/functions/${slug}/index.js" || {
    echo "FAIL: missing ${WORKDIR}/functions/${slug}/index.js — copy sources first"
    exit 1
  }
done

auth=(-H "X-API-Key: ${KAPSO_API_KEY}" -H "Content-Type: application/json" -H "Accept: application/json")

create_and_deploy() {
  local slug="$1"
  local code
  code=$(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "${WORKDIR}/functions/${slug}/index.js")
  local payload
  payload=$(python3 - <<PY
import json
code = open("${WORKDIR}/functions/${slug}/index.js").read()
print(json.dumps({
  "function": {
    "name": "${slug}",
    "description": "Sapore SDR v1 — private workflow adapter",
    "code": code,
    "public_endpoint": False,
    "invoke_response_mode": "passthrough"
  }
}))
PY
)
  echo "Creating ${slug}..."
  local http
  http=$(curl -sS -o "${WORKDIR}/create-${slug}.json" -w "%{http_code}" \
    "${auth[@]}" -X POST "${BASE}/platform/v1/functions" -d "${payload}")
  echo "create_${slug}_http=${http}"
  if [[ "${http}" != "200" && "${http}" != "201" ]]; then
    python3 -c "print(open('${WORKDIR}/create-${slug}.json').read()[:800])"
    exit 1
  fi
  local fid
  fid=$(python3 - <<PY
import json
d=json.load(open("${WORKDIR}/create-${slug}.json"))
fn=d.get("data", d).get("function", d.get("data", d))
print(fn.get("id") or "")
PY
)
  test -n "${fid}"
  echo "${slug}_id=${fid}"
  http=$(curl -sS -o "${WORKDIR}/deploy-${slug}.json" -w "%{http_code}" \
    "${auth[@]}" -X POST "${BASE}/platform/v1/functions/${fid}/deploy" -d '{}')
  echo "deploy_${slug}_http=${http}"
  if [[ "${http}" != "200" && "${http}" != "201" && "${http}" != "202" ]]; then
    python3 -c "print(open('${WORKDIR}/deploy-${slug}.json').read()[:800])"
    exit 1
  fi
  # Try to set secrets/config if endpoint exists
  for path in \
    "/platform/v1/functions/${fid}/secrets" \
    "/platform/v1/functions/${fid}/environment" \
    "/platform/v1/functions/${fid}/env"
  do
    body=$(python3 - <<PY
import json, os
print(json.dumps({
  "secrets": {
    "KAPSO_API_KEY": os.environ["KAPSO_API_KEY"],
    "KAPSO_FUNCTION_TOKEN": os.environ["KAPSO_FUNCTION_TOKEN"],
  },
  "config": {
    "SAPORE_API_URL": "${PUBLIC_API_URL}",
    "KAPSO_NATIVE_CONTROL_VERIFIED": "false",
  },
  "environment": {
    "KAPSO_API_KEY": os.environ["KAPSO_API_KEY"],
    "KAPSO_FUNCTION_TOKEN": os.environ["KAPSO_FUNCTION_TOKEN"],
    "SAPORE_API_URL": "${PUBLIC_API_URL}",
    "KAPSO_NATIVE_CONTROL_VERIFIED": "false",
  }
}))
PY
)
    code=$(curl -sS -o "${WORKDIR}/env-${slug}.json" -w "%{http_code}" \
      "${auth[@]}" -X PUT "${BASE}${path}" -d "${body}" || true)
    echo "env_try ${path} http=${code}"
    if [[ "${code}" == "200" || "${code}" == "201" || "${code}" == "204" ]]; then
      break
    fi
    code=$(curl -sS -o "${WORKDIR}/env-${slug}.json" -w "%{http_code}" \
      "${auth[@]}" -X PATCH "${BASE}${path}" -d "${body}" || true)
    echo "env_try_patch ${path} http=${code}"
    if [[ "${code}" == "200" || "${code}" == "201" || "${code}" == "204" ]]; then
      break
    fi
  done
  printf '%s' "${fid}" > "${WORKDIR}/${slug}.id"
}

create_and_deploy sapore-session
create_and_deploy sapore-dispatched
create_and_deploy sapore-handoff

SESSION_ID=$(cat "${WORKDIR}/sapore-session.id")
DISPATCHED_ID=$(cat "${WORKDIR}/sapore-dispatched.id")
HANDOFF_ID=$(cat "${WORKDIR}/sapore-handoff.id")

python3 - <<PY
import json
from pathlib import Path
ids = {
  "session": "${SESSION_ID}",
  "dispatched": "${DISPATCHED_ID}",
  "handoff": "${HANDOFF_ID}",
}
Path("${SECRETS}/verified-function-ids.json").write_text(json.dumps(ids, indent=2) + "\n")
Path("${SECRETS}/verified-function-ids.json").chmod(0o600)
print("saved verified-function-ids.json", ids)
PY

# Build workflow definition with real function IDs (inline, mirrors artifacts.ts)
python3 - <<PY > "${WORKDIR}/workflow-definition.json"
import json
session, dispatched, handoff = "${SESSION_ID}", "${DISPATCHED_ID}", "${HANDOFF_ID}"
ids = {
  "guard": "decide_1788868800000",
  "send": "send_text_1788868800001",
  "dispatched": "function_1788868800002",
  "poll": "wait_for_response_1788868800003",
  "wait": "wait_for_response_1788868800004",
  "recordHandoff": "function_1788868800005",
  "handoff": "handoff_1788868800006",
  "end": "set_variable_1788868800007",
}
nodes = [
  {"id": "start", "position": {"x": 440, "y": 40}, "data": {"node_type": "start", "config": {}}},
  {"id": ids["guard"], "position": {"x": 440, "y": 230}, "data": {"node_type": "decide", "config": {
    "decision_type": "function", "function_id": session,
    "conditions": [
      {"label": "handoff", "description": "Safe first-edge fallback"},
      {"label": "send", "description": "Fresh turn authorized once"},
      {"label": "poll", "description": "n8n job still pending"},
      {"label": "wait", "description": "Wait for candidate message"},
      {"label": "end", "description": "Conversation ended"},
    ],
  }}},
  {"id": ids["send"], "position": {"x": 140, "y": 440}, "data": {"node_type": "send_text", "config": {"message": "{{vars.sapore_reply_text}}", "delay_seconds": 0}}},
  {"id": ids["dispatched"], "position": {"x": 140, "y": 640}, "data": {"node_type": "function", "config": {"function_id": dispatched}}},
  {"id": ids["poll"], "position": {"x": 440, "y": 440}, "data": {"node_type": "wait_for_response", "config": {"has_timeout": True, "timeout_seconds": 10}}},
  {"id": ids["wait"], "position": {"x": 140, "y": 840}, "data": {"node_type": "wait_for_response", "config": {"has_timeout": False}}},
  {"id": ids["recordHandoff"], "position": {"x": 740, "y": 440}, "data": {"node_type": "function", "config": {"function_id": handoff}}},
  {"id": ids["handoff"], "position": {"x": 740, "y": 640}, "data": {"node_type": "handoff", "config": {}}},
  {"id": ids["end"], "position": {"x": 1040, "y": 440}, "data": {"node_type": "set_variable", "config": {"variable_name": "sapore_complete", "variable_value": "true", "value_type": "string"}}},
]
edges = [
  {"source": "start", "target": ids["guard"], "label": "next"},
  {"source": ids["guard"], "target": ids["recordHandoff"], "label": "handoff"},
  {"source": ids["guard"], "target": ids["send"], "label": "send"},
  {"source": ids["guard"], "target": ids["poll"], "label": "poll"},
  {"source": ids["guard"], "target": ids["wait"], "label": "wait"},
  {"source": ids["guard"], "target": ids["end"], "label": "end"},
  {"source": ids["send"], "target": ids["dispatched"], "label": "next"},
  {"source": ids["dispatched"], "target": ids["poll"], "label": "next"},
  {"source": ids["poll"], "target": ids["guard"], "label": "next"},
  {"source": ids["wait"], "target": ids["guard"], "label": "next"},
  {"source": ids["recordHandoff"], "target": ids["handoff"], "label": "next"},
  {"source": ids["handoff"], "target": ids["wait"], "label": "next"},
]
print(json.dumps({"nodes": nodes, "edges": edges}))
PY

workflow_payload=$(python3 - <<PY
import json
definition=json.load(open("${WORKDIR}/workflow-definition.json"))
print(json.dumps({
  "workflow": {
    "name": "Sapore SDR — controle de sessão v1",
    "status": "draft",
    "description": "Piloto interno. Draft sem trigger ativo. Kapso controla sessão/envio.",
    "message_debounce_seconds": 2,
    "definition": definition,
  }
}))
PY
)

echo "Creating workflow draft..."
http=$(curl -sS -o "${WORKDIR}/create-workflow.json" -w "%{http_code}" \
  "${auth[@]}" -X POST "${BASE}/platform/v1/workflows" -d "${workflow_payload}")
echo "create_workflow_http=${http}"
if [[ "${http}" != "200" && "${http}" != "201" ]]; then
  python3 -c "print(open('${WORKDIR}/create-workflow.json').read()[:1200])"
  exit 1
fi

WORKFLOW_ID=$(python3 - <<PY
import json
d=json.load(open("${WORKDIR}/create-workflow.json"))
w=d.get("data", d).get("workflow", d.get("data", d))
print(w.get("id") or "")
PY
)
echo "workflow_id=${WORKFLOW_ID}"
test -n "${WORKFLOW_ID}"

# Inactive inbound trigger (do NOT activate)
trigger_payload=$(python3 - <<PY
import json
print(json.dumps({
  "trigger": {
    "trigger_type": "inbound_message",
    "active": False,
    "phone_number_id": "${PHONE_NUMBER_ID}",
  }
}))
PY
)
http=$(curl -sS -o "${WORKDIR}/create-trigger.json" -w "%{http_code}" \
  "${auth[@]}" -X POST "${BASE}/platform/v1/workflows/${WORKFLOW_ID}/triggers" -d "${trigger_payload}")
echo "create_trigger_http=${http}"
python3 -c "print(open('${WORKDIR}/create-trigger.json').read()[:800])"

# Phone-number webhook to backend (active true for delivery; backend still laboratory-gated)
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
http=$(curl -sS -o "${WORKDIR}/create-webhook.json" -w "%{http_code}" \
  "${auth[@]}" -X POST "${BASE}/platform/v1/whatsapp/phone_numbers/${PHONE_NUMBER_ID}/webhooks" -d "${webhook_payload}")
echo "create_webhook_http=${http}"
python3 -c "print(open('${WORKDIR}/create-webhook.json').read()[:1000])"

# Persist workflow id into kapso.env (no channel enable)
python3 - <<PY
from pathlib import Path
import re
path = Path("${SECRETS}/kapso.env")
text = path.read_text()
wid = "${WORKFLOW_ID}"
if re.search(r'^KAPSO_WORKFLOW_ID=', text, re.M):
    text = re.sub(r'^KAPSO_WORKFLOW_ID=.*$', f'KAPSO_WORKFLOW_ID={wid}', text, flags=re.M)
else:
    text = text.rstrip() + f"\nKAPSO_WORKFLOW_ID={wid}\n"
# keep gates closed
for key, val in [("CHANNEL_ENABLED","false"),("NATIVE_CONTROL_VERIFIED","false")]:
    if re.search(rf'^{key}=', text, re.M):
        text = re.sub(rf'^{key}=.*$', f'{key}={val}', text, flags=re.M)
    else:
        text = text.rstrip() + f"\n{key}={val}\n"
path.write_text(text)
path.chmod(0o600)
print("kapso.env updated with workflow id; gates remain false")
PY

# Merge Kapso keys into runtime.env used by containers (keep CHANNEL_ENABLED=false)
python3 - <<PY
from pathlib import Path
import re
kapso = Path("${SECRETS}/kapso.env").read_text()
runtime_path = Path("${SECRETS}/runtime.env")
runtime = runtime_path.read_text() if runtime_path.exists() else ""
wanted = ["KAPSO_API_KEY","KAPSO_WEBHOOK_SECRET","KAPSO_FUNCTION_TOKEN","KAPSO_WORKFLOW_ID","KAPSO_PHONE_NUMBER_ID","CHANNEL_ENABLED","NATIVE_CONTROL_VERIFIED"]
kv = {}
for line in kapso.splitlines():
    if "=" in line and not line.strip().startswith("#"):
        k,v = line.split("=",1)
        if k in wanted:
            kv[k]=v
# force closed
kv["CHANNEL_ENABLED"]="false"
kv["NATIVE_CONTROL_VERIFIED"]="false"
for k,v in kv.items():
    if re.search(rf'^{k}=', runtime, re.M):
        runtime = re.sub(rf'^{k}=.*$', f'{k}={v}', runtime, flags=re.M)
    else:
        runtime = runtime.rstrip() + f"\n{k}={v}\n"
runtime_path.write_text(runtime)
runtime_path.chmod(0o600)
print("runtime.env merged Kapso keys; CHANNEL_ENABLED=false")
for k in wanted:
    val = kv.get(k,"")
    if k == "KAPSO_API_KEY":
        print(f"{k}: chars={len(val)}")
    else:
        print(f"{k}: chars={len(val)}")
PY

echo
echo "DONE deploy draft. Next: restart api/worker to load runtime.env, still with outbound disabled."
echo "Do NOT set CHANNEL_ENABLED=true yet."
echo "SUMMARY workflow=${WORKFLOW_ID} session=${SESSION_ID} dispatched=${DISPATCHED_ID} handoff=${HANDOFF_ID}"
