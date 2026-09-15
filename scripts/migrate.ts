import { connectDatabase } from '../src/database.js';
import { runMigrations } from './migration-runner.js';

if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required (migration role, not frontend key)');
const db=connectDatabase(process.env.DATABASE_URL,process.env.DATABASE_SSL!=='false');
try {
 await runMigrations(db);
 console.log('SDR migrations applied. No existing application tables were changed.');
} finally {await db.close();}
