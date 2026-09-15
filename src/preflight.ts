import { ConfigSchema } from './config.js';

function isPrivateSupabaseKey(key:string) {
 if(key.startsWith('sb_secret_'))return true;
 const payload=key.split('.')[1];
 if(!payload)return false;
 try{return JSON.parse(Buffer.from(payload,'base64url').toString('utf8')).role!=='anon';}
 catch{return false;}
}

export type Sprint2PreflightReport={
 ok:true;
 executionMode:'laboratory';
 databaseTls:true;
 retentionEnabled:false;
 outboundEnabled:false;
 port:3100;
 publicApiOrigin:string;
 labOrigin:string;
 n8nOrigin:string;
};

export function sprint2Preflight(raw:unknown):Sprint2PreflightReport {
 const parsed=ConfigSchema.safeParse(raw);
 if(!parsed.success)throw new Error('SPRINT2_PREFLIGHT_INVALID_CONFIG');
 const config=parsed.data;
 const publicApi=new URL(config.PUBLIC_API_URL),lab=new URL(config.LAB_ORIGIN),n8n=new URL(config.N8N_WEBHOOK_URL),supabase=new URL(config.SUPABASE_URL);
 const closed=config.EXECUTION_MODE!=='laboratory'||config.DATABASE_SSL!=='true'||config.PORT!==3100||
  [publicApi,lab,n8n,supabase].some(url=>url.protocol!=='https:')||config.N8N_WEBHOOK_TOKEN===config.N8N_CALLBACK_TOKEN||isPrivateSupabaseKey(config.SUPABASE_ANON_KEY);
 if(closed)throw new Error('SPRINT2_PREFLIGHT_GATE_CLOSED');
 return {
  ok:true,executionMode:'laboratory',databaseTls:true,retentionEnabled:false,outboundEnabled:false,port:3100,
  publicApiOrigin:publicApi.origin,labOrigin:lab.origin,n8nOrigin:n8n.origin,
 };
}
