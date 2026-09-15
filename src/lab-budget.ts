import type { Config } from './config.js';
import { createHash } from 'node:crypto';
import { scoped, type Queryable } from './database.js';
import { Store, type Channel, type JobRow } from './store.js';
import { UsageSchema } from './usage.js';

async function pause(tx:Queryable,channel:Channel,job:JobRow,code:string) {
 const text=code==='LAB_BUDGET_EXHAUSTED'
  ?'A cota de testes desta etapa foi atingida. A equipe precisa liberar uma nova cota para continuar.'
  :'O processamento deste teste está pausado. A equipe precisa verificar a cota de testes para continuar.';
 const result={bubbles:[text],proposals:[],relations:[],referral:null,sourceRefs:[],nextAction:'handoff',handoffReason:text};
 const s=[channel.tenantId,channel.brandId];
 await tx.query("UPDATE sdr.jobs SET state='handoff',error_code=$4,result=$5,completed_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,job.id,code,JSON.stringify(result)]);
 await tx.query("UPDATE sdr.conversations SET state='human',epoch=epoch+1,updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,job.conversation_id]);
 await tx.query("UPDATE sdr.candidates SET lead_state=jsonb_set(lead_state,'{status}','\"handoff\"'),updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",[...s,job.candidate_id]);
 await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'agent','text',$6,now()) ON CONFLICT DO NOTHING",[...s,job.id+':budget',job.conversation_id,job.candidate_id,text]);
}

export async function reserveLabBudget(store:Store,config:Config,channel:Channel,job:JobRow,payload:unknown):Promise<boolean> {
 return scoped(store.db,channel,async tx=>{
  const current=(await tx.query<JobRow>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE',[channel.tenantId,channel.brandId,job.id])).rows[0];
  if(!current||current.state!=='working'||current.attempts!==job.attempts||current.deadline<=new Date())return false;
  if(!config.LAB_BUDGET_GATE_ID||!config.LAB_BUDGET_LIMIT_MICRO_USD){await pause(tx,channel,current,'LAB_BUDGET_NOT_CONFIGURED');return false;}
  if(channel.tenantId!=='cognita-homologacao'||channel.brandId!=='sapore'){await pause(tx,channel,current,'LAB_BUDGET_SCOPE_MISMATCH');return false;}
  const gateId=config.LAB_BUDGET_GATE_ID;
  const id='lab-budget:'+createHash('sha256').update(`${gateId}:${job.id}:${job.attempts}`).digest('hex');
  if((await tx.query("SELECT id FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND type='lab_model_budget_reserved' AND detail->>'jobId'=$3",[channel.tenantId,channel.brandId,job.id])).rows.length)return false;
  const inputTokenBound=Buffer.byteLength(JSON.stringify(payload),'utf8')+4096;
  if(inputTokenBound>272000){await pause(tx,channel,current,'LAB_BUDGET_INPUT_TOO_LARGE');return false;}
  const reservedMicroUsd=Math.ceil(inputTokenBound*2.5+1200*15);
  const spent=(await tx.query<{total:string}>("SELECT COALESCE(sum((detail->>'costMicroUsd')::bigint),0)::text AS total FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND type='lab_model_budget_reserved' AND detail->>'gateId'=$3",[channel.tenantId,channel.brandId,gateId])).rows[0];
  if(Number(spent.total)+reservedMicroUsd>config.LAB_BUDGET_LIMIT_MICRO_USD){await pause(tx,channel,current,'LAB_BUDGET_EXHAUSTED');return false;}
  await tx.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($3,$1,$2,$4,'lab_model_budget_reserved',$5)",[channel.tenantId,channel.brandId,id,job.conversation_id,JSON.stringify({gateId,jobId:job.id,attempt:job.attempts,inputTokenBound,reservedMicroUsd,costMicroUsd:reservedMicroUsd,settled:false})]);
  return true;
 });
}

/** Only called within the accepted terminal completion transaction. Ambiguous attempts keep their full reservation. */
export async function settleLabBudget(tx:Queryable,channel:Channel,jobId:string,model:string|undefined,usage:unknown) {
 if(model!=='gpt-5.4-2026-03-05')return;
 const parsed=UsageSchema.safeParse(usage);if(!parsed.success)return;
 const {input_tokens:input,output_tokens:output,total_tokens:total}=parsed.data;
 if(input===undefined||output===undefined||input<=0||output<=0||output>1200||total!==undefined&&total!==input+output)return;
 const reservations=(await tx.query<{id:string,detail:{inputTokenBound:number,reservedMicroUsd:number,settled:boolean}}>("SELECT id,detail FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2 AND type='lab_model_budget_reserved' AND detail->>'jobId'=$3",[channel.tenantId,channel.brandId,jobId])).rows;
 if(reservations.length!==1)return;
 const reservation=reservations[0];
 const costMicroUsd=Math.ceil(input*2.5+output*15);
 if(reservation.detail.settled||input>reservation.detail.inputTokenBound||costMicroUsd>reservation.detail.reservedMicroUsd)return;
 await tx.query('UPDATE sdr.events SET detail=detail||$4::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND id=$3',[channel.tenantId,channel.brandId,reservation.id,JSON.stringify({costMicroUsd,settled:true,inputTokens:input,outputTokens:output})]);
}
