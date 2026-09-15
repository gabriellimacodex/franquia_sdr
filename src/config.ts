import { z } from 'zod';

const secret=z.string().min(32);
export const ConfigSchema=z.object({
 EXECUTION_MODE:z.enum(['laboratory','whatsapp']).default('laboratory'),
 DATABASE_URL:z.string().min(1), DATABASE_SSL:z.enum(['true','false']).default('true'),
 PORT:z.coerce.number().int().default(3100),PUBLIC_API_URL:z.string().url(),LAB_ORIGIN:z.string().url(),
 SUPABASE_URL:z.string().url(),SUPABASE_ANON_KEY:z.string().min(1),
 KAPSO_API_KEY:z.string().default(''),KAPSO_WEBHOOK_SECRET:z.string().default(''),KAPSO_FUNCTION_TOKEN:z.string().default(''),KAPSO_WORKFLOW_ID:z.string().default(''),
 N8N_WEBHOOK_URL:z.string().url(),N8N_WEBHOOK_TOKEN:secret,N8N_CALLBACK_TOKEN:secret,
 OPENAI_API_KEY:z.string().optional(),CHANNEL_ENABLED:z.enum(['true','false']).default('false'),
 LAB_BUDGET_GATE_ID:z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/).optional(),
 LAB_BUDGET_LIMIT_MICRO_USD:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
 NATIVE_CONTROL_VERIFIED:z.enum(['true','false']).default('false'),
 KAPSO_HUMAN_RESUME_EVENT_TYPE:z.string().optional(),KAPSO_HUMAN_RESUME_REASON:z.string().optional(),
 RETENTION_DAYS:z.coerce.number().int().min(1).max(30).default(30),
 RETENTION_ENABLED:z.enum(['true','false']).default('false'),
}).superRefine((config,ctx)=>{
 if((config.LAB_BUDGET_GATE_ID===undefined)!==(config.LAB_BUDGET_LIMIT_MICRO_USD===undefined))ctx.addIssue({code:'custom',path:['LAB_BUDGET_GATE_ID'],message:'Laboratory budget gate and cap must be configured together'});
 if(config.EXECUTION_MODE==='whatsapp') {
  for(const key of ['KAPSO_API_KEY','KAPSO_WEBHOOK_SECRET','KAPSO_FUNCTION_TOKEN','KAPSO_WORKFLOW_ID'] as const)if(config[key].length<(key==='KAPSO_WORKFLOW_ID'?1:32))ctx.addIssue({code:'custom',path:[key],message:'Required for WhatsApp mode'});
 } else {
  if(config.CHANNEL_ENABLED==='true'||config.NATIVE_CONTROL_VERIFIED==='true')ctx.addIssue({code:'custom',path:['CHANNEL_ENABLED'],message:'WhatsApp flags must remain disabled in laboratory mode'});
  if(config.RETENTION_ENABLED==='true')ctx.addIssue({code:'custom',path:['RETENTION_ENABLED'],message:'Retention must remain disabled in laboratory mode'});
 }
});
export type Config=z.infer<typeof ConfigSchema>;
export function loadConfig():Config {
 const result=ConfigSchema.safeParse(process.env);
 if(!result.success) throw new Error('Missing/invalid environment keys: '+result.error.issues.map(i=>i.path.join('.')).join(', '));
 const c=result.data;
 const tokens=[c.N8N_CALLBACK_TOKEN,c.N8N_WEBHOOK_TOKEN,...(c.EXECUTION_MODE==='whatsapp'?[c.KAPSO_FUNCTION_TOKEN]:[])];
 if(new Set(tokens).size!==tokens.length) throw new Error('Internal tokens must be different');
 for(const key of ['PUBLIC_API_URL','N8N_WEBHOOK_URL','SUPABASE_URL'] as const) {
  const u=new URL(c[key]);
  if(u.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(u.hostname)) throw new Error(key+' requires HTTPS');
 }
 return c;
}
