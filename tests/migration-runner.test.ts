import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { runMigrations } from '../scripts/migration-runner.js';

const sql = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');
function database(pg: PGlite): Database {
 const query = (connection: Pick<PGlite, 'query' | 'exec'>): Queryable['query'] => async <T>(statement: string, params?: unknown[]) => {
  if (params) return connection.query<T>(statement, params);
  return { rows: ((await connection.exec(statement)).at(-1)?.rows ?? []) as T[] };
 };
 return {
  query: query(pg),
  transaction: fn => pg.transaction(tx => fn({query: query(tx)})),
  close: () => pg.close(),
 };
}
async function existingInstallation(pg: PGlite) {
 await pg.exec(await sql('scripts/provision-migration-ledger.sql'));
 for (const version of ['001_sdr', '002_versions']) {
  await pg.exec(await sql('migrations/' + version + '.sql'));
  await pg.query('INSERT INTO public.sapore_sdr_migrations(version) VALUES($1)', [version]);
 }
 await pg.exec(`INSERT INTO sdr.brands VALUES('migration-test','sapore','Existing brand');
  INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id) VALUES('existing-whatsapp','migration-test','sapore');
  INSERT INTO sdr.memberships VALUES('existing-reviewer','migration-test','sapore','reviewer',true);`);
}

