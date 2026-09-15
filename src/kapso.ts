import type { Config } from './config.js';
import { ServiceError } from './security.js';
import { selectNativeControl, type NativeControlConfig } from '../integrations/kapso/control-contract.js';

export interface NativeState {
 id:string; conversationId:string; workflowId:string; status:string; controlFingerprint:string;
 controlEvent?:{id:string;occurredAt?:string;humanResume:boolean};
}
export class Kapso {
 constructor(private config:Pick<Config,'KAPSO_API_KEY'|'KAPSO_WORKFLOW_ID'> & NativeControlConfig, private transport:typeof fetch=fetch) {}
 async request(path:string,init:RequestInit & {timeoutMs?:number}={}) {
  const {timeoutMs=5000,headers,...rest}=init;
  const response=await this.transport('https://api.kapso.ai'+path,{
   ...rest,
   headers:{'X-API-Key':this.config.KAPSO_API_KEY,'Content-Type':'application/json',...(headers||{})},
   signal:AbortSignal.timeout(timeoutMs),
  });
  if(!response.ok) throw new ServiceError('KAPSO_UNAVAILABLE',503);
  return response.json();
 }
 async native(executionId:string):Promise<NativeState> {
  const body=await this.request('/platform/v1/workflow_executions/'+encodeURIComponent(executionId));
  const d=body.data;
  if(!d||d.id!==executionId||d.workflow?.id!==this.config.KAPSO_WORKFLOW_ID) throw new ServiceError('NATIVE_EXECUTION_MISMATCH',409);
  // Contract must be verified against real Handoff/Resume before enabling the channel.
  const control=selectNativeControl(d.id,d.events??[],this.config);
  return {id:d.id,conversationId:d.whatsapp_conversation_id,workflowId:d.workflow.id,status:d.status,controlFingerprint:control.controlFingerprint,
   ...(control.latestControl?.id?{controlEvent:{id:control.latestControl.id,occurredAt:control.latestControl.created_at,humanResume:control.humanResume}}:{})};
 }
 async assign(conversationId:string,userId:string,notes:string):Promise<void> {
  await this.request(`/platform/v1/whatsapp/conversations/${encodeURIComponent(conversationId)}/assignments`,{method:'POST',body:JSON.stringify({assignment:{user_id:userId,notes:notes.slice(0,4000)}})});
 }
 async resolveWaId(contactId:string):Promise<string> {
  const body=await this.request('/platform/v1/whatsapp/contacts/'+encodeURIComponent(contactId));
  const contact=body.data??body;
  const wa=String(contact.wa_id||contact.phone_number||'');
  if(!/^\d{10,20}$/.test(wa)) throw new ServiceError('KAPSO_CONTACT_PHONE_MISSING',502);
  return wa;
 }
 async sendText(input:{phoneNumberId:string;to:string;text:string}):Promise<string> {
  const body=await this.request(`/meta/whatsapp/v24.0/${encodeURIComponent(input.phoneNumberId)}/messages`,{
   method:'POST',timeoutMs:15000,
   body:JSON.stringify({messaging_product:'whatsapp',to:input.to,type:'text',text:{body:input.text}}),
  });
  const id=body.messages?.[0]?.id||body.data?.messages?.[0]?.id;
  if(typeof id!=='string'||!id.startsWith('wamid.')) throw new ServiceError('KAPSO_SEND_UNCONFIRMED',502);
  return id;
 }
 async proveOutbound(input:{conversationId:string;executionId:string;messageId:string;phoneNumberId:string}):Promise<boolean> {
  try {
   const native=await this.native(input.executionId);
   if(native.conversationId!==input.conversationId) return false;
   const body=await this.request(`/meta/whatsapp/v24.0/${encodeURIComponent(input.phoneNumberId)}/messages/${encodeURIComponent(input.messageId)}`);
   const message=body.data??body;
   const meta=message.kapso??{};
   if(meta.direction!=='outbound') return false;
   const conversation=meta.whatsapp_conversation_id||message.conversation_id;
   return !conversation||conversation===input.conversationId;
  } catch { return false; }
 }
}
