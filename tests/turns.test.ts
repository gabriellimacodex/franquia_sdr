import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './db-helper.js';
import { Store } from '../src/store.js';
import { TurnInputSchema } from '../src/contracts.js';
import { initialSnapshot } from '../src/seed.js';
import { createServer } from '../src/server.js';
import { testConfig } from './config.js';

import { setup, input } from './turns-fixture.js';
export { setup, input };

test('repeated webhook/workflow input persists one message and one job; new input invalidates previous output',async()=>{
 const {db,store}=await setup();
 try {
  const first=await store.startTurn(input());
  const replay=await store.startTurn(input());
  assert.equal(first.id,replay.id);
  assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,1);
  await store.startTurn(input('m2','Tenho uma dúvida sobre investimento'));
  assert.equal((await store.getJob(first.id)).job.state,'stale');
  assert.equal((await db.query('SELECT * FROM sdr.jobs')).rows.length,2);
  assert.equal((await store.startTurn({...input('unapproved'),contactId:'stranger'})).state,'ignored');
  assert.equal((await db.query('SELECT * FROM sdr.candidates')).rows.length,1);
 } finally { await db.close(); }
});

const reply={bubbles:['Olá! Sou o assistente virtual da Sapore. Qual cidade você considera?'],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
test('native handoff invalidates pending turn, resume does not resurrect it, stop is irreversible by generic resume',async()=>{
 const {db,store}=await setup();
 try{
  const first=await store.startTurn(input());const channel=await store.channel('1052683654599692');
  await store.control(channel,'c1','handoff','native-h1','execution-1','h1');
  assert.equal((await store.getJob(first.id)).job.state,'stale');
  assert.equal((await store.startTurn(input())).state,'handoff');
  await store.control(channel,'c1','resume','native-r1','execution-1','r1');
  assert.equal((await store.getJob(first.id)).job.state,'stale');
  const resumed=await store.startTurn(input('m2','Vamos continuar'));
  assert.notEqual(resumed.id,first.id);
  await store.startTurn(input('m3','Não quero mais receber mensagens'));
  await assert.rejects(store.control(channel,'c1','resume','native-r2'),/RECONSENT/);
  await store.control(channel,'c1','handoff','fallback-after-rejected-resume');
  await assert.rejects(store.control(channel,'c1','resume','native-r3'),/RECONSENT/);
 }finally{await db.close();}
});

test('single-use send permit fails after tester revocation and never permits blind retry',async()=>{
 const {db,store}=await setup();
 try{
  const first=await store.startTurn(input());
  await db.query("UPDATE sdr.jobs SET state='ready',result=$1 WHERE id=$2",[JSON.stringify(reply),first.id]);
  await db.query('UPDATE sdr.testers SET enabled=false');
  assert.equal((await store.authorize(first.id,'execution-1','epoch-1')).authorized,false);
  await db.query('UPDATE sdr.testers SET enabled=true');
  assert.equal((await store.authorize(first.id,'execution-1','epoch-1')).authorized,true);
  assert.equal((await store.authorize(first.id,'execution-1','epoch-1')).authorized,false);
  assert.equal(store.view((await store.getJob(first.id)).job).state,'pending','an in-flight API send must read as pending, never as an ambiguous native send');
  await store.dispatched(first.id);
  assert.equal((await store.getJob(first.id)).job.state,'dispatched');
  assert.equal(store.view((await store.getJob(first.id)).job).state,'unknown');
 }finally{await db.close();}
});

test('known agent WAMID does not create a human handoff, unknown outbound does',async()=>{
 const {db,store}=await setup();
 try{
  const first=await store.startTurn(input());
  await db.query("UPDATE sdr.jobs SET state='ready',result=$1 WHERE id=$2",[JSON.stringify(reply),first.id]);
  await store.authorize(first.id,'execution-1','epoch-1');
  await db.query("UPDATE sdr.deliveries SET message_id='out-known',state='sent'");
  await store.startTurn({...input('m2','São Paulo'),messages:[{id:'out-known',text:reply.bubbles[0],actor:'human',type:'text'}]});
  assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0].state,'automatic');
  await store.startTurn({...input('m3','Obrigado'),messages:[{id:'out-human',text:'Sou o consultor',actor:'human',type:'text'}]});
  assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0].state,'human');
 }finally{await db.close();}
});

test('service window and 30-day retention block old-message replay',async()=>{
 const {db,store}=await setup();
 try{
  const old={...input(),messages:[{id:'m1',text:'Mensagem antiga',actor:'candidate' as const,type:'text' as const,timestamp:new Date(Date.now()-31*86400000).toISOString()}]};
  assert.equal((await store.startTurn(old)).state,'ignored');
  assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,0);
  const first=await store.startTurn(input('m2'));
  await db.query("UPDATE sdr.jobs SET state='ready',result=$1 WHERE id=$2",[JSON.stringify(reply),first.id]);
  await db.query("UPDATE sdr.conversations SET last_inbound_at=now()-interval '25 hours'");
  assert.equal((await store.authorize(first.id,'execution-1','epoch-1')).authorized,false);
 }finally{await db.close();}
});

test('automatic conversation reactivates a lead left in handoff by a previous timeout',async()=>{
 const {db,store}=await setup();
 try{
  await store.startTurn(input());
  await db.query("UPDATE sdr.candidates SET lead_state=jsonb_set(lead_state,'{status}',to_jsonb('handoff'::text))");
  const next=await store.startTurn(input('m2','olá'));
  assert.equal(next.state,'pending');
  assert.ok(next.id);
  assert.equal((await db.query<{s:string}>("SELECT lead_state->>'status' AS s FROM sdr.candidates")).rows[0].s,'active');
 }finally{await db.close();}
});

