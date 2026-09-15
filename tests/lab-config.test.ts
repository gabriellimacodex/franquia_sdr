import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../src/config.js';
test('laboratory-only configuration needs no Kapso secrets and cannot enable WhatsApp',()=>{
 const input={EXECUTION_MODE:'laboratory',DATABASE_URL:'postgres://local',PUBLIC_API_URL:'https://api.example.com',LAB_ORIGIN:'https://lab.example.com',SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public',N8N_WEBHOOK_URL:'https://n8n.example.com/webhook',N8N_WEBHOOK_TOKEN:'a'.repeat(32),N8N_CALLBACK_TOKEN:'b'.repeat(32)};
 assert.equal(ConfigSchema.safeParse(input).success,true);
 assert.equal(ConfigSchema.safeParse({...input,CHANNEL_ENABLED:'true'}).success,false);
 assert.equal(ConfigSchema.safeParse({...input,RETENTION_ENABLED:'true'}).success,false);
 assert.equal(ConfigSchema.safeParse({...input,EXECUTION_MODE:'whatsapp'}).success,false);
});
