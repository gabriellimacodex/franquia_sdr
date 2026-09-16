import { readFile } from 'node:fs/promises';
import type { Database } from '../src/database.js';

export async function runMigrations(db: Database): Promise<void> {
 await db.transaction(async tx => {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('sapore_sdr_migrations'))");
  await tx.query(await readFile(new URL('./provision-migration-ledger.sql', import.meta.url), 'utf8'));
 });
 for (const version of ['001_sdr', '002_versions', '003_lab_sessions', '004_candidate_reset']) {
  await db.transaction(async tx => {
   await tx.query("SELECT pg_advisory_xact_lock(hashtext('sapore_sdr_migrations'))");
   if (!(await tx.query('SELECT version FROM public.sapore_sdr_migrations WHERE version=$1', [version])).rows.length) {
    await tx.query(await readFile(new URL('../migrations/' + version + '.sql', import.meta.url), 'utf8'));
    await tx.query('INSERT INTO public.sapore_sdr_migrations(version) VALUES($1)', [version]);
   }
   await tx.query(await readFile(new URL('./provision-private-schema.sql', import.meta.url), 'utf8'));
   if (version === '003_lab_sessions') {
    await tx.query(await readFile(new URL('./provision-lab-grants.sql', import.meta.url), 'utf8'));
   }
  });
 }
}