test('stale outbound history does not pause, and a new running execution retries after timeout handoff',async()=>{
 const {db,store}=await setup();
 try{
  const first=await store.startTurn(input());
  const channel=await store.channel('1052683654599692');
  const stale=new Date(Date.now()-3600_000).toISOString();
  await store.startTurn({...input('m-hist','ainda quero'),messages:[
    {id:'old-template',text:'campanha',actor:'human',type:'text',timestamp:stale},
    {id:'m-hist',text:'ainda quero',actor:'candidate',type:'text'},
  ]});
  assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0].state,'automatic');
  await store.control(channel,'c1','handoff',first.id+':timeout');
  assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0].state,'human');
  const retry=await store.startTurn({...input('m-retry','quero abrir uma franquia'),executionId:'execution-2',controlFingerprint:'execution-2:initial'});
  assert.equal(retry.state,'pending');
  assert.ok(retry.id);
  assert.equal((await db.query<{state:string,execution_id:string}>('SELECT state, execution_id FROM sdr.conversations')).rows[0].state,'automatic');
  assert.equal((await db.query<{execution_id:string}>('SELECT execution_id FROM sdr.conversations')).rows[0].execution_id,'execution-2');
 }finally{await db.close();}
});

test('webhook-first conversation binds the verified native execution once without replacing an existing owner',async()=>{
 const {db,store}=await setup();
 try{
  await store.ingest({...input(),executionId:undefined,controlFingerprint:undefined});
  const turn=await store.startTurn(input());
  await db.query("UPDATE sdr.jobs SET state='ready',result=$1 WHERE id=$2",[JSON.stringify(reply),turn.id]);
  assert.equal((await store.authorize(turn.id,'execution-1','epoch-1')).authorized,true);
  await assert.rejects(store.startTurn({...input('m2'),executionId:'other-execution'}),/OWNER_CHANGED/);
 }finally{await db.close();}
});

test('resume endpoint persists only the native verified control timestamp, never caller-supplied timing',async()=>{
 const {db,store}=await setup();
 const nativeAt=new Date(Date.now()-5000).toISOString();
 let explicitHuman=true;
 const server=await createServer(db,testConfig,{native:async()=>({id:'execution-1',conversationId:'c1',workflowId:'workflow-1',status:'running',controlFingerprint:'execution-1:native-resume',controlEvent:{id:'native-resume',occurredAt:nativeAt,humanResume:explicitHuman}})});
 try{
  await store.ingest(input());const channel=await store.channel('1052683654599692');
  await store.control(channel,'c1','handoff','human-takeover','execution-1');
  const request={method:'POST' as const,url:'/internal/conversations/c1/control',headers:{Authorization:'Bearer '+testConfig.KAPSO_FUNCTION_TOKEN},payload:{phoneNumberId:channel.phoneNumberId,event:'resume',executionId:'execution-1',eventId:'caller-invented',controlFingerprint:'execution-1:native-resume',providerOccurredAt:'2099-01-01T00:00:00Z'}};
  const response=await server.inject(request);
  assert.equal(response.statusCode,200);
  const event=(await db.query<{detail:{providerOccurredAt:string,providerSource:string}}>("SELECT detail FROM sdr.events WHERE type='resume'")).rows[0]!;
  assert.equal(event.detail.providerOccurredAt,nativeAt);
  assert.equal(event.detail.providerSource,'native_execution');
  await store.control(channel,'c1','handoff','new-human-takeover','execution-1');
  explicitHuman=false;
  assert.equal((await server.inject(request)).statusCode,409);
  assert.equal((await db.query<{state:string}>('SELECT state FROM sdr.conversations')).rows[0]?.state,'human');
 }finally{await server.close();await db.close();}
});

test('#reset from a tester wipes memory and provider history cannot restore it',async()=>{
 const {db,store}=await setup();
 try{
  await store.startTurn(input());
  assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,1);
  const reset=await store.startTurn(input('m-reset','#reset'));
  assert.equal(reset.state,'ignored');assert.equal(reset.reset,true);
  assert.equal((await store.startTurn(input('m-reset','#reset'))).reset,undefined,'the same reset command is idempotent');
  // A reset as the first message of a new conversation still creates the conversation row, so the confirmation can be recorded there.
  const fresh=await store.startTurn({...input('m-first','#reset'),conversationId:'c-new'});
  assert.equal(fresh.reset,true);
  assert.equal((await db.query("SELECT id FROM sdr.conversations WHERE id='c-new'")).rows.length,1);
  assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,0);
  assert.equal((await db.query('SELECT * FROM sdr.jobs')).rows.length,0);
  const candidates=(await db.query<{reset_at:string|null}>('SELECT reset_at FROM sdr.candidates')).rows;
  assert.equal(candidates.length,1);assert.ok(candidates[0]!.reset_at);
  // The provider replays the old turn and the command itself; only the new message is ingested.
  const before=new Date(Date.now()-60_000).toISOString();
  const next=await store.startTurn({...input('m3','Voltei do zero'),messages:[
   {id:'m1',text:'Gostaria de conhecer a franquia',type:'text',actor:'candidate',timestamp:before},
   {id:'m-reset',text:'#reset',type:'text',actor:'candidate',timestamp:new Date().toISOString()},
  ]});
  assert.equal(next.state,'pending');
  assert.deepEqual((await db.query<{id:string}>('SELECT id FROM sdr.messages')).rows.map(row=>row.id),['m3']);
  assert.equal((await store.startTurn({...input('m4','#reset'),contactId:'stranger'})).state,'ignored');
  assert.equal((await db.query('SELECT * FROM sdr.candidates')).rows.length,1);
 }finally{await db.close();}
});
