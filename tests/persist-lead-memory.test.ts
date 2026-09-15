import test from 'node:test';
import assert from 'node:assert/strict';
import { scoped, type Database, type Queryable, type Scope } from '../src/database.js';
import { createLeadState, type LeadFact, type LeadState } from '../src/domain.js';
import { persistLeadMemory } from '../src/persist-lead-memory.js';
import { testDatabase } from './db-helper.js';

const scope:Scope={tenantId:'memory-tenant',brandId:'sapore'};
const candidateId='candidate';
const fact=(id:string,status:LeadFact['status']='declared'):LeadFact=>({
 id,field:'city',value:{kind:'text',text:'Campinas'},evidence:{messageId:'message-'+id,quote:'moro em Campinas'},
 attribution:'candidate',capitalOrigin:null,relationId:null,replacesFactId:null,status,
 confirmedBy:status==='confirmed'?'reviewer':null,createdAt:'2026-09-11T00:00:00.000Z',origin:'candidate_message',
});
async function seed(db:Database,target:Scope=scope) {
 await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2)',[target.tenantId,target.brandId]);
 await db.query('INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state) VALUES($3,$1,$2,$3,$3,$3,$4)',[target.tenantId,target.brandId,candidateId,JSON.stringify(createLeadState(target.tenantId,target.brandId,candidateId))]);
}
function recording(tx:Queryable,queries:string[]):Queryable {
 return {query:async<T>(sql:string,params?:unknown[])=>{queries.push(sql);return tx.query<T>(sql,params);}};
}

test('all facts are batched into one query while preserving scope, status and evidence',async()=>{
 const db=await testDatabase();
 try {
  await seed(db);const other={tenantId:'other-tenant',brandId:'sapore'};await seed(db,other);
  const memory={facts:[fact('one'),fact('two','confirmed')],relations:[]};
  const unrelated={...fact('one'),value:{kind:'text',text:'Recife'}};
  await db.query('INSERT INTO sdr.facts(id,tenant_id,brand_id,candidate_id,data) VALUES($3,$1,$2,$4,$5)',[other.tenantId,other.brandId,'one',candidateId,JSON.stringify(unrelated)]);
  const queries:string[]=[];
  await scoped(db,scope,tx=>persistLeadMemory(recording(tx,queries),scope,candidateId,memory));
  assert.equal(queries.length,1);
  const rows=(await db.query<{candidate_id:string,data:LeadFact}>('SELECT candidate_id,data FROM sdr.facts WHERE tenant_id=$1 AND brand_id=$2 ORDER BY id',[scope.tenantId,scope.brandId])).rows;
  assert.deepEqual(rows.map(row=>row.data),memory.facts);
  assert.ok(rows.every(row=>row.candidate_id===candidateId));
  assert.deepEqual((await db.query<{data:unknown}>('SELECT data FROM sdr.facts WHERE tenant_id=$1',[other.tenantId])).rows[0].data,unrelated);
 }finally{await db.close();}
});

test('relations share one batch query, keep candidate-prefixed identity and never overwrite existing evidence',async()=>{
 const db=await testDatabase();
 try {
  await seed(db);const other={...scope,brandId:'other-brand'};await seed(db,other);
  const relations:LeadState['relations']=[
   {id:'one',name:'Ana',role:'partner',evidence:{messageId:'m1',quote:'Ana é minha sócia'}},
   {id:'two',name:'Bruno',role:'manager',evidence:{messageId:'m2',quote:'Bruno será o gestor'}},
  ];
  await db.query('INSERT INTO sdr.relations(id,tenant_id,brand_id,candidate_id,data) VALUES($3,$1,$2,$4,$5)',[other.tenantId,other.brandId,candidateId+':one',candidateId,JSON.stringify({...relations[0],name:'Outra pessoa'})]);
  const queries:string[]=[];
  await scoped(db,scope,tx=>persistLeadMemory(recording(tx,queries),scope,candidateId,{facts:[fact('one')],relations}));
  assert.equal(queries.length,2);
  assert.equal(queries.filter(sql=>sql.includes('INSERT INTO sdr.facts')).length,1);
  assert.equal(queries.filter(sql=>sql.includes('INSERT INTO sdr.relations')).length,1);
  const read=()=>db.query<{id:string,data:LeadState['relations'][number]}>('SELECT id,data FROM sdr.relations WHERE tenant_id=$1 AND brand_id=$2 ORDER BY id',[scope.tenantId,scope.brandId]);
  assert.deepEqual((await read()).rows,relations.map(data=>({id:candidateId+':'+data.id,data})));
  await scoped(db,scope,tx=>persistLeadMemory(tx,scope,candidateId,{facts:[],relations:[{...relations[0],name:'Não substituir'}]}));
  assert.deepEqual((await read()).rows.map(row=>row.data),relations);
  assert.equal((await db.query<{data:{name:string}}>('SELECT data FROM sdr.relations WHERE tenant_id=$1 AND brand_id=$2',[other.tenantId,other.brandId])).rows[0].data.name,'Outra pessoa');
 }finally{await db.close();}
});

