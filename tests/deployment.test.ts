import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('deployment mounts the trusted database CA in both services and binds API only to loopback',async()=>{
 const compose=await readFile(new URL('../compose.yaml',import.meta.url),'utf8');
 assert.equal((compose.match(/secrets: \[supabase-ca\]/g)??[]).length,2);
 assert.match(compose,/supabase-ca:\s+file: \$\{SAPORE_CA_FILE/);
 assert.equal((compose.match(/NODE_EXTRA_CA_CERTS: \/run\/secrets\/supabase-ca/g)??[]).length,2);
 assert.match(compose,/127\.0\.0\.1:3100:3100/);
 assert.equal((compose.match(/env_file: \$\{SAPORE_ENV_FILE:-\.env\}/g)??[]).length,2);
});

test('the expanded total laboratory allowance preserves the same durable gate in both services',async()=>{
 const overlay=await readFile(new URL('../compose.lab-budget.yaml',import.meta.url),'utf8');
 for(const service of ['api','worker']){
  const environment=overlay.match(new RegExp(`^  ${service}:\\n    environment:\\n((?:      .+\\n?)+)`,'m'))?.[1];
  assert.ok(environment,`${service} must retain an explicit budget configuration`);
  assert.match(environment,/LAB_BUDGET_GATE_ID: sprint3-continuous-20260910\s*$/m);
  assert.match(environment,/LAB_BUDGET_LIMIT_MICRO_USD: "1000000"\s*$/m);
 }
 assert.equal((overlay.match(/LAB_BUDGET_GATE_ID:/g)??[]).length,2);
});
