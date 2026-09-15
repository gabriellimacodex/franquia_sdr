import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AGENT_OUTPUT_JSON_SCHEMA, AgentDecisionSchema } from '../src/domain.js';
import { FINANCIAL_OUTPUT_JSON_SCHEMA, FinancialDecisionSchema } from '../src/financial-reply.js';

const jobId='lab-0123456789abcdef0123456789abcdef:11111111-1111-4111-8111-111111111111';
const prepareSource=(await readFile(new URL('../integrations/n8n/nodes/prepare-job.js',import.meta.url),'utf8'))
 .replace('__SAPORE_BACKEND_ORIGIN__',JSON.stringify('https://sdr.example.test'));
const parseSource=await readFile(new URL('../integrations/n8n/nodes/parse-result.js',import.meta.url),'utf8');
const message={id:'capital-message',role:'user',text:'Tenho R$ 260 mil de recursos próprios disponíveis.',type:'text',createdAt:'2026-09-11T03:00:00.000Z'};
const context={messages:[message],lead:{facts:[]},sources:[]};
const instructions='Use the supplied output contract and preserve evidence IDs.';
const usage={input_tokens:1800,output_tokens:200,total_tokens:2000};
const base={bubbles:[],proposals:[],relations:[],referral:null,sourceRefs:['approved-investment'],nextAction:'continue',handoffReason:null};

function roundTrip(outputSchema:unknown,result:unknown,configVersion:string) {
 const job={jobId,contextVersion:4,configVersion,model:'gpt-5.4-2026-03-05',instructions,context,outputSchema,
  callbackUrl:`https://sdr.example.test/internal/n8n/jobs/${encodeURIComponent(jobId)}/complete`};
 const prepared=JSON.parse(JSON.stringify(vm.runInNewContext(`(function(){${prepareSource}\n})()`,{
  Date:{now:()=>1000},$input:{all:()=>[{json:{body:job}}]},
 })[0].json));
 const response={status:'completed',model:job.model,usage,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]};
 const parsed=JSON.parse(JSON.stringify(vm.runInNewContext(`(function(){${parseSource}\n})()`,{
  Date:{now:()=>1456},$input:{all:()=>[{json:response}]},$:()=>({first:()=>({json:prepared})}),
 })[0].json));
 assert.deepEqual(prepared.request,{
  model:job.model,instructions,store:false,max_output_tokens:1200,service_tier:'default',
  input:[{role:'user',content:JSON.stringify({lead:context.lead,sources:context.sources})},{role:'user',content:JSON.stringify(message)}],
  text:{format:{type:'json_schema',name:'sapore_turn',strict:true,schema:outputSchema}},
 });
 assert.deepEqual(parsed,{
  callbackUrl:job.callbackUrl,completion:{jobId,contextVersion:4,configVersion,model:job.model,usage,result,
   timings:{modelRoundTripMs:456}},
 });
 return parsed.completion.result;
}

test('n8n forwards financial v2 schema and decision unchanged for structured and null financial replies',()=>{
 for(const financialReply of [{capitalEvidence:{messageId:message.id,quote:message.text},investmentSourceId:'approved-investment',followUp:'experience'},null]) {
  const result=FinancialDecisionSchema.parse({...base,financialReply});
  const forwarded=FinancialDecisionSchema.parse(roundTrip(FINANCIAL_OUTPUT_JSON_SCHEMA,result,'financial-contract-v2'));
  assert.deepEqual(forwarded,result);
  assert.equal(Object.hasOwn(forwarded,'financialReply'),true);
  assert.deepEqual(forwarded.financialReply,financialReply);
 }
});

test('n8n preserves the legacy v1 schema and result without adding the financial v2 field',()=>{
 const result=AgentDecisionSchema.parse({...base,bubbles:['Você já teve experiência com varejo?'],sourceRefs:[]});
 const forwarded=AgentDecisionSchema.parse(roundTrip(AGENT_OUTPUT_JSON_SCHEMA,result,'legacy-contract-v1'));
 assert.deepEqual(forwarded,result);
 assert.equal(Object.hasOwn(forwarded,'financialReply'),false);
 assert.equal(AGENT_OUTPUT_JSON_SCHEMA.required.includes('financialReply'),false);
 assert.equal(Object.hasOwn(AGENT_OUTPUT_JSON_SCHEMA.properties,'financialReply'),false);
});
