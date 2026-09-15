import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testDatabase } from './db-helper.js';

test('runtime provisioning supports a CREATEROLE administrator without superuser privileges and can be repeated',async()=>{
 const db=await testDatabase();
 try {
  await db.query('CREATE ROLE migration_admin CREATEROLE NOSUPERUSER NOBYPASSRLS');
  await db.query('GRANT ALL ON SCHEMA sdr TO migration_admin WITH GRANT OPTION');
  await db.query('GRANT ALL ON ALL TABLES IN SCHEMA sdr TO migration_admin WITH GRANT OPTION');
  await db.query('SET ROLE migration_admin');
  assert.deepEqual((await db.query('SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows,
   [{rolsuper:false,rolcreaterole:true}]);
  const sql=await readFile(new URL('../scripts/provision-runtime-role.sql',import.meta.url),'utf8');
  for(let attempt=0;attempt<2;attempt++) {
   for(const statement of sql.split('-- statement-breakpoint'))await db.query(statement);
  }
  assert.deepEqual((await db.query(`SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit,rolconfig
   FROM pg_roles WHERE rolname='sdr_runtime'`)).rows,[{
    rolcanlogin:true,rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false,
    rolreplication:false,rolinherit:false,rolconfig:['row_security=on'],
   }]);
  assert.deepEqual((await db.query(`SELECT
   has_table_privilege('sdr_runtime','sdr.messages','INSERT') AS message_insert,
   has_table_privilege('sdr_runtime','sdr.channels','UPDATE') AS channel_update,
   has_schema_privilege('sdr_runtime','sdr','CREATE') AS schema_create`)).rows,
   [{message_insert:true,channel_update:false,schema_create:false}]);
 }finally{await db.close();}
});

test('runtime provisioning rejects existing elevated roles without changing their attributes or grants',async()=>{
 const db=await testDatabase();
 try {
  const sql=await readFile(new URL('../scripts/provision-runtime-role.sql',import.meta.url),'utf8');
  for(const flag of ['SUPERUSER','BYPASSRLS','CREATEDB','CREATEROLE','REPLICATION']) {
   await db.query(`CREATE ROLE sdr_runtime NOLOGIN ${flag}`);
   const roleSql="SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit,rolconfig FROM pg_roles WHERE rolname='sdr_runtime'";
   const before=(await db.query(roleSql)).rows;
   await assert.rejects(async()=>{
    for(const statement of sql.split('-- statement-breakpoint'))await db.query(statement);
   },/sdr_runtime must not have elevated role attributes/);
   assert.deepEqual((await db.query(roleSql)).rows,before);
   assert.deepEqual((await db.query(`SELECT grantee FROM information_schema.role_table_grants
    WHERE table_schema='sdr' AND grantee='sdr_runtime'`)).rows,[]);
   await db.query('DROP ROLE sdr_runtime');
  }
 }finally{await db.close();}
});
