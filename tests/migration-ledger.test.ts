import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('migration ledger blocks Supabase API roles while preserving owner access and unrelated grants',async()=>{
 const pg=new PGlite();
 try {
  await pg.exec(`
   CREATE ROLE anon;
   CREATE ROLE authenticated;
   CREATE ROLE service_role BYPASSRLS;
   GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role;
   CREATE TABLE public.existing_application(id text PRIMARY KEY);
   INSERT INTO public.existing_application VALUES('preserved');
  `);
  const sql=await readFile(new URL('../scripts/provision-migration-ledger.sql',import.meta.url),'utf8');
  await pg.exec(sql);
  await pg.query("INSERT INTO public.sapore_sdr_migrations(version) VALUES('001_sdr')");
  await pg.exec(sql);
  assert.deepEqual((await pg.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
   WHERE oid='public.sapore_sdr_migrations'::regclass`)).rows,[{relrowsecurity:true,relforcerowsecurity:false}]);
  for(const role of ['anon','authenticated','service_role']) {
   await pg.exec(`SET ROLE ${role}`);
   assert.deepEqual((await pg.query('SELECT id FROM public.existing_application')).rows,[{id:'preserved'}]);
   for(const statement of [
    'SELECT * FROM public.sapore_sdr_migrations',
    "INSERT INTO public.sapore_sdr_migrations(version) VALUES('forged')",
    "UPDATE public.sapore_sdr_migrations SET version='forged'",
    'DELETE FROM public.sapore_sdr_migrations',
    'TRUNCATE public.sapore_sdr_migrations',
   ])await assert.rejects(pg.query(statement),/permission denied/);
   await pg.exec('RESET ROLE');
  }
  assert.deepEqual((await pg.query('SELECT version FROM public.sapore_sdr_migrations')).rows,[{version:'001_sdr'}]);
 }finally{await pg.close();}
});

test('ledger bootstrap supports an unprivileged owner without API roles and removes legacy column grants',async()=>{
 const pg=new PGlite();
 try {
  await pg.exec('CREATE ROLE migration_owner; GRANT USAGE,CREATE ON SCHEMA public TO migration_owner; SET ROLE migration_owner;');
  const sql=await readFile(new URL('../scripts/provision-migration-ledger.sql',import.meta.url),'utf8');
  await pg.exec(sql);
  await pg.query("INSERT INTO public.sapore_sdr_migrations(version) VALUES('001_sdr')");
  await pg.exec(sql);
  assert.deepEqual((await pg.query('SELECT version FROM public.sapore_sdr_migrations')).rows,[{version:'001_sdr'}]);
  await pg.exec(`RESET ROLE;
   CREATE ROLE anon;
   CREATE ROLE authenticated;
   CREATE ROLE service_role BYPASSRLS;
   GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
   SET ROLE migration_owner;
   GRANT SELECT(version),INSERT(version),UPDATE(version),REFERENCES(version)
    ON public.sapore_sdr_migrations TO PUBLIC,anon,authenticated,service_role;
  `);
  await pg.exec(sql);
  for(const role of ['anon','authenticated','service_role']) {
   for(const privilege of ['SELECT','INSERT','UPDATE','REFERENCES']) {
    assert.equal((await pg.query<{allowed:boolean}>(
     "SELECT has_any_column_privilege($1,'public.sapore_sdr_migrations',$2) AS allowed",[role,privilege])).rows[0].allowed,false);
   }
   await pg.exec(`RESET ROLE; SET ROLE ${role};`);
   await assert.rejects(pg.query('SELECT version FROM public.sapore_sdr_migrations'),/permission denied/);
  }
 }finally{await pg.close();}
});
