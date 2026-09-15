import { readFile } from 'node:fs/promises';
import { connectDatabase } from '../src/database.js';
import { Versioning } from '../src/versioning.js';

const [tenantId,brandId,contentHash,actorId,reportFile]=process.argv.slice(2);
if(!tenantId||!brandId||!contentHash||!actorId||!reportFile||!process.env.DATABASE_URL)throw new Error('Usage: record-validation TENANT BRAND HASH AUTH_USER_ID REPORT_FILE; DATABASE_URL=trusted recorder role');
const db=connectDatabase(process.env.DATABASE_URL,process.env.DATABASE_SSL!=='false');
try{
 const result=await new Versioning(db).recordValidation({tenantId,brandId},contentHash,JSON.parse(await readFile(reportFile,'utf8')),actorId);
 console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}finally{await db.close();}
