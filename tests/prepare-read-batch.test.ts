import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/database.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';
import { seedPilot } from '../src/seed.js';
import { AGENT_OUTPUT_JSON_SCHEMA } from '../src/domain.js';
import { ServiceError } from '../src/security.js';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';

async function fixture() {
 const actual=await testDatabase(),calls={transactions:0,queries:[] as string[],time:0};
 const db:Database={
  query:async<T>(sql:string,params?:unknown[])=>{calls.queries.push(sql);calls.time+=150;return actual.query<T>(sql,params);},
  transaction:async fn=>{
   calls.transactions++;calls.time+=150;
   try{return await actual.transaction(tx=>fn({query:async<T>(sql:string,params?:unknown[])=>{calls.queries.push(sql);calls.time+=150;return tx.query<T>(sql,params);}}));}
   finally{calls.time+=150;}
  },
  close:()=>actual.close(),
 };
 await seedPilot(actual,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
 const store=new Store(db),sessions=new LabSessions(db),user={tenantId:'cognita-homologacao',brandId:'sapore',userId:'tester',role:'tester'};
 const created=await sessions.create(user,{requestId:randomUUID(),label:'Leituras locais',scenario:'free'});assert.ok(created.ok);
 const sent=await sessions.send(user,created.value.id,{requestId:randomUUID(),text:'Quero conhecer a franquia.'});assert.ok(sent.ok);assert.ok(sent.value.jobId);
 const channel=await store.scopeForJob(sent.value.jobId),job=await store.claim(channel);assert.ok(job);
 const reset=()=>{calls.transactions=0;calls.queries.length=0;calls.time=0;};
 return {actual,db,store,channel,job,calls,reset};
}

test('preparation batches three reads while preserving the 24-message context and timestamp order',async()=>{
 const f=await fixture();
 try {
  const scope=[f.channel.tenantId,f.channel.brandId];
  await f.actual.query("UPDATE sdr.messages SET provider_timestamp='2026-09-10T00:00:00Z' WHERE id=$1",[f.job.trigger_message_id]);
  const expected=[];
  for(let index=0;index<27;index++) {
   const id='history-'+index,actor=['candidate','agent','human'][index%3],text='Mensagem fictícia '+index;
   const timestamp='2026-09-11T12:00:'+String(index).padStart(2,'0')+'.123456+03:00';
   await f.actual.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'text',$7,$8,$8)`,[id,...scope,f.job.conversation_id,f.job.candidate_id,actor,text,timestamp]);
   if(index>=3)expected.push({id,role:actor==='candidate'?'user':actor==='human'?'operator':'assistant',text,type:'text',createdAt:new Date(timestamp).toISOString()});
  }
  const originalLead=(await f.actual.query<{lead_state:unknown}>('SELECT lead_state FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[...scope,f.job.candidate_id])).rows[0].lead_state;
  const engine=new Engine(f.store,{...testConfig,OPENAI_API_KEY:'synthetic-never-used'},async()=>{assert.fail('laboratory prepare must not call a provider');},()=>f.calls.time);
  f.reset();const prepared=await engine.prepare(f.channel,f.job);
  assert.equal(f.calls.queries.length,5,'scope + grouped reads + canonical sources + ranking + context update');
  assert.equal(f.calls.transactions,1);
  assert.equal(f.calls.time,7*150,'one preparation transaction saves two simulated database round trips');
  assert.equal(f.calls.queries.filter(sql=>sql.includes('FROM sdr.messages')).length,1);
  assert.equal(f.calls.queries.filter(sql=>sql.includes('FROM sdr.versions')).length,2,'canonical retrieval remains independently validated');
  assert.deepEqual(prepared.context.messages,expected);
  assert.deepEqual(prepared.context.lead,originalLead);
  assert.equal(prepared.context.retrieval,'lexical');
  assert.ok(prepared.context.sources.length>0);
  assert.equal(prepared.model,'gpt-5.4-2026-03-05');
  assert.equal(prepared.configVersion,f.job.version_id);
  assert.deepEqual(prepared.outputSchema,AGENT_OUTPUT_JSON_SCHEMA);
  const persisted=(await f.actual.query<{context:Record<string,unknown>}>('SELECT context FROM sdr.jobs WHERE id=$1',[f.job.id])).rows[0].context;
  assert.deepEqual(persisted.messages,expected);
  assert.deepEqual(persisted.lead,originalLead);
 }finally{await f.db.close();}
});

test('grouped preparation cannot mix colliding version, candidate or message ids across scope',async()=>{
 const f=await fixture();
 try {
  const originalLead=(await f.actual.query<{lead_state:unknown}>('SELECT lead_state FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[f.channel.tenantId,f.channel.brandId,f.job.candidate_id])).rows[0].lead_state;
  for(const [tenantId,brandId] of [['foreign-tenant',f.channel.brandId],[f.channel.tenantId,'foreign-brand']]) {
   const params=[tenantId,brandId,f.channel.tenantId,f.channel.brandId];
   await f.actual.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2)',[tenantId,brandId]);
   await f.actual.query(`INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model)
    SELECT id,$1,$2,label,snapshot||jsonb_build_object('tenant',(snapshot->'tenant')||jsonb_build_object('tenantId',$1::text,'brandId',$2::text),'sources','[]'::jsonb,'prompt','FOREIGN PRIVATE PROMPT'),content_hash,model
    FROM sdr.versions WHERE tenant_id=$3 AND brand_id=$4 AND id=$5`,[...params,f.job.version_id]);
   await f.actual.query(`INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state)
    SELECT id,$1,$2,contact_id,authorized_contact_id,label,lead_state||jsonb_build_object('tenantId',$1::text,'brandId',$2::text)
    FROM sdr.candidates WHERE tenant_id=$3 AND brand_id=$4 AND id=$5`,[...params,f.job.candidate_id]);
   const phoneNumberId='foreign-'+tenantId+'-'+brandId;
   await f.actual.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,kind) VALUES($1,$2,$3,'laboratory')",[phoneNumberId,tenantId,brandId]);
   await f.actual.query('INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) VALUES($1,$2,$3,$4,$5)',[f.job.conversation_id,tenantId,brandId,f.job.candidate_id,phoneNumberId]);
   await f.actual.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp)
    VALUES($1,$2,$3,$4,$5,'candidate','text','FOREIGN PRIVATE MESSAGE','2027-01-01T00:00:00Z')`,[f.job.trigger_message_id,tenantId,brandId,f.job.conversation_id,f.job.candidate_id]);
  }
  const engine=new Engine(f.store,testConfig,async()=>{assert.fail('preparation must remain offline');});
  const prepared=await engine.prepare(f.channel,f.job);
  assert.equal(prepared.context.messages.length,1);
  assert.equal(prepared.context.messages[0].text,'Quero conhecer a franquia.');
  assert.deepEqual(prepared.context.lead,originalLead);
  assert.equal(prepared.context.tenant.tenantId,f.channel.tenantId);
  assert.equal(prepared.context.tenant.brandId,f.channel.brandId);
  assert.equal(JSON.stringify(prepared).includes('FOREIGN PRIVATE'),false);
  assert.ok(prepared.context.sources.every(source=>source.tenantId===f.channel.tenantId&&source.brandId===f.channel.brandId));
 }finally{await f.db.close();}
});

