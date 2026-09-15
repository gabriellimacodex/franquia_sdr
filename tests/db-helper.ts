import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readFile } from 'node:fs/promises';
import type { Database, Queryable } from '../src/database.js';

export async function testDatabase(path?: string): Promise<Database> {
  const pg = new PGlite({ dataDir: path, extensions: { vector } });
  const exists = await pg.query("SELECT to_regnamespace('sdr') AS name");
  if (!(exists.rows[0] as {name: unknown}).name) await pg.exec(await readFile(new URL('../migrations/001_sdr.sql', import.meta.url), 'utf8'));
  if (!(await pg.query<{name:string|null}>("SELECT to_regclass('sdr.lab_sessions') AS name")).rows[0]?.name) await pg.exec(await readFile(new URL('../migrations/003_lab_sessions.sql', import.meta.url), 'utf8'));
  return {
    query: async (sql, params) => pg.query(sql, params),
    transaction: async fn => pg.transaction(async tx => fn(tx as Queryable)),
    close: () => pg.close(),
  };
}
