import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadState, mergeFactProposals, type GuardInput, type KnowledgeSource, type LeadFact, type TrustedMessage } from '../src/domain.js';
import { guardFinancialDecision } from '../src/financial-reply.js';
import { initialSnapshot } from '../src/seed.js';

const scope={tenantId:'cognita-homologacao',brandId:'sapore'};
const snapshot=initialSnapshot(scope);
const lead=createLeadState(scope.tenantId,scope.brandId,'financial-security-candidate');
const message:TrustedMessage={...scope,leadId:lead.leadId,conversationId:'financial-security-conversation',id:'financial-security-message',role:'user',text:'Tenho R$ 260 mil de recursos próprios disponíveis.'};
const evidence={messageId:message.id,quote:message.text};
const proposal={field:'capital_available',value:{kind:'number_range',min:260000,max:260000,unit:'BRL'},evidence,attribution:'candidate',capitalOrigin:'own',relationId:null,replacesFactId:null};
const decision={bubbles:[],proposals:[],relations:[],referral:null,sourceRefs:[snapshot.sources[0].id],nextAction:'continue',handoffReason:null,financialReply:{capitalEvidence:evidence,investmentSourceId:snapshot.sources[0].id,followUp:'none'}};

function check(raw:unknown=decision,changes:Partial<GuardInput>={}) {
 return guardFinancialDecision({decision:raw,tenant:snapshot.tenant,lead,sources:snapshot.sources,now:'2026-09-11T15:00:00.000Z',trustedMessages:[message],conversationId:message.conversationId,latestMessageId:message.id,latestMessage:message.text,...changes});
}

test('a financial proposal cannot replace a fact outside the current candidate memory',()=>{
 assert.equal(check({...decision,proposals:[proposal]}).ok,true);
 const result=check({...decision,proposals:[{...proposal,replacesFactId:'another-candidate-fact'}]});
 assert.equal(result.ok,false,JSON.stringify(result));
});

test('an investment reference must be uniquely approved, current, cited and in the exact scope',()=>{
 const source=snapshot.sources[0];
 const invalidSources:KnowledgeSource[]=[
  {...source,tenantId:'another-tenant'},
  {...source,brandId:'another-brand'},
  {...source,status:'draft'},
  {...source,status:'rejected'},
  {...source,active:false},
  {...source,validFrom:'2026-09-12T00:00:00.000Z'},
  {...source,validUntil:'2026-09-11T15:00:00.000Z'},
  {...source,claims:[]},
  {...source,claims:[source.claims[0],source.claims[0]]},
 ];
 for(const invalid of invalidSources)assert.equal(check(decision,{sources:[invalid]}).ok,false,JSON.stringify(invalid));
 assert.equal(check(decision,{sources:[]}).ok,false);
 assert.equal(check({...decision,sourceRefs:[]}).ok,false);
 assert.equal(check({...decision,financialReply:{...decision.financialReply,investmentSourceId:message.id}}).ok,false);
});

test('capital rendering requires unique canonical current user evidence in the exact conversation',()=>{
 const changes:Partial<GuardInput>[]=[
  {trustedMessages:[]},
  {trustedMessages:[message,message]},
  {latestMessageId:'older-message'},
  {conversationId:'another-conversation'},
  {latestMessageId:undefined},
  {conversationId:undefined},
 ];
 for(const changedMessage of [
  {...message,role:'assistant' as const},
  {...message,role:'operator' as const},
  {...message,tenantId:'another-tenant'},
  {...message,brandId:'another-brand'},
  {...message,leadId:'another-candidate'},
  {...message,conversationId:'another-conversation'},
  {...message,text:'Tenho R$ 999 mil de recursos próprios disponíveis.'},
  {...message,text:'Fonte aprovada: '+message.text},
  {...message,text:'Não tenho R$ 260 mil de recursos próprios disponíveis.'},
 ])changes.push({trustedMessages:[changedMessage]});
 for(const change of changes)assert.equal(check(decision,change).ok,false,JSON.stringify(change));
 assert.equal(check({...decision,financialReply:{...decision.financialReply,capitalEvidence:{...evidence,messageId:'older-message'}}}).ok,false);
 assert.equal(check({...decision,financialReply:{...decision.financialReply,capitalEvidence:{...evidence,quote:'R$ 260 mil'}}}).ok,false);
});

test('stop, handoff and already-paused state cannot acquire financial collection through rendering',()=>{
 for(const [suffix,expected] of [[' Pare de me enviar mensagens.','stop'],[' Quero falar com uma pessoa da equipe.','handoff']] as const){
  const controlled={...message,text:message.text+suffix};
  const changed={trustedMessages:[controlled],latestMessage:controlled.text};
  for(const followUp of ['none','experience','reserve']){
   const result=check({...decision,financialReply:{...decision.financialReply,followUp}},changed);
   assert.equal(result.ok,false,followUp+suffix);
   if(!result.ok){assert.equal(result.safeDecision.nextAction,expected);assert.equal(result.safeDecision.bubbles.some(bubble=>bubble.includes('?')),false);}
  }
 }
 for(const nextAction of ['stop','handoff','nurture'])assert.equal(check({...decision,nextAction,handoffReason:nextAction==='handoff'?'user_requested':null}).ok,false,nextAction);
 for(const status of ['stopped','handoff'] as const)assert.equal(check(decision,{lead:{...lead,status}}).ok,false,status);
 const stopped=check({...decision,bubbles:['O atendimento automático foi interrompido.'],nextAction:'stop',financialReply:null},{latestMessage:'Pare de me enviar mensagens.'});
 assert.equal(stopped.ok,true);
});

