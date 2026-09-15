import { setTimeout } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { connectDatabase, scoped } from './database.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { DispatchFailure } from './dispatch-failure.js';
import { Kapso } from './kapso.js';
import { Briefings } from './briefings.js';
import { assertRuntimeRole,purgeRetention } from './operations.js';

const config=loadConfig(),db=connectDatabase(config.DATABASE_URL,config.DATABASE_SSL==='true'),store=new Store(db),engine=new Engine(store,config),kapso=new Kapso(config);
const briefings=new Briefings(store,config);
const gate=await assertRuntimeRole(db);if(!gate.ok){await db.close();throw new Error(gate.error.code);}
let lastRetention=0;
let running=true;for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{running=false;});
while(running) {
 try {
  if(config.RETENTION_ENABLED==='true'&&Date.now()-lastRetention>3600000){const result=await purgeRetention(db,config.RETENTION_DAYS,{dryRun:false});console.log(JSON.stringify(result));lastRetention=Date.now();}
  for(const channel of await store.channels()) {
   if((channel.kind??'whatsapp')!==config.EXECUTION_MODE)continue;
   await briefings.dispatch(channel);
   const job=await store.claim(channel);
   if(job) {
    try { await engine.dispatch(channel,job); }
    catch {
     const recorded=await new DispatchFailure(db,channel).execute({jobId:job.id,attempt:job.attempts});
     if(!recorded.success)throw new Error(recorded.error.code);
    }
   }
   // Assignment is independent of generation. Never retry blindly after an ambiguous provider write.
   if(channel.kind==='laboratory')continue;
   const brief=await scoped(db,channel,async tx=>(await tx.query<{id:string,conversation_id:string,data:{summary:string}}>("UPDATE sdr.briefings SET assignment_status='processing' WHERE id=(SELECT id FROM sdr.briefings WHERE tenant_id=$1 AND brand_id=$2 AND split_part(id,':',1)=$3 AND assignment_status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,conversation_id,data",[channel.tenantId,channel.brandId,channel.phoneNumberId])).rows[0]);
   if(brief) {
    let status='not_configured';
    if(channel.responsibleUserId&&config.CHANNEL_ENABLED==='true') {
     try {await kapso.assign(brief.conversation_id,channel.responsibleUserId,`Homologação Sapore — ${brief.data.summary}\nBriefing: ${config.LAB_ORIGIN}/laboratorio-sdr`);status='assigned';}
     catch {status='unknown';}
    }
    await scoped(db,channel,tx=>tx.query('UPDATE sdr.briefings SET assignment_status=$4 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[channel.tenantId,channel.brandId,brief.id,status]));
   }
  }
 } catch { console.error(JSON.stringify({level:'error',code:'WORKER_CYCLE_FAILED'})); }
 await setTimeout(1000);
}
await db.close();
