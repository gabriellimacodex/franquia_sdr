import { loadConfig } from './config.js';
import { connectDatabase } from './database.js';
import { createServer } from './server.js';
import { assertRuntimeRole } from './operations.js';

const config=loadConfig();
const db=connectDatabase(config.DATABASE_URL,config.DATABASE_SSL==='true');
const gate=await assertRuntimeRole(db);if(!gate.ok){await db.close();throw new Error(gate.error.code);}
const app=await createServer(db,config,{logging:true});
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{void app.close().then(()=>db.close());});
await app.listen({host:'0.0.0.0',port:config.PORT});