test('migration upgrade grants laboratory runtime access, preserves publisher access and remains private on rerun', async () => {
 const pg = new PGlite({extensions: {vector}});
 try {
  await existingInstallation(pg);
  await pg.exec(await sql('scripts/provision-runtime-role.sql'));
  await pg.exec(await sql('scripts/provision-publisher-grants.sql'));
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
   ALTER DEFAULT PRIVILEGES IN SCHEMA sdr GRANT ALL ON TABLES TO PUBLIC,anon,authenticated,service_role;`);
  const existingGrants = "SELECT table_name,privilege_type,is_grantable FROM information_schema.role_table_grants WHERE table_schema='sdr' AND grantee='sdr_runtime' AND table_name<>'lab_sessions' ORDER BY table_name,privilege_type";
  const before = (await pg.query(existingGrants)).rows;
  const db = database(pg);
  for (let attempt = 0; attempt < 2; attempt++) {
   await runMigrations(db);
   assert.deepEqual((await pg.query(`SELECT
    has_table_privilege('sdr_runtime','sdr.lab_sessions','SELECT') AS lab_select,
    has_table_privilege('sdr_runtime','sdr.lab_sessions','INSERT') AS lab_insert,
    has_table_privilege('sdr_runtime','sdr.lab_sessions','UPDATE') AS lab_update,
    has_table_privilege('sdr_runtime','sdr.lab_sessions','DELETE') AS lab_delete,
    has_table_privilege('sdr_runtime','sdr.memberships','INSERT') AS membership_insert`)).rows,
    [{lab_select: true, lab_insert: true, lab_update: true, lab_delete: true, membership_insert: false}]);
   assert.deepEqual((await pg.query(existingGrants)).rows, before);
   for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.deepEqual((await pg.query(`SELECT
     has_schema_privilege($1,'sdr','USAGE') AS schema_usage,
     has_table_privilege($1,'sdr.lab_sessions','SELECT,INSERT,UPDATE,DELETE') AS lab_access`, [role])).rows,
     [{schema_usage: false, lab_access: false}]);
   }
  }
  assert.deepEqual((await pg.query('SELECT version FROM public.sapore_sdr_migrations ORDER BY version')).rows,
   ['001_sdr', '002_versions', '003_lab_sessions'].map(version => ({version})));
  assert.deepEqual((await pg.query("SELECT role,active FROM sdr.memberships WHERE user_id='existing-reviewer'")).rows,
   [{role: 'reviewer', active: true}]);
  assert.deepEqual((await pg.query('SELECT kind,enabled FROM sdr.channels ORDER BY kind')).rows,
   [{kind: 'laboratory', enabled: false}, {kind: 'whatsapp', enabled: false}]);
 } finally { await pg.close(); }
});

test('initial migrations succeed without creating or granting a runtime role', async () => {
 const pg = new PGlite({extensions: {vector}});
 try {
  await runMigrations(database(pg));
  assert.deepEqual((await pg.query("SELECT rolname FROM pg_roles WHERE rolname='sdr_runtime'")).rows, []);
  assert.deepEqual((await pg.query('SELECT version FROM public.sapore_sdr_migrations ORDER BY version')).rows,
   ['001_sdr', '002_versions', '003_lab_sessions'].map(version => ({version})));
 } finally { await pg.close(); }
});

test('laboratory RLS caches tenant and brand settings once per statement', async () => {
 const pg = new PGlite({extensions: {vector}});
 try {
  await runMigrations(database(pg));
  const policy = (await pg.query<{ qual: string; with_check: string }>(`SELECT qual,with_check
   FROM pg_policies WHERE schemaname='sdr' AND tablename='lab_sessions' AND policyname='lab_sessions_scope'`)).rows[0];
  assert.ok(policy);
  for (const expression of [policy.qual, policy.with_check]) {
   assert.match(expression, /SELECT current_setting\('sdr\.tenant_id'/);
   assert.match(expression, /SELECT current_setting\('sdr\.brand_id'/);
  }
 } finally { await pg.close(); }
});

test('migration upgrade rejects elevated runtime roles without adding grants or committing migration 003', async () => {
 const pg = new PGlite({extensions: {vector}});
 try {
  await existingInstallation(pg);
  for (const attribute of ['SUPERUSER', 'BYPASSRLS', 'CREATEDB', 'CREATEROLE', 'REPLICATION']) {
   await pg.exec(`CREATE ROLE sdr_runtime ${attribute}`);
   const attributes = "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit,rolconfig FROM pg_roles WHERE rolname='sdr_runtime'";
   const before = (await pg.query(attributes)).rows;
   await assert.rejects(runMigrations(database(pg)), /sdr_runtime must not have elevated role attributes/);
   assert.deepEqual((await pg.query(attributes)).rows, before);
   assert.deepEqual((await pg.query("SELECT to_regclass('sdr.lab_sessions') AS name")).rows, [{name: null}]);
   assert.deepEqual((await pg.query('SELECT version FROM public.sapore_sdr_migrations ORDER BY version')).rows,
    ['001_sdr', '002_versions'].map(version => ({version})));
   assert.deepEqual((await pg.query("SELECT grantee FROM information_schema.role_table_grants WHERE table_schema='sdr' AND grantee='sdr_runtime'")).rows, []);
   await pg.exec('DROP ROLE sdr_runtime');
  }
 } finally { await pg.close(); }
});

test('migration upgrade rejects a runtime that can assume another role', async () => {
 const pg = new PGlite({extensions: {vector}});
 try {
  await existingInstallation(pg);
  await pg.exec('CREATE ROLE privileged_role CREATEROLE; CREATE ROLE sdr_runtime NOINHERIT; GRANT privileged_role TO sdr_runtime');
  await assert.rejects(runMigrations(database(pg)), /sdr_runtime must not inherit or switch to any other role/);
  assert.deepEqual((await pg.query("SELECT to_regclass('sdr.lab_sessions') AS name")).rows, [{name: null}]);
 } finally { await pg.close(); }
});

test('migration upgrade rejects a runtime that owns product tables', async () => {
 const pg = new PGlite({extensions: {vector}});
 try {
  await existingInstallation(pg);
  await pg.exec('CREATE ROLE sdr_runtime; CREATE TABLE sdr.runtime_owned(id text); ALTER TABLE sdr.runtime_owned OWNER TO sdr_runtime');
  await assert.rejects(runMigrations(database(pg)), /sdr_runtime must not own product tables/);
  assert.deepEqual((await pg.query("SELECT to_regclass('sdr.lab_sessions') AS name")).rows, [{name: null}]);
 } finally { await pg.close(); }
});
