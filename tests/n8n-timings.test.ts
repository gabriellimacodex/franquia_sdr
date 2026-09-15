import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const jobId='lab-0123456789abcdef0123456789abcdef:11111111-1111-4111-8111-111111111111';
const prepareSource=(await readFile(new URL('../integrations/n8n/nodes/prepare-job.js',import.meta.url),'utf8'))
 .replace('__SAPORE_BACKEND_ORIGIN__',JSON.stringify('https://sdr.example.test'));
const parseSource=await readFile(new URL('../integrations/n8n/nodes/parse-result.js',import.meta.url),'utf8');
const job={jobId,contextVersion:1,configVersion:'version-1',model:'gpt-5.4-2026-03-05',
 instructions:'Use only evidence.',context:{messages:[],privateNote:'fictional-person@example.test'},
 outputSchema:{type:'object',additionalProperties:false},
 callbackUrl:`https://sdr.example.test/internal/n8n/jobs/${encodeURIComponent(jobId)}/complete`};
const response={status:'completed',model:job.model,created_at:1,
 usage:{input_tokens:100,output_tokens:10},
 output:[{type:'message',content:[{type:'output_text',text:'{"bubbles":["Olá"]}'}]}]};
function prepare(now:number,body:unknown=job) {
 const items=vm.runInNewContext(`(function(){${prepareSource}\n})()`,{
  Date:{now:()=>now},$input:{all:()=>[{json:{body}}]},
 });
 return JSON.parse(JSON.stringify(items[0].json));
}
function parse(now:number,prepared:unknown,value:unknown=response) {
 const items=vm.runInNewContext(`(function(){${parseSource}\n})()`,{
  Date:{now:()=>now},$input:{all:()=>[{json:value}]},$:()=>({first:()=>({json:prepared})}),
 });
 return JSON.parse(JSON.stringify(items[0].json));
}

test('conversation callback reports only local model HTTP round-trip duration without changing the request',()=>{
 const start=1_789_089_600_000;
 const prepared=prepare(start,{...job,modelRequestStartedAtMs:1,timings:{modelRoundTripMs:999,privateNote:'do not copy'}});
 const output=parse(start+3_456,prepared,{...response,timings:{modelRoundTripMs:987,privateNote:'do not copy'}});
 assert.deepEqual(output.completion.timings,{modelRoundTripMs:3_456});
 assert.deepEqual(prepared.request,{
  model:job.model,instructions:job.instructions,store:false,max_output_tokens:1200,service_tier:'default',
  input:[{role:'user',content:JSON.stringify(job.context)}],
  text:{format:{type:'json_schema',name:'sapore_turn',strict:true,schema:job.outputSchema}},
 });
 assert.deepEqual(output,{
  callbackUrl:job.callbackUrl,completion:{jobId,contextVersion:1,configVersion:'version-1',
   model:job.model,usage:response.usage,result:{bubbles:['Olá']},timings:{modelRoundTripMs:3_456}},
 });
 assert.equal(JSON.stringify(output.completion).includes(String(start)),false);
 assert.equal(JSON.stringify(output.completion).includes('privateNote'),false);
});

test('timing metadata is optional and drops missing, malformed or out-of-bounds local clock samples',()=>{
 const start=1_789_089_600_000,prepared=prepare(start);
 for(const elapsed of [0,180_000])assert.deepEqual(parse(start+elapsed,prepared).completion.timings,{modelRoundTripMs:elapsed});
 const samples=[
  {stamp:undefined,now:start+100},{stamp:null,now:start+100},{stamp:String(start),now:start+100},
  {stamp:NaN,now:start+100},{stamp:Infinity,now:start+100},{stamp:-1,now:100},
  {stamp:start+0.5,now:start+100},{stamp:start,now:start-1},{stamp:start,now:start+180_001},
  {stamp:start,now:NaN},{stamp:start,now:Infinity},{stamp:start,now:start+0.5},
 ];
 for(const sample of samples) {
  const completion=parse(sample.now,{...prepared,modelRequestStartedAtMs:sample.stamp}).completion;
  assert.equal(Object.hasOwn(completion,'timings'),false);
  assert.deepEqual(completion.result,{bubbles:['Olá']});
  assert.deepEqual(completion.usage,response.usage);
 }
});

test('briefing callbacks stay unchanged and timing does not bypass model response validation',()=>{
 const start=1_789_089_600_000;
 const briefing={...job,task:'briefing',model:'gpt-5-mini',callbackUrl:`https://sdr.example.test/internal/n8n/briefings/${encodeURIComponent(jobId)}/complete`};
 const prepared=prepare(start,briefing);
 const output=parse(start+900,prepared,{...response,model:'gpt-5-mini-2026-03-05'});
 assert.equal(Object.hasOwn(output.completion,'timings'),false);
 assert.deepEqual(prepared.request.input,[{role:'user',content:JSON.stringify(job.context)}]);
 assert.equal(output.callbackUrl,briefing.callbackUrl);
 assert.equal(output.completion.model,'gpt-5-mini-2026-03-05');
 const conversation=prepare(start);
 assert.throws(()=>parse(start+100,conversation,{...response,status:'incomplete'}),/MODEL_RESPONSE_NOT_COMPLETED/);
 assert.throws(()=>parse(start+100,conversation,{...response,output:[{type:'message',content:[{type:'refusal'}]}]}),/MODEL_REFUSAL/);
});