test('unchanged facts keep updated_at while missing projections are restored and real changes persist',async()=>{
 const db=await testDatabase();
 try {
  await seed(db);
  const memory:Pick<LeadState,'facts'|'relations'>={facts:[fact('one'),fact('two','confirmed')],relations:[{id:'partner',name:'Ana',role:'partner',evidence:{messageId:'m1',quote:'Ana é minha sócia'}}]};
  await scoped(db,scope,tx=>persistLeadMemory(tx,scope,candidateId,memory));
  const originalTime='2000-01-01T00:00:00.000Z';
  await db.query('UPDATE sdr.facts SET updated_at=$1',[originalTime]);
  const read=()=>db.query<{id:string,data:LeadFact,updated_at:Date}>('SELECT id,data,updated_at FROM sdr.facts ORDER BY id');
  const reordered={...memory,facts:memory.facts.map(value=>({...value,evidence:{quote:value.evidence.quote,messageId:value.evidence.messageId}}))};
  await scoped(db,scope,tx=>persistLeadMemory(tx,scope,candidateId,reordered));
  assert.ok((await read()).rows.every(row=>row.updated_at.toISOString()===originalTime));
  await db.query("DELETE FROM sdr.facts WHERE id='two'");
  await db.query('DELETE FROM sdr.relations');
  await scoped(db,scope,tx=>persistLeadMemory(tx,scope,candidateId,memory));
  const restored=(await read()).rows;
  assert.deepEqual(restored.map(row=>row.data),memory.facts);
  assert.equal(restored[0].updated_at.toISOString(),originalTime);
  assert.equal((await db.query('SELECT id FROM sdr.relations')).rows.length,1);
  const changed={...memory,facts:[{...memory.facts[0],status:'rejected' as const,confirmedBy:'reviewer'},memory.facts[1]]};
  await scoped(db,scope,tx=>persistLeadMemory(tx,scope,candidateId,changed));
  const updated=(await read()).rows;
  assert.deepEqual(updated[0].data,changed.facts[0]);
  assert.notEqual(updated[0].updated_at.toISOString(),originalTime);
  assert.equal(updated[1].updated_at.toISOString(),restored[1].updated_at.toISOString());
 }finally{await db.close();}
});

test('duplicate projection IDs preserve the old loops: last fact wins and first relation wins',async()=>{
 const db=await testDatabase();
 try {
  await seed(db);
  const first:LeadState['relations'][number]={id:'partner',name:'Ana',role:'partner',evidence:{messageId:'m1',quote:'Ana é minha sócia'}};
  const last=fact('one','confirmed'),queries:string[]=[];
  await scoped(db,scope,tx=>persistLeadMemory(recording(tx,queries),scope,candidateId,{facts:[fact('one'),last],relations:[first,{...first,name:'Não substituir'}]}));
  assert.equal(queries.length,2);
  assert.deepEqual((await db.query<{data:LeadFact}>('SELECT data FROM sdr.facts')).rows.map(row=>row.data),[last]);
  assert.deepEqual((await db.query<{data:unknown}>('SELECT data FROM sdr.relations')).rows.map(row=>row.data),[first]);
 }finally{await db.close();}
});

test('empty memory needs no query and a failed batch rolls back with the caller transaction',async()=>{
 const db=await testDatabase();
 try {
  await seed(db);const queries:string[]=[];
  await scoped(db,scope,tx=>persistLeadMemory(recording(tx,queries),scope,candidateId,{facts:[],relations:[]}));
  assert.equal(queries.length,0);
  await assert.rejects(scoped(db,scope,async tx=>{
   await tx.query('UPDATE sdr.candidates SET revision=revision+1 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[scope.tenantId,scope.brandId,candidateId]);
   const failing:Queryable={query:async<T>(sql:string,params?:unknown[])=>{
    if(sql.includes('INSERT INTO sdr.relations'))throw new Error('synthetic relation storage failure');
    return tx.query<T>(sql,params);
   }};
   await persistLeadMemory(failing,scope,candidateId,{facts:[fact('one')],relations:[{id:'partner',name:'Ana',role:'partner',evidence:{messageId:'m1',quote:'Ana é minha sócia'}}]});
  }),/synthetic relation storage failure/);
  assert.deepEqual((await db.query('SELECT id FROM sdr.facts')).rows,[]);
  assert.deepEqual((await db.query('SELECT id FROM sdr.relations')).rows,[]);
  assert.equal((await db.query<{revision:number}>('SELECT revision FROM sdr.candidates')).rows[0].revision,0);
 }finally{await db.close();}
});
