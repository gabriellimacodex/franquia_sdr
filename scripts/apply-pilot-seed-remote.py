#!/usr/bin/env python3
"""Apply pilot.json channel/testers/admins to the live DB. No secrets printed."""
from __future__ import annotations

import json
import os
import subprocess
import urllib.parse as u
from pathlib import Path

pilot_path = Path(os.environ.get("PILOT_JSON", "/opt/sapore-sdr/secrets/pilot.json"))
pilot = json.loads(pilot_path.read_text())
db_url = os.environ["DATABASE_URL"]
parsed = u.urlparse(db_url)

def q(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

sql: list[str] = ["BEGIN;"]
sql.append(
    "INSERT INTO sdr.channels(phone_number_id, tenant_id, brand_id, responsible_user_id, enabled) VALUES ("
    f"{q(pilot['phoneNumberId'])}, {q(pilot['tenantId'])}, {q(pilot['brandId'])}, {q(pilot['responsibleUserId'])}, false) "
    "ON CONFLICT (phone_number_id) DO UPDATE SET "
    "tenant_id = EXCLUDED.tenant_id, brand_id = EXCLUDED.brand_id, "
    "responsible_user_id = EXCLUDED.responsible_user_id;"
)
for admin in pilot.get("adminUserIds", []):
    sql.append(
        "INSERT INTO sdr.memberships(user_id, tenant_id, brand_id, role, active) VALUES ("
        f"{q(admin)}, {q(pilot['tenantId'])}, {q(pilot['brandId'])}, 'admin', true) "
        "ON CONFLICT DO NOTHING;"
    )
for tester in pilot.get("testers", []):
    sql.append(
        "INSERT INTO sdr.testers(tenant_id, brand_id, contact_id, label) VALUES ("
        f"{q(pilot['tenantId'])}, {q(pilot['brandId'])}, {q(tester['contactId'])}, {q(tester['label'])}) "
        "ON CONFLICT DO NOTHING;"
    )
sql.append("COMMIT;")
sql.append(
    "SELECT phone_number_id, responsible_user_id IS NOT NULL AS has_responsible, enabled "
    f"FROM sdr.channels WHERE phone_number_id = {q(pilot['phoneNumberId'])};"
)
sql.append(
    "SELECT count(*)::int AS testers FROM sdr.testers "
    f"WHERE tenant_id = {q(pilot['tenantId'])} AND brand_id = {q(pilot['brandId'])};"
)
sql.append(
    "SELECT role, count(*)::int AS n FROM sdr.memberships "
    f"WHERE tenant_id = {q(pilot['tenantId'])} AND brand_id = {q(pilot['brandId'])} AND active "
    "GROUP BY role ORDER BY role;"
)

sql_path = Path("/tmp/apply-pilot-seed.sql")
sql_path.write_text("\n".join(sql) + "\n")

psql_url = (
    f"postgresql://{parsed.username}@{parsed.hostname}:{parsed.port or 5432}{parsed.path}"
    f"?sslmode=require"
)
env = os.environ.copy()
env["PGPASSWORD"] = u.unquote(parsed.password or "")
cmd = [
    "docker",
    "run",
    "--rm",
    "--network",
    "host",
    "-v",
    f"{sql_path}:/seed.sql:ro",
    "-e",
    f"PGPASSWORD={env['PGPASSWORD']}",
    "postgres:16-alpine",
    "psql",
    psql_url,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "/seed.sql",
]
# Avoid printing password-bearing URL
print("applying pilot seed via docker psql...")
result = subprocess.run(cmd, check=False, capture_output=True, text=True)
print(result.stdout)
if result.returncode != 0:
    print(result.stderr[-1000:])
    raise SystemExit(result.returncode)
print("done")
