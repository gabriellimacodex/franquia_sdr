import type { Config } from './config.js';
import type { Kapso, NativeState } from './kapso.js';
import type { TurnView } from './contracts.js';
import type { Channel, JobRow, Store } from './store.js';

export type DeliveryDeps={store:Store;kapso:Kapso;native:(id:string)=>Promise<NativeState>;config:Pick<Config,'CHANNEL_ENABLED'|'NATIVE_CONTROL_VERIFIED'>};

/** Sends an authorized reply, one WhatsApp message per bubble. Authorization is single-use, so the n8n callback and the
 * Kapso session function may both call this for the same job: whichever comes second sees `sent` and sends nothing. */
export async function deliverTurn(deps:DeliveryDeps,channel:Channel,job:JobRow,executionId:string,controlFingerprint:string):Promise<TurnView> {
 const {store,kapso,native,config}=deps;
 if(config.CHANNEL_ENABLED!=='true'||config.NATIVE_CONTROL_VERIFIED!=='true'||!channel.responsibleUserId) return {...store.view(job),authorized:false,state:'handoff',reply:[],errorCode:'RELEASE_GATE_CLOSED'};
 if(job.state==='sent') return {...store.view(job),authorized:true,reply:[]};
 const state=await native(executionId);
 if(state.status!=='running'||state.conversationId!==job.conversation_id||state.controlFingerprint!==controlFingerprint) {
  await store.control(channel,job.conversation_id,'handoff','deliver-guard:'+state.controlFingerprint,executionId,state.controlFingerprint);
  return {...store.view(job),authorized:false,state:'handoff',reply:[]};
 }
 const authorization=await store.authorize(job.id,executionId,controlFingerprint);
 if(!authorization.authorized) return authorization;
 const reply=authorization.reply;
 if(!Array.isArray(reply)||reply.length<1||reply.length>2||reply.some(part=>typeof part!=='string'||!part.trim())||reply.join('\n\n').length>4000) {
  await store.failApiSend(job.id,'INVALID_AUTHORIZED_REPLY');
  return {...store.view(job),authorized:false,state:'handoff',reply:[],errorCode:'INVALID_AUTHORIZED_REPLY'};
 }
 try {
  const hint=await store.recipientHint(job.id);
  const to=/^\d{10,20}$/.test(hint.authorizedContactId)?hint.authorizedContactId:await kapso.resolveWaId(hint.contactId);
  // One WhatsApp message per bubble. Each WAMID is recorded as an agent message right away so the
  // provider history never reads the later bubbles as an unknown outbound sender (human takeover).
  const wamids:string[]=[];
  for(const bubble of reply) {
   try { wamids.push(await kapso.sendText({phoneNumberId:hint.phoneNumberId,to,text:bubble})); }
   catch(error) { if(!wamids.length) throw error; break; } // A later bubble failing must not resend the first.
   await store.recordAgentMessage(job.id,wamids.at(-1)!,bubble);
  }
  const sent=await store.confirmApiSend(job.id,wamids[0]!);
  // After a successful WhatsApp delivery, apply deferred handoff/stop from the model decision.
  const decision=job.result;
  if(decision&&(decision.nextAction==='handoff'||decision.nextAction==='stop')) {
   await store.control(channel,job.conversation_id,decision.nextAction==='stop'?'stop':'handoff',job.id+':after-deliver',executionId,controlFingerprint);
  }
  return sent;
 } catch {
  return store.failApiSend(job.id,'DELIVERY_FAILED');
 }
}
