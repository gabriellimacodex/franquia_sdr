import { z } from 'zod';
import { scoped, type Database } from './database.js';
import { SnapshotSchema } from './engine.js';
import { SYSTEM_PROMPT, CONVERSATION_MODEL, BRIEFING_MODEL } from './prompts.js';
import { snapshotHash } from './versioning.js';

export const PilotSchema=z.object({
 tenantId:z.string().default('cognita-homologacao'),brandId:z.literal('sapore').default('sapore'),
 phoneNumberId:z.literal('1093705843816293').default('1093705843816293'),
 testers:z.array(z.object({contactId:z.string().regex(/^\d{10,16}$/),label:z.string().min(1)})).min(1),
 responsibleUserId:z.string().nullable().default(null),adminUserIds:z.array(z.string()).default([]),
}).strict();
export type Pilot=z.infer<typeof PilotSchema>;
export function initialSnapshot(scope:{tenantId:string,brandId:string}) {
 const clause='O investimento de referência para a Sapore Açaí é de R$ 250 mil a R$ 280 mil.';
 return SnapshotSchema.parse({
  tenant:{...scope,brandName:'Sapore Açaí',mode:'homologation',commercialPolicyApproved:true,investmentMin:250000,investmentMax:280000,includesWorkingCapital:null,hotTimingMonths:3,approvedTerritories:[]},
  sources:[{...scope,id:'sapore-investimento-homologacao-v1',title:'Referência comercial Sapore — homologação',content:clause+' A composição desse valor, incluindo giro, taxa e implantação, ainda precisa de validação. Não há fonte aprovada de royalties, margem, faturamento, retorno ou disponibilidade territorial.',status:'approved',active:true,validFrom:'2026-09-08T00:00:00.000Z',validUntil:null,tags:['investimento','giro','franquia'],claims:[{kind:'investment',text:clause}]}],
  prompt:SYSTEM_PROMPT,model:CONVERSATION_MODEL,briefingModel:BRIEFING_MODEL,
 });
}
export async function seedPilot(db:Database,raw:unknown) {
 const pilot=PilotSchema.parse(raw),scope={tenantId:pilot.tenantId,brandId:pilot.brandId};
 const snapshot=initialSnapshot(scope),hash=snapshotHash(snapshot),versionId='sapore-v1-'+hash.slice(0,12);
 await db.transaction(async tx=>{
  await tx.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[pilot.tenantId,pilot.brandId,'Sapore Açaí']);
  await tx.query('INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,responsible_user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[pilot.phoneNumberId,pilot.tenantId,pilot.brandId,pilot.responsibleUserId]);
  await tx.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id,kind) VALUES('lab-'||md5($1||':'||$2),$1,$2,'laboratory') ON CONFLICT DO NOTHING",[pilot.tenantId,pilot.brandId]);
  for(const userId of pilot.adminUserIds)await tx.query("INSERT INTO sdr.memberships(user_id,tenant_id,brand_id,role) VALUES($1,$2,$3,'admin') ON CONFLICT DO NOTHING",[userId,pilot.tenantId,pilot.brandId]);
 });
 await scoped(db,scope,async tx=>{
  const s=[pilot.tenantId,pilot.brandId];
  for(const tester of pilot.testers)await tx.query('INSERT INTO sdr.testers(tenant_id,brand_id,contact_id,label) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...s,tester.contactId,tester.label]);
  await tx.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES($3,$1,$2,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[...s,versionId,'Sapore SDR v1 — homologação não avaliada',JSON.stringify(snapshot),hash,CONVERSATION_MODEL]);
  await tx.query('INSERT INTO sdr.active_versions(tenant_id,brand_id,version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[...s,versionId]);
  for(const source of snapshot.sources)await tx.query('INSERT INTO sdr.knowledge_chunks(tenant_id,brand_id,version_id,id,title,content,approved,active,valid_from,valid_until,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING',[...s,versionId,source.id,source.title,source.content,true,true,source.validFrom,source.validUntil,JSON.stringify({sourceId:source.id})]);
 });
 return {versionId,testers:pilot.testers.length,channelEnabled:false};
}
