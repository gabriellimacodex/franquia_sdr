import assert from 'node:assert/strict';
import test from 'node:test';
import { scoped, type Database, type Queryable, type Scope } from '../src/database.js';
import { testDatabase } from './db-helper.js';

test('scope setup uses one round trip while preserving the transaction lock and local settings',async()=>{
 const db=await testDatabase();
 const baseline={tenantId:'session-tenant',brandId:'session-brand'};
 const counted:Database={
  query:(sql,params)=>db.query(sql,params),
  close:()=>db.close(),
  transaction:fn=>db.transaction(tx=>{
   const calls:{sql:string,params?:unknown[]}[]=[];
   const wrapped:Queryable={query:<T>(sql:string,params?:unknown[])=>{calls.push({sql,params});return tx.query<T>(sql,params);}};
   return fn(Object.assign(wrapped,{calls}));
  }),
 };
 const assertScoped=async(tx:Queryable,scope:Scope)=>{
  const calls=(tx as Queryable&{calls:unknown[]}).calls;
  assert.equal(calls.length,1,'lock and local settings must be ready after one setup query');
  const state=await tx.query<Scope&{locked:boolean}>(`SELECT
   current_setting('sdr.tenant_id') AS "tenantId",current_setting('sdr.brand_id') AS "brandId",
   EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND granted
    AND objsubid=1
    AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
    AND objid=(hashtextextended($1,0)&4294967295)::oid) AS locked`,[scope.tenantId+':'+scope.brandId]);
  assert.deepEqual(state.rows,[{...scope,locked:true}]);
 };
 const assertRestored=async()=>{
  const settings=await db.query<Scope>("SELECT current_setting('sdr.tenant_id') AS \"tenantId\",current_setting('sdr.brand_id') AS \"brandId\"");
  assert.deepEqual(settings.rows,[baseline]);
  // PGlite has a single isolated backend and reports its lock PID as NULL.
  const locks=await db.query<{count:number}>("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory'");
  assert.equal(locks.rows[0].count,0,'transaction advisory locks must be released');
 };
 try {
  await db.query("SELECT set_config('sdr.tenant_id',$1,false),set_config('sdr.brand_id',$2,false)",[baseline.tenantId,baseline.brandId]);
  await db.query('CREATE TEMP TABLE scope_latency_writes(value text)');
  const first={tenantId:'tenant-alpha',brandId:'brand-alpha'};
  assert.equal(await scoped(counted,first,async tx=>{
   await assertScoped(tx,first);
   await tx.query('INSERT INTO scope_latency_writes(value) VALUES($1)',['committed']);
   return 'callback-result';
  }),'callback-result');
  await assertRestored();

  const second={tenantId:'tenant-beta',brandId:'brand-beta'};
  const aborted=new Error('rollback this scope');
  await assert.rejects(scoped(counted,second,async tx=>{
   await assertScoped(tx,second);
   await tx.query('INSERT INTO scope_latency_writes(value) VALUES($1)',['rolled-back']);
   throw aborted;
  }),error=>error===aborted);
  await assertRestored();

  const third={tenantId:'tenant-gamma',brandId:'brand-gamma'};
  await scoped(counted,third,async tx=>{
   await assertScoped(tx,third);
   assert.deepEqual((await tx.query('SELECT value FROM scope_latency_writes')).rows,[{value:'committed'}]);
  });
  await assertRestored();
 }finally{await db.close();}
});
