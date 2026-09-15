import { readFile } from 'node:fs/promises';
import { connectDatabase } from '../src/database.js';
import { seedPilot } from '../src/seed.js';

if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const db=connectDatabase(process.env.DATABASE_URL,process.env.DATABASE_SSL!=='false');
try {console.log(JSON.stringify(await seedPilot(db,JSON.parse(await readFile(process.env.PILOT_CONFIG_PATH??'.local/pilot.json','utf8')))));}
finally{await db.close();}
