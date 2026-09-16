import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/database.js';
import type { AgentDecision } from '../src/domain.js';
import { TurnInputSchema } from '../src/contracts.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { seedPilot } from '../src/seed.js';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';

async function fixture() {
 const actual=await testDatabase(),queries:string[]=[],providerCalls:string[]=[];
 const db:Database={...actual,transaction:fn=>actual.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{queries.push(sql);return tx.query<T>(sql,params);}}))};
 await seedPilot(actual,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
 const store=new Store(db),sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 const created=await sessions.create(user,{requestId:randomUUID(),label:'Controles locais',scenario:'free'});assert.ok(created.ok);
 const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
 const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
 const engine=new Engine(store,testConfig,async url=>{providerCalls.push(String(url));return Response.json({accepted:true});});
 await engine.dispatch(channel,job);queries.length=0;
 const callback=(result:AgentDecision)=>({jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:'gpt-5.4-2026-03-05',usage:{input_tokens:101,output_tokens:10,total_tokens:111},result});
 const state=async()=>(await actual.query<{job_state:string,error_code:string|null,result:AgentDecision,guard_review:unknown,conversation_state:string,epoch:number,lead_status:string}>(`SELECT j.state AS job_state,j.error_code,j.result,j.context->'guardReview' AS guard_review,c.state AS conversation_state,c.epoch,p.lead_state->>'status' AS lead_status
  FROM sdr.jobs j JOIN sdr.conversations c ON(c.tenant_id,c.brand_id,c.id)=(j.tenant_id,j.brand_id,j.conversation_id)
  JOIN sdr.candidates p ON(p.tenant_id,p.brand_id,p.id)=(j.tenant_id,j.brand_id,j.candidate_id) WHERE j.id=$1`,[job.id])).rows[0];
 const reservation=async()=>(await actual.query<{detail:{settled:boolean,costMicroUsd:number}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved' AND detail->>'jobId'=$1",[job.id])).rows[0].detail;
 return {actual,queries,providerCalls,sessions,user,sessionId:created.value.id,job,engine,callback,state,reservation};
}

const decision=(nextAction:AgentDecision['nextAction'],bubbles:string[]):AgentDecision=>({bubbles,proposals:[],relations:[],referral:null,sourceRefs:[],nextAction,handoffReason:nextAction==='handoff'?'Revisão humana solicitada.':null});

test('laboratory continue commits one exact Unicode bubble and settles without exposing private context',async()=>{
 const f=await fixture();
 try {
  const result=decision('continue',['Olá, Marina! 💜\nSeguimos com calma.']);
  assert.deepEqual(await f.engine.complete(f.callback(result)),{accepted:true});
  const state=await f.state();assert.equal(state.job_state,'completed');assert.equal(state.error_code,null);assert.deepEqual(state.result,result);
  assert.equal(state.conversation_state,'automatic');assert.equal(state.epoch,0);assert.equal(state.lead_status,'active');assert.equal(state.guard_review,null);
  assert.equal(f.queries.filter(sql=>sql.startsWith('INSERT INTO sdr.messages')).length,1);
  const detail=await f.sessions.detail(f.user,f.sessionId);assert.ok(detail.ok);
  assert.deepEqual(detail.value.messages.filter(message=>message.actor==='agent').map(message=>({id:message.id,text:message.text})),[{id:f.job.id+':reply:0',text:result.bubbles[0]}]);
  for(const hidden of ['"context"','"guardReview"','"instructions"','"outputSchema"','"backendTimings"'])assert.equal(JSON.stringify(detail.value).includes(hidden),false);
  const budget=await f.reservation();assert.equal(budget.settled,true);assert.equal(budget.costMicroUsd,403);
  assert.equal((await f.actual.query('SELECT id FROM sdr.briefings')).rows.length,0);
  assert.equal((await f.actual.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  assert.deepEqual(f.providerCalls,[testConfig.N8N_WEBHOOK_URL]);
 }finally{await f.actual.close();}
});

test('laboratory nurture completes the job without silently handing the conversation to a human',async()=>{
 const f=await fixture();
 try {
  const result=decision('nurture',['Podemos retomar a conversa quando você preferir.']);
  assert.deepEqual(await f.engine.complete(f.callback(result)),{accepted:true});
  const state=await f.state();assert.equal(state.job_state,'completed');assert.equal(state.conversation_state,'automatic');assert.equal(state.epoch,0);assert.equal(state.lead_status,'nurture');
  assert.equal(state.error_code,null);assert.deepEqual(state.result,result);
  const detail=await f.sessions.detail(f.user,f.sessionId);assert.ok(detail.ok);assert.deepEqual(detail.value.messages.filter(message=>message.actor==='agent').map(message=>message.text),result.bubbles);
  const budget=await f.reservation();assert.equal(budget.settled,true);assert.equal(budget.costMicroUsd,403);
  assert.equal((await f.actual.query('SELECT id FROM sdr.briefings')).rows.length,0);
  assert.equal((await f.actual.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  assert.deepEqual(f.providerCalls,[testConfig.N8N_WEBHOOK_URL]);
 }finally{await f.actual.close();}
});

test('laboratory handoff settles the model cost but pauses locally without assignment or paid briefing',async()=>{
 const f=await fixture();
 try {
  const result=decision('handoff',['O atendimento automático ficará pausado para revisão da equipe.']);
  assert.deepEqual(await f.engine.complete(f.callback(result)),{accepted:true});
  const state=await f.state();assert.equal(state.job_state,'handoff');assert.equal(state.conversation_state,'human');assert.equal(state.epoch,1);assert.equal(state.lead_status,'handoff');
  assert.equal(state.error_code,null);assert.deepEqual(state.result,result);
  const detail=await f.sessions.detail(f.user,f.sessionId);assert.ok(detail.ok);assert.equal(detail.value.session.state,'human');assert.deepEqual(detail.value.messages.filter(message=>message.actor==='agent').map(message=>message.text),result.bubbles);
  const briefings=await f.actual.query('SELECT assignment_status,model_status,usage,model_context FROM sdr.briefings');
  assert.deepEqual(briefings.rows,[{assignment_status:'not_applicable',model_status:'pending',usage:null,model_context:null}]);
  const budget=await f.reservation();assert.equal(budget.settled,true);assert.equal(budget.costMicroUsd,403);
  const blocked=await f.sessions.send(f.user,f.sessionId,{requestId:randomUUID(),text:'Continuar'});assert.equal(blocked.ok,false);if(!blocked.ok)assert.equal(blocked.error.code,'SESSION_PAUSED');
  assert.equal((await f.actual.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  assert.deepEqual(f.providerCalls,[testConfig.N8N_WEBHOOK_URL]);
 }finally{await f.actual.close();}
});

test('laboratory stop commits the terminal job and stopped conversation without continuing collection',async()=>{
 const f=await fixture();
 try {
  const result=decision('stop',['Tudo bem. O atendimento automático será interrompido.']);
  assert.deepEqual(await f.engine.complete(f.callback(result)),{accepted:true});
  const state=await f.state();assert.equal(state.job_state,'handoff');assert.equal(state.conversation_state,'stopped');assert.equal(state.epoch,1);assert.equal(state.lead_status,'stopped');
  assert.equal(state.error_code,null);assert.deepEqual(state.result,result);
  const detail=await f.sessions.detail(f.user,f.sessionId);assert.ok(detail.ok);assert.equal(detail.value.session.state,'stopped');assert.deepEqual(detail.value.messages.filter(message=>message.actor==='agent').map(message=>message.text),result.bubbles);
  assert.deepEqual((await f.actual.query('SELECT assignment_status,model_status,usage,model_context FROM sdr.briefings')).rows,[{assignment_status:'not_applicable',model_status:'pending',usage:null,model_context:null}]);
  const budget=await f.reservation();assert.equal(budget.settled,true);assert.equal(budget.costMicroUsd,403);
  const blocked=await f.sessions.send(f.user,f.sessionId,{requestId:randomUUID(),text:'Continuar'});assert.equal(blocked.ok,false);if(!blocked.ok)assert.equal(blocked.error.code,'SESSION_PAUSED');
  assert.equal((await f.actual.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  assert.deepEqual(f.providerCalls,[testConfig.N8N_WEBHOOK_URL]);
 }finally{await f.actual.close();}
});

test('laboratory guard failure settles usage and publishes only the safe fallback with private rejection evidence',async()=>{
 const f=await fixture();
 try {
  const raw=decision('continue',['Seu retorno é garantido.','Conteúdo privado rejeitado.']);
  assert.deepEqual(await f.engine.complete(f.callback(raw)),{accepted:true});
  const state=await f.state();assert.equal(state.job_state,'handoff');assert.equal(state.conversation_state,'human');assert.equal(state.epoch,1);assert.equal(state.lead_status,'handoff');assert.equal(state.error_code,'POLICY_GUARD');
  const safe={...decision('handoff',['Esse ponto precisa de revisão da equipe. Posso encaminhar o contexto para atendimento humano.']),handoffReason:'response_requires_review'};
  assert.deepEqual(state.result,safe);assert.deepEqual(state.guard_review,{violations:['return_guarantee'],bubbles:raw.bubbles});
  assert.equal(f.queries.filter(sql=>sql.startsWith('INSERT INTO sdr.messages')).length,1);
  const detail=await f.sessions.detail(f.user,f.sessionId);assert.ok(detail.ok);assert.equal(detail.value.session.state,'human');assert.deepEqual(detail.value.messages.filter(message=>message.actor==='agent').map(message=>({id:message.id,text:message.text})),[{id:f.job.id+':reply:0',text:safe.bubbles[0]}]);
  const event=(await f.actual.query<{detail:Record<string,unknown>}>("SELECT detail FROM sdr.events WHERE type='turn_completed' AND detail->>'jobId'=$1",[f.job.id])).rows[0].detail;
  assert.equal(event.guardPassed,false);assert.deepEqual(event.guardViolations,['return_guarantee']);
  for(const visible of [detail.value,event])for(const hidden of [...raw.bubbles,'"context"','"guardReview"','"instructions"','"outputSchema"'])assert.equal(JSON.stringify(visible).includes(hidden),false);
  const budget=await f.reservation();assert.equal(budget.settled,true);assert.equal(budget.costMicroUsd,403);
  assert.deepEqual((await f.actual.query('SELECT assignment_status,model_status,usage,model_context FROM sdr.briefings')).rows,[{assignment_status:'not_applicable',model_status:'pending',usage:null,model_context:null}]);
  assert.equal((await f.actual.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  assert.deepEqual(f.providerCalls,[testConfig.N8N_WEBHOOK_URL]);
 }finally{await f.actual.close();}
});

test('WhatsApp completion remains ready without laboratory message insertion, delivery or budget settlement',async()=>{
 const actual=await testDatabase(),queries:string[]=[],providerCalls:string[]=[];
 const db:Database={...actual,transaction:fn=>actual.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{queries.push(sql);return tx.query<T>(sql,params);}}))};
 try {
  await seedPilot(actual,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const store=new Store(db),input=TurnInputSchema.parse({phoneNumberId:'1093705843816293',conversationId:'wa-controls',contactId:'5511999999999',messageId:'wa-controls-message',text:'Quero conhecer a franquia.',executionId:'wa-execution',controlFingerprint:'wa-initial'});
  const turn=await store.startTurn(input),channel=await store.channel(input.phoneNumberId);
  assert.equal(channel.kind,'whatsapp');
  await actual.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[turn.id]);
  const job=await store.claim(channel);assert.ok(job);
  const engine=new Engine(store,testConfig,async url=>{providerCalls.push(String(url));return Response.json({accepted:true});});
  await engine.dispatch(channel,job);queries.length=0;
  const result=decision('continue',['Olá! 💜','Em qual cidade você pensa em abrir?']);
  assert.deepEqual(await engine.complete({jobId:job.id,contextVersion:job.context_version,configVersion:job.version_id,model:'gpt-5.4-2026-03-05',usage:{input_tokens:101,output_tokens:10,total_tokens:111},result}),{accepted:true});
  assert.deepEqual((await actual.query('SELECT state,result,error_code FROM sdr.jobs WHERE id=$1',[job.id])).rows,[{state:'ready',result,error_code:null}]);
  assert.deepEqual((await actual.query('SELECT state,epoch FROM sdr.conversations WHERE id=$1',[input.conversationId])).rows,[{state:'automatic',epoch:0}]);
  assert.equal(queries.filter(sql=>sql.startsWith('INSERT INTO sdr.messages')).length,0);
  assert.deepEqual((await actual.query('SELECT id,actor,text FROM sdr.messages WHERE conversation_id=$1',[input.conversationId])).rows,[{id:input.messageId,actor:'candidate',text:input.text}]);
  assert.equal((await actual.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  assert.equal((await actual.query('SELECT id FROM sdr.briefings')).rows.length,0);
  assert.equal((await actual.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
  assert.deepEqual(providerCalls,[testConfig.N8N_WEBHOOK_URL]);
 }finally{await actual.close();}
});
