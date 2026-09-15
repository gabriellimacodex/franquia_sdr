import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './db-helper.js';
import { scoped } from '../src/database.js';

test('Postgres migration executes with pgvector, immutable snapshots and database-enforced brand isolation', async () => {
  const db = await testDatabase();
  try {
    await db.query("INSERT INTO sdr.brands VALUES ('tenant','sapore','Sapore'), ('tenant','other','Other')");
    await db.query("CREATE ROLE pilot_test NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await db.query('GRANT USAGE ON SCHEMA sdr TO pilot_test');
    await db.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA sdr TO pilot_test');
    await db.query('SET ROLE pilot_test');
    await scoped(db, {tenantId:'tenant',brandId:'sapore'}, async tx => {
      await tx.query("INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES ('v1','tenant','sapore','v1','{}','hash','model')");
    });
    await scoped(db, {tenantId:'tenant',brandId:'other'}, async tx => {
      assert.equal((await tx.query('SELECT * FROM sdr.versions')).rows.length,0);
    });
    await assert.rejects(scoped(db,{tenantId:'tenant',brandId:'sapore'},tx=>tx.query("UPDATE sdr.versions SET snapshot='{}'")),/immutable/);
    await assert.rejects(scoped(db,{tenantId:'tenant',brandId:'other'},tx=>tx.query("INSERT INTO sdr.testers VALUES ('tenant','sapore','contact','Test',true)")),/row-level security/);
  } finally { await db.close(); }
});
