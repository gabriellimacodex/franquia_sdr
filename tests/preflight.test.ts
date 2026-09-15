import test from 'node:test';
import assert from 'node:assert/strict';
import { sprint2Preflight } from '../src/preflight.js';

const secretA='a'.repeat(32),secretB='b'.repeat(32);
const jwt=(role:string)=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({role})).toString('base64url')}.signature`;
const closedConfig=(changes:Record<string,string>={})=>({
 EXECUTION_MODE:'laboratory',DATABASE_URL:'postgres://runtime:private@db.example/sapore',DATABASE_SSL:'true',PORT:'3100',
 PUBLIC_API_URL:'https://sdr.example.com',LAB_ORIGIN:'https://lab.example.com',SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-key',
 N8N_WEBHOOK_URL:'https://n8n.example.com/webhook/private-id',N8N_WEBHOOK_TOKEN:secretA,N8N_CALLBACK_TOKEN:secretB,
 CHANNEL_ENABLED:'false',NATIVE_CONTROL_VERIFIED:'false',RETENTION_ENABLED:'false',...changes,
});

test('Sprint 2 preflight accepts a closed laboratory configuration and emits no secrets',()=>{
 const report=sprint2Preflight(closedConfig());
 assert.deepEqual(report,{ok:true,executionMode:'laboratory',databaseTls:true,retentionEnabled:false,outboundEnabled:false,port:3100,publicApiOrigin:'https://sdr.example.com',labOrigin:'https://lab.example.com',n8nOrigin:'https://n8n.example.com'});
 const serialized=JSON.stringify(report);
 for(const forbidden of ['runtime:private','private-id',secretA,secretB,'public-key'])assert.equal(serialized.includes(forbidden),false);
});

test('Sprint 2 preflight rejects reused internal tokens',()=>{
 assert.throws(()=>sprint2Preflight(closedConfig({N8N_CALLBACK_TOKEN:secretA})),/SPRINT2_PREFLIGHT_GATE_CLOSED/);
});

test('Sprint 2 preflight rejects an insecure Supabase origin',()=>{
 assert.throws(()=>sprint2Preflight(closedConfig({SUPABASE_URL:'http://project.supabase.co'})),/SPRINT2_PREFLIGHT_GATE_CLOSED/);
});

test('Sprint 2 preflight rejects a Supabase service-role key',()=>{
 assert.throws(()=>sprint2Preflight(closedConfig({SUPABASE_ANON_KEY:jwt('service_role')})),/SPRINT2_PREFLIGHT_GATE_CLOSED/);
});

test('Sprint 2 preflight rejects a Supabase secret key',()=>{
 assert.throws(()=>sprint2Preflight(closedConfig({SUPABASE_ANON_KEY:'sb_secret_'+('x'.repeat(32))})),/SPRINT2_PREFLIGHT_GATE_CLOSED/);
});
