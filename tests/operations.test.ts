import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './db-helper.js';
import type { Database } from '../src/database.js';
import { createLeadState } from '../src/domain.js';
import { readFile } from 'node:fs/promises';

test('runtime role gate rejects superusers and accepts only a non-bypassing runtime role', async () => {
  const {assertRuntimeRole}=await import('../src/operations.js');
  const db=await testDatabase();
  try {
    assert.deepEqual(await assertRuntimeRole(db),{ok:false,error:{code:'UNSAFE_DATABASE_ROLE'}});
    await db.query('CREATE ROLE sdr_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
    await db.query('SET ROLE sdr_runtime');
    assert.deepEqual(await assertRuntimeRole(db),{ok:true,value:{role:'sdr_runtime'}});
  } finally {await db.close();}
});

test('retention also removes orphaned evidence copied into recent completed job snapshots',async()=>{
  const {purgeRetention}=await import('../src/operations.js');
  const db=await testDatabase();
  try {
    await retentionFixture(db);
    await db.query("UPDATE sdr.jobs SET state='sent',context=$1,result=$2 WHERE id='job-mixed'",[JSON.stringify({messages:[{id:'already-purged',createdAt:OLD,text:'Expired orphan'}]}),JSON.stringify({bubbles:['Expired orphan'],proposals:[{evidence:{messageId:'already-purged',quote:'Expired orphan'}}]})]);
    assert.equal((await purgeRetention(db,30,{dryRun:false,now:NOW})).ok,true);
    assert.deepEqual((await db.query('SELECT context,result FROM sdr.jobs')).rows[0],{context:null,result:null});
  }finally{await db.close();}
});

test('explicit runtime grants enforce RLS and still allow the scoped retention sweep',async()=>{
  const {assertRuntimeRole,purgeRetention}=await import('../src/operations.js');
  const db=await testDatabase();
  try {
    await retentionFixture(db);
    const sql=await readFile(new URL('../scripts/provision-runtime-role.sql',import.meta.url),'utf8');
    for(const statement of sql.split('-- statement-breakpoint'))await db.query(statement);
    await db.query('SET ROLE sdr_runtime');
    assert.equal((await assertRuntimeRole(db)).ok,true);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,0);
    assert.equal((await purgeRetention(db,30,{dryRun:false,now:NOW})).ok,true);
    await assert.rejects(db.query("DELETE FROM sdr.versions"),/permission denied/);
    await assert.rejects(db.query("UPDATE sdr.channels SET enabled=true"),/permission denied/);
    await db.query('RESET ROLE');
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,2);
    assert.equal((await db.query('SELECT * FROM sdr.knowledge_chunks')).rows.length,1);
  }finally{await db.close();}
});

