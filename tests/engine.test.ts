import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './db-helper.js';
import { seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { TurnInputSchema } from '../src/contracts.js';
import { testConfig } from './config.js';
import { randomUUID } from 'node:crypto';
import { LabSessions } from '../src/lab-sessions.js';

test('structured model completion persists evidence and replay/stale completion cannot change memory',async()=>{
 const db=await testDatabase(),store=new Store(db);
 try{
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const input=TurnInputSchema.parse({phoneNumberId:'1093705843816293',conversationId:'c1',contactId:'5511999999999',messageId:'m1',text:'Tenho entre 250 e 280 mil próprios.',executionId:'e1',controlFingerprint:'e1:initial'});
  const turn=await store.startTurn(input);const channel=await store.channel(input.phoneNumberId);
  await db.query("UPDATE sdr.jobs SET available_at=now()");const job=(await store.claim(channel))!;
  const calls:string[]=[];const transport:typeof fetch=async url=>{calls.push(String(url));return Response.json({accepted:true},{status:202});};
  const engine=new Engine(store,testConfig,transport);await engine.dispatch(channel,job);
  assert.equal(calls.length,1);assert.equal(calls[0],testConfig.N8N_WEBHOOK_URL);
  const result={bubbles:['Obrigado. Em qual cidade você considera abrir a franquia?'],proposals:[{field:'capital_available',value:{kind:'number_range',min:250000,max:280000,unit:'BRL'},evidence:{messageId:'m1',quote:input.text},attribution:'candidate',capitalOrigin:'own',relationId:null,replacesFactId:null}],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
  const completion={jobId:turn.id,contextVersion:turn.contextVersion,configVersion:job.version_id,model:'gpt-5.4-2026-03-05',result,usage:{input_tokens:123,output_tokens:50}};
  assert.equal((await engine.complete(completion)).accepted,true);
  const facts=(await db.query<{data:{status:string,value:{min:number,max:number}}}>('SELECT data FROM sdr.facts')).rows;
  assert.equal(facts.length,1);assert.equal(facts[0].data.status,'declared');assert.equal(facts[0].data.value.min,250000);assert.equal(facts[0].data.value.max,280000);
  assert.equal((await engine.complete(completion)).accepted,false);
  const second=await store.startTurn({...input,messageId:'m2',text:'Correção: são 220 mil.'});
  await db.query("UPDATE sdr.jobs SET available_at=now() WHERE id=$1",[second.id]);const job2=(await store.claim(channel))!;await engine.dispatch(channel,job2);
  await store.control(channel,'c1','handoff','operator-handoff');
  assert.equal((await engine.complete({...completion,jobId:second.id,contextVersion:second.contextVersion})).accepted,false);
  assert.equal((await db.query('SELECT * FROM sdr.facts')).rows.length,1);
 }finally{await db.close();}
});

test('guard rejection records only violation codes while accepted events omit private decision content',async()=>{
 const db=await testDatabase(),store=new Store(db);
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const engine=new Engine(store,testConfig,async()=>Response.json({accepted:true},{status:202}));
  for(const [index,bubble] of ['Olá, candidato fictício. Qual cidade você considera?','Seu retorno é garantido.'].entries()) {
   const turn=await store.startTurn(TurnInputSchema.parse({phoneNumberId:'1093705843816293',conversationId:'guard-telemetry',contactId:'5511999999999',messageId:'guard-message-'+index,text:'Quero saber mais.',executionId:'guard-execution',controlFingerprint:'guard-execution:initial'}));
   const channel=await store.channel('1093705843816293');
   await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[turn.id]);
   const job=await store.claim(channel);assert.ok(job);await engine.dispatch(channel,job);
   const result={bubbles:[bubble],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
   assert.equal((await engine.complete({jobId:job.id,contextVersion:job.context_version,result})).accepted,true);
   const event=(await db.query<{detail:Record<string,unknown>}>("SELECT detail FROM sdr.events WHERE type='turn_completed' AND detail->>'jobId'=$1",[job.id])).rows[0].detail;
   const {timings,...audit}=event;assert.ok(timings);
   assert.deepEqual(audit,{jobId:job.id,versionId:job.version_id,guardPassed:index===0,...(index===1?{guardViolations:['return_guarantee']}:{})});
   for(const privateText of [bubble,'instructions','outputSchema','bubbles','proposals'])assert.equal(JSON.stringify(event).includes(privateText),false);
   const context=(await db.query<{context:Record<string,unknown>}>('SELECT context FROM sdr.jobs WHERE id=$1',[job.id])).rows[0].context;
   assert.equal('guardReview' in context,false);
  }
 }finally{await db.close();}
});

test('rejected laboratory bubbles are reviewable privately but never exposed in tester session detail',async()=>{
 const db=await testDatabase(),store=new Store(db),sessions=new LabSessions(db);
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
  const created=await sessions.create(user,{requestId:randomUUID(),label:'Revisão privada',scenario:'free'});assert.ok(created.ok);
  const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero saber mais.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
  const channel=await store.scopeForJob(sent.value.jobId);
  await db.query('UPDATE sdr.jobs SET available_at=now() WHERE id=$1',[sent.value.jobId]);
  const job=await store.claim(channel);assert.ok(job);
  const engine=new Engine(store,testConfig,async()=>Response.json({accepted:true}));await engine.dispatch(channel,job);
  const bubbles=['Seu retorno é garantido.'];
  assert.equal((await engine.complete({jobId:job.id,contextVersion:job.context_version,result:{bubbles,proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null}})).accepted,true);
  const stored=(await db.query<{context:{guardReview:unknown,sources:unknown}}>('SELECT context FROM sdr.jobs WHERE id=$1',[job.id])).rows[0].context;
  assert.deepEqual(stored.guardReview,{violations:['return_guarantee'],bubbles});
  assert.ok(stored.sources);
  const visible=await sessions.detail(user,created.value.id);assert.ok(visible.ok);
  const serialized=JSON.stringify(visible.value);
  for(const hidden of ['"guardReview"','"context"',bubbles[0],'"instructions"','"outputSchema"'])assert.equal(serialized.includes(hidden),false);
  assert.ok(visible.value.messages.some(message=>String(message.text).includes('revisão')));
 }finally{await db.close();}
});