test('invalid or missing preparation inputs leave the previous context untouched',async()=>{
 const f=await fixture();
 try {
  const engine=new Engine(f.store,testConfig,async()=>{assert.fail('invalid preparation must not call a provider');});
  const sentinel={private:'previous-context'};
  await f.actual.query('UPDATE sdr.jobs SET context=$2 WHERE id=$1',[f.job.id,JSON.stringify(sentinel)]);
  const originalLead=(await f.actual.query<{lead_state:Record<string,unknown>}>('SELECT lead_state FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[f.channel.tenantId,f.channel.brandId,f.job.candidate_id])).rows[0].lead_state;
  const checkContext=async()=>assert.deepEqual((await f.actual.query<{context:unknown}>('SELECT context FROM sdr.jobs WHERE id=$1',[f.job.id])).rows[0].context,sentinel);
  const mismatchedVersion='mismatched-'+randomUUID();
  await f.actual.query(`INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model)
   SELECT $4,tenant_id,brand_id,label,snapshot||jsonb_build_object('tenant',(snapshot->'tenant')||jsonb_build_object('tenantId','foreign-tenant'),'sources','[]'::jsonb),md5($4),model
   FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3`,[f.channel.tenantId,f.channel.brandId,f.job.version_id,mismatchedVersion]);
  await assert.rejects(engine.prepare(f.channel,{...f.job,version_id:mismatchedVersion}),error=>error instanceof ServiceError&&error.code==='VERSION_SCOPE_MISMATCH');
  await checkContext();
  await f.actual.query('UPDATE sdr.candidates SET lead_state=$4 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[f.channel.tenantId,f.channel.brandId,f.job.candidate_id,JSON.stringify({...originalLead,leadId:'other-candidate'})]);
  await assert.rejects(engine.prepare(f.channel,f.job),error=>error instanceof ServiceError&&error.code==='MEMORY_SCOPE_MISMATCH');
  await checkContext();
  await f.actual.query('UPDATE sdr.candidates SET lead_state=$4 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[f.channel.tenantId,f.channel.brandId,f.job.candidate_id,JSON.stringify(originalLead)]);
  await assert.rejects(engine.prepare(f.channel,{...f.job,version_id:'missing-version'}),TypeError);
  await checkContext();
  await assert.rejects(engine.prepare(f.channel,{...f.job,candidate_id:'missing-candidate'}),TypeError);
  await checkContext();
 }finally{await f.db.close();}
});