test('explicit retention removes expired data and derived snapshots without erasing recent facts or approved brand versions',async()=>{
  const {purgeRetention}=await import('../src/operations.js');
  const db=await testDatabase();
  try {
    await retentionFixture(db);
    const result=await purgeRetention(db,30,{dryRun:false,now:NOW});
    assert.equal(result.ok,true);
    const candidates=(await db.query<{id:string,lead_state:Record<string,unknown>}>('SELECT id,lead_state FROM sdr.candidates ORDER BY id')).rows;
    assert.deepEqual(candidates.map(row=>row.id),['active','foreign']);
    const active=candidates.find(row=>row.id==='active')!;
    assert.ok(!JSON.stringify(active.lead_state).includes('Expired'));
    assert.ok(JSON.stringify(active.lead_state).includes('Recent city'));
    assert.deepEqual((active.lead_state.facts as {id:string,replacesFactId:unknown}[]).map(f=>[f.id,f.replacesFactId]),[['new-fact',null]]);
    assert.equal(active.lead_state.referral,null);
    assert.deepEqual((await db.query<{id:string}>('SELECT id FROM sdr.facts')).rows.map(f=>f.id),['new-fact']);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,2);
    assert.equal((await db.query("SELECT * FROM sdr.messages WHERE brand_id='other' AND id='old-message'")).rows.length,1);
    assert.deepEqual((await db.query<{context:unknown,result:unknown,state:string}>("SELECT context,result,state FROM sdr.jobs WHERE id='job-mixed'")).rows[0],{context:null,result:null,state:'stale'});
    assert.equal((await db.query('SELECT * FROM sdr.briefings')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM sdr.evaluations')).rows.length,0);
    assert.equal((await db.query("SELECT * FROM sdr.events WHERE type='message_note'")).rows.length,0);
    assert.equal((await db.query('SELECT * FROM sdr.webhook_receipts')).rows.length,0);
    assert.equal((await db.query('SELECT * FROM sdr.versions')).rows.length,1);
    assert.equal((await db.query('SELECT * FROM sdr.active_versions')).rows.length,1);
    assert.equal((await db.query('SELECT * FROM sdr.knowledge_chunks')).rows.length,1);
    const second=await purgeRetention(db,30,{dryRun:false,now:NOW});
    assert.equal(second.ok,true);
    if(second.ok)assert.equal(Object.values(second.value.counts).reduce((a,b)=>a+b,0),0);
  }finally{await db.close();}
});

const NOW=new Date('2026-09-08T12:00:00Z');
const OLD='2026-07-01T12:00:00Z';
const RECENT='2026-09-07T12:00:00Z';

async function retentionFixture(db:Database) {
  await db.query("INSERT INTO sdr.brands VALUES ('tenant','sapore','Sapore'),('tenant','other','Other')");
  await db.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id) VALUES ('1052683654599692','tenant','sapore'),('2222222222222222','tenant','other')");
  await db.query("INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES ('v1','tenant','sapore','v1','{}','immutable','model')");
  await db.query("INSERT INTO sdr.active_versions VALUES ('tenant','sapore','v1')");
  await db.query("INSERT INTO sdr.knowledge_chunks(tenant_id,brand_id,version_id,id,title,content,approved,active,valid_from) VALUES('tenant','sapore','v1','knowledge','Approved brand material','Keep this approved knowledge',true,true,$1)",[OLD]);
  const oldFact={field:'city',value:{kind:'text',text:'Expired city'},evidence:{messageId:'old-message',quote:'Expired city'},attribution:'candidate',capitalOrigin:null,relationId:null,replacesFactId:null,id:'old-fact',status:'declared',confirmedBy:null,createdAt:OLD,origin:'candidate_message'};
  const newFact={...oldFact,id:'new-fact',value:{kind:'text',text:'Recent city'},evidence:{messageId:'new-message',quote:'Recent city'},replacesFactId:'old-fact',createdAt:RECENT};
  const oldRelation={id:'old-relation',name:'Expired partner',role:'partner',evidence:{messageId:'old-message',quote:'Expired city'}};
  const newRelation={id:'new-relation',name:'Recent manager',role:'manager',evidence:{messageId:'new-message',quote:'Recent city'}};
  const active={...createLeadState('tenant','sapore','active'),facts:[oldFact,newFact],relations:[oldRelation,newRelation],referral:{name:'Expired referral',contact:'fictional',permissionToContact:false,evidence:{messageId:'old-message',quote:'Expired city'}}};
  for(const [id,brand,updated,state] of [['active','sapore',RECENT,active],['inactive','sapore',OLD,createLeadState('tenant','sapore','inactive')],['foreign','other',RECENT,createLeadState('tenant','other','foreign')]] as const) {
    await db.query('INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state,updated_at) VALUES($1,\'tenant\',$2,$1,$1,$1,$3,$4)',[id,brand,JSON.stringify(state),updated]);
    await db.query('INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id,updated_at) VALUES($1,\'tenant\',$2,$1,$3,$4)',[id,brand,brand==='sapore'?'1052683654599692':'2222222222222222',updated]);
  }
  for(const [id,candidate,brand,text,date] of [['old-message','active','sapore','Expired city',OLD],['new-message','active','sapore','Recent city',RECENT],['inactive-message','inactive','sapore','Inactive content',OLD],['old-message','foreign','other','Independent recent content',RECENT]]) {
    await db.query('INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp,created_at) VALUES($1,\'tenant\',$3,$2,$2,\'candidate\',\'text\',$4,$5,$5)',[id,candidate,brand,text,date]);
  }
  for(const fact of [oldFact,newFact]) await db.query("INSERT INTO sdr.facts(id,tenant_id,brand_id,candidate_id,data) VALUES($1,'tenant','sapore','active',$2)",[fact.id,JSON.stringify(fact)]);
  for(const relation of [oldRelation,newRelation]) await db.query("INSERT INTO sdr.relations(id,tenant_id,brand_id,candidate_id,data) VALUES($1,'tenant','sapore','active',$2)",[relation.id,JSON.stringify(relation)]);
  await db.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state,created_at,context,result) VALUES('job-mixed','tenant','sapore','active','active','new-message',0,0,'v1','ready',$1,$2,$3)",[RECENT,JSON.stringify({lead:active,messages:[{id:'old-message',createdAt:OLD}],sources:[]}),JSON.stringify({bubbles:['Expired city response']})]);
  await db.query("INSERT INTO sdr.briefings(id,tenant_id,brand_id,conversation_id,version_id,data,created_at) VALUES('brief','tenant','sapore','active','v1',$1,$2)",[JSON.stringify({summary:'Expired city summary',facts:[oldFact,newFact]}),RECENT]);
  await db.query("INSERT INTO sdr.evaluations(id,tenant_id,brand_id,conversation_id,job_id,user_id,clarity,relevance,naturalness,briefing_utility,notes,created_at) VALUES('evaluation','tenant','sapore','active','job-mixed','reviewer',4,4,4,4,'Expired city note',$1)",[RECENT]);
  await db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail,created_at) VALUES('old-event','tenant','sapore','active','message_note',$1,$2),('linked-event','tenant','sapore','active','message_note',$1,$3)",[JSON.stringify({messageId:'old-message',text:'Expired city'}),OLD,RECENT]);
  await db.query("INSERT INTO sdr.webhook_receipts VALUES('old-receipt','hash',$1)",[OLD]);
}

test('retention is dry-run by default and rejects policies longer than 30 days',async()=>{
  const {purgeRetention}=await import('../src/operations.js');
  const db=await testDatabase();
  try {
    await retentionFixture(db);
    const result=await purgeRetention(db,30,{now:NOW});
    assert.equal(result.ok,true);
    if(result.ok){assert.equal(result.value.dryRun,true);assert.equal(result.value.counts.candidatesDeleted,1);assert.equal(result.value.counts.messagesDeleted,2);}
    assert.equal((await db.query('SELECT * FROM sdr.candidates')).rows.length,3);
    assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,4);
    assert.deepEqual(await purgeRetention(db,31,{now:NOW}),{ok:false,error:{code:'INVALID_RETENTION_POLICY'}});
  } finally {await db.close();}
});