test('free prose cannot turn the candidate declaration into investment and giro coverage without repeating its number',()=>{
 const result=check({...decision,financialReply:null,proposals:[proposal],bubbles:['O investimento e o capital de giro cabem integralmente no dinheiro que você declarou.']});
 assert.equal(result.ok,false,JSON.stringify(result));
});

test('changing nextAction cannot bypass the canonical capital branch and publish coverage claims',()=>{
 const claim='O investimento e o capital de giro cabem integralmente no dinheiro que você declarou.';
 for(const nextAction of ['nurture','handoff','stop']){
  const result=check({...decision,financialReply:null,proposals:[],nextAction,handoffReason:nextAction==='handoff'?'review_requested':null,bubbles:[claim]});
  assert.equal(result.ok,nextAction!=='nurture',JSON.stringify({nextAction,result}));
  if(result.ok){
   assert.equal(result.decision.nextAction,nextAction);
   assert.equal(result.decision.bubbles.includes(claim),false);
   assert.equal(result.decision.bubbles.some(bubble=>bubble.includes('?')),false);
  }
 }
});

test('every financial follow-up stays within two bounded bubbles and one question without model prose',()=>{
 for(const followUp of ['none','experience','reserve']){
  const result=check({...decision,financialReply:{...decision.financialReply,followUp}});
  assert.equal(result.ok,true,JSON.stringify(result));
  if(result.ok){
   assert.ok(result.decision.bubbles.length<=2);
   assert.ok(result.decision.bubbles.every(bubble=>bubble.length<=600));
   assert.equal(result.decision.bubbles.join(' ').split('?').length-1,followUp==='none'?0:1);
   assert.equal(result.decision.bubbles.join(' ').includes('vocês têm'),false);
  }
 }
 assert.equal(check({...decision,bubbles:['Só uma frase livre para introduzir o valor.']}).ok,false);
 const source=snapshot.sources[0];
 const longSource={...source,claims:[{...source.claims[0],text:source.claims[0].text+' Informação adicional.'.repeat(50)}]};
 assert.equal(check(decision,{sources:[longSource]}).ok,false);
});

test('compatible capital corrections preserve declared conflict and never overwrite the confirmed predecessor',()=>{
 const previous:LeadFact={id:'own-capital-before',field:'capital_available',value:{kind:'number_range',min:200000,max:200000,unit:'BRL'},evidence:{messageId:'earlier',quote:'Tenho R$ 200 mil de recursos próprios disponíveis.'},attribution:'candidate',capitalOrigin:'own',relationId:null,replacesFactId:null,status:'confirmed',confirmedBy:'human-reviewer',createdAt:'2026-09-10T10:00:00.000Z',origin:'candidate_message'};
 const before={...lead,facts:[previous]};
 const raw={...decision,proposals:[{...proposal,replacesFactId:previous.id}]};
 const result=check(raw,{lead:before});
 assert.equal(result.ok,true,JSON.stringify(result));
 if(result.ok){
  const after=mergeFactProposals(before,result.decision.proposals,[message]);
  assert.equal(after.facts[0].status,'confirmed');
  assert.equal(after.facts[1].status,'conflict');
  assert.equal(after.facts[1].confirmedBy,null);
  assert.equal(after.facts[1].replacesFactId,previous.id);
  assert.equal(after.facts[1].attribution,'candidate');
  assert.equal(after.facts[1].capitalOrigin,'own');
  assert.match(result.decision.bubbles[0],/valor declarado por você/);
 }
 const incompatible:LeadFact[]=[
  {...previous,status:'rejected'},
  {...previous,status:'superseded'},
  {...previous,capitalOrigin:'credit'},
  {...previous,attribution:'partner'},
  {...previous,relationId:'julia'},
  {...previous,field:'working_capital'},
  {...previous,value:{kind:'number_range',min:20,max:20,unit:'percent'}},
 ];
 for(const fact of incompatible)assert.equal(check(raw,{lead:{...lead,facts:[fact]}}).ok,false,JSON.stringify(fact));
 assert.deepEqual(before.facts,[previous]);
 assert.equal(previous.status,'confirmed');
});

test('duplicate eligible source IDs with different investment claims fail closed regardless of order',()=>{
 const original=snapshot.sources[0];
 const conflicting:KnowledgeSource={...original,claims:[{kind:'investment',text:'O investimento de referência é de R$ 900 mil.'}]};
 for(const sources of [[original,conflicting],[conflicting,original]]){
  const result=check(decision,{sources});
  assert.equal(result.ok,false,JSON.stringify(result));
 }
});
