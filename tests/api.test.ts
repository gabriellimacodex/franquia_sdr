import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from '../src/server.js';
import { testConfig } from './config.js';
import { testDatabase } from './db-helper.js';
import { seedPilot } from '../src/seed.js';

test('HTTP authentication rejects missing/wrong internal tokens, forged webhooks and nonmembers',async()=>{
 const db=await testDatabase();
 const transport:typeof fetch=async()=>Response.json({id:'auth-user'});
 const app=await createServer(db,testConfig,{transport});
 try{
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional internal tester'}],adminUserIds:[]});
  assert.equal((await app.inject({method:'POST',url:'/internal/turns',payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/internal/turns',headers:{authorization:'Bearer '+testConfig.N8N_CALLBACK_TOKEN},payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/webhooks/kapso',payload:{},headers:{'x-webhook-signature':'wrong'}})).statusCode,401);
  assert.equal((await app.inject('/v1/conversations')).statusCode,401);
  assert.equal((await app.inject({url:'/v1/conversations',headers:{authorization:'Bearer synthetic-session'}})).statusCode,403);
  await db.query("INSERT INTO sdr.memberships VALUES ('auth-user','cognita-homologacao','sapore','reviewer',true)");
  const success=await app.inject({url:'/v1/conversations',headers:{authorization:'Bearer synthetic-session'}});
  assert.equal(success.statusCode,200);assert.deepEqual(success.json(),{conversations:[]});
  const whatsapp=await app.inject({url:'/v1/conversations?kind=whatsapp',headers:{authorization:'Bearer synthetic-session'}});
  assert.equal(whatsapp.statusCode,200);assert.deepEqual(whatsapp.json(),{conversations:[]});
  assert.equal((await app.inject({url:'/v1/conversations?kind=sms',headers:{authorization:'Bearer synthetic-session'}})).statusCode,400);
  assert.equal((await app.inject({url:'/v1/conversations',headers:{authorization:'Bearer synthetic-session','x-brand-id':'other'}})).statusCode,403);
  const raw='{ "event": "unknown" }';
  const signature=createHmac('sha256',testConfig.KAPSO_WEBHOOK_SECRET).update(raw).digest('hex');
  assert.equal((await app.inject({method:'POST',url:'/webhooks/kapso',payload:raw,headers:{'content-type':'application/json','x-webhook-signature':signature}})).statusCode,200);
  assert.equal((await db.query('SELECT * FROM sdr.webhook_receipts')).rows.length,1);
 }finally{await app.close();await db.close();}
});
