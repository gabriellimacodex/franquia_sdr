import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('private schema provisioning removes API grants and scoped defaults without touching other applications or runtime grants',async()=>{
 const pg=new PGlite();
 try {
  await pg.exec(`
   CREATE SCHEMA sdr;
   CREATE ROLE anon;
   CREATE ROLE authenticated;
   CREATE ROLE service_role BYPASSRLS;
   CREATE ROLE sdr_runtime;
   GRANT ALL ON SCHEMA sdr TO PUBLIC,anon,authenticated,service_role;
   ALTER DEFAULT PRIVILEGES IN SCHEMA sdr GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role;
   ALTER DEFAULT PRIVILEGES IN SCHEMA sdr GRANT ALL ON SEQUENCES TO PUBLIC,anon,authenticated,service_role;
   ALTER DEFAULT PRIVILEGES IN SCHEMA sdr GRANT ALL ON FUNCTIONS TO PUBLIC,anon,authenticated,service_role;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon,authenticated,service_role;
   CREATE TABLE sdr.private_data(id text PRIMARY KEY);
   INSERT INTO sdr.private_data VALUES('preserved');
   CREATE SEQUENCE sdr.private_sequence;
   CREATE FUNCTION sdr.private_function() RETURNS text LANGUAGE sql AS $$ SELECT 'private'::text $$;
   CREATE TABLE public.existing_application(id text PRIMARY KEY);
   INSERT INTO public.existing_application VALUES('unrelated');
   GRANT USAGE ON SCHEMA sdr TO sdr_runtime;
   GRANT SELECT ON sdr.private_data TO sdr_runtime;
  `);
  const otherDefaultsSql="SELECT oid,defaclacl::text FROM pg_default_acl WHERE defaclnamespace<>'sdr'::regnamespace ORDER BY oid";
  const otherDefaults=(await pg.query(otherDefaultsSql)).rows;
  const sql=await readFile(new URL('../scripts/provision-private-schema.sql',import.meta.url),'utf8');
  await pg.exec(sql);
  await pg.exec(sql);
  for(const role of ['anon','authenticated','service_role']) {
   assert.deepEqual((await pg.query(`SELECT
    has_schema_privilege($1,'sdr','USAGE') AS schema_usage,
    has_schema_privilege($1,'sdr','CREATE') AS schema_create,
    has_table_privilege($1,'sdr.private_data','SELECT') AS table_select,
    has_sequence_privilege($1,'sdr.private_sequence','USAGE') AS sequence_usage,
    has_function_privilege($1,'sdr.private_function()','EXECUTE') AS function_execute`,[role])).rows,
    [{schema_usage:false,schema_create:false,table_select:false,sequence_usage:false,function_execute:false}]);
   await pg.exec(`SET ROLE ${role}`);
   await assert.rejects(pg.query('SELECT * FROM sdr.private_data'),/permission denied/);
   await assert.rejects(pg.query("SELECT nextval('sdr.private_sequence')"),/permission denied/);
   await assert.rejects(pg.query('SELECT sdr.private_function()'),/permission denied/);
   assert.deepEqual((await pg.query('SELECT id FROM public.existing_application')).rows,[{id:'unrelated'}]);
   await pg.exec('RESET ROLE');
  }
  assert.deepEqual((await pg.query(otherDefaultsSql)).rows,otherDefaults);
  assert.equal((await pg.query<{count:number}>(`SELECT count(*)::int AS count FROM pg_default_acl d,
   LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace='sdr'::regnamespace
   AND (a.grantee=0 OR a.grantee IN(SELECT oid FROM pg_roles WHERE rolname IN('anon','authenticated','service_role')))`)).rows[0].count,0);
  await pg.exec('SET ROLE sdr_runtime');
  assert.deepEqual((await pg.query('SELECT id FROM sdr.private_data')).rows,[{id:'preserved'}]);
 }finally{await pg.close();}
});
