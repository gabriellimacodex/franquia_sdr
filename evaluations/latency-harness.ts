import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Database, Queryable } from '../src/database.js';
import { Engine } from '../src/engine.js';
import { Store } from '../src/store.js';
import { Briefings } from '../src/briefings.js';
import { createServer } from '../src/server.js';
import { seedPilot } from '../src/seed.js';
import { testDatabase } from '../tests/db-helper.js';
import { testConfig } from '../tests/config.js';

export interface LatencyOptions {
 rttMs:number; providerMs:number; authMs?:number; ackMs?:number;
 workerIntervalMs?:number; pollIntervalMs?:number; pollFloorMs?:number;
}
export interface TimingSpan {name:string;startMs:number;endMs:number}
export interface LatencySample {
 kind:'offline-simulation'; endpoint:'authenticated-committed-detail-not-render';
 options:Required<LatencyOptions>; observedDetailMs:number; callbackCommittedMs:number;
 providerCalls:number;authCalls:number;polls:number;
 database:{queries:number;transactions:number;wireExchanges:number;byActor:Record<string,number>};
 spans:TimingSpan[];invariants:{guardPassed:boolean;settled:boolean;facts:number;relations:number;deliveries:number};
}
/** Real elapsed monotonic time with artificial delays, not a sum of query costs.
 * PGlite serializes transactions on one connection: this models one brand's exclusion,
 * not the production pool's exact lock-wait placement. No browser or actual provider.
 */
export async function runLatencyScenario(input:LatencyOptions):Promise<LatencySample> {
 const options={authMs:0,ackMs:0,workerIntervalMs:1000,pollIntervalMs:2500,pollFloorMs:500,...input};
 for(const [key,value] of Object.entries(options))if(!Number.isFinite(value)||value<0)throw new Error('Invalid latency option: '+key);
 const actual=await testDatabase(),actor=new AsyncLocalStorage<string>();
 let capture=false,origin=0,stopped=false,providerCalls=0,authCalls=0,polls=0,observedDetailMs=0,callbackCommittedMs=0;
 const clock=()=>performance.now()-origin;
 const spans:TimingSpan[]=[],operations:{actor:string;type:string;startMs:number;endMs:number}[]=[];
 const commits:{actor:string;atMs:number}[]=[];
 const delay=(ms:number)=>ms>0?sleep(ms):Promise.resolve();
 async function timed<T>(name:string,fn:()=>Promise<T>):Promise<T> {
  const span={name,startMs:clock(),endMs:0};spans.push(span);
  try{return await fn();}finally{span.endMs=clock();}
 }
 async function dbOperation<T>(type:string,fn:()=>Promise<T>):Promise<T> {
  if(!capture)return fn();
  const entry={actor:actor.getStore()??'unscoped',type,startMs:clock(),endMs:0};operations.push(entry);
  try{await delay(options.rttMs);return await fn();}finally{entry.endMs=clock();}
 }
 const instrumented=(tx:Queryable):Queryable=>({query:<T>(sql:string,params?:unknown[])=>dbOperation('query',()=>tx.query<T>(sql,params))});
 const db:Database={
  ...instrumented(actual),close:()=>actual.close(),
  transaction:async fn=>{
   await dbOperation('BEGIN',async()=>undefined);
   try {
    const result=await actual.transaction(async tx=>{const value=await fn(instrumented(tx));await dbOperation('COMMIT',async()=>undefined);return value;});
    if(capture)commits.push({actor:actor.getStore()??'unscoped',atMs:clock()});
    return result;
   }catch(error){await dbOperation('ROLLBACK',async()=>undefined);throw error;}
  },
 };
 const config={...testConfig,EXECUTION_MODE:'laboratory' as const};
 let app:Awaited<ReturnType<typeof createServer>>|undefined,worker:Promise<void>|undefined,completion:Promise<void>|undefined,failure:unknown;
 const stopSleep=new AbortController();
 const headers={authorization:'Bearer synthetic-latency-user'};
 const profile='Sou Marina Teste. Quero abrir em Vila Aurora e operar pessoalmente. Meu irmão Caio decide comigo.';
 const transport:typeof fetch=async(url,request)=>{
  const target=url instanceof Request?url.url:String(url);
  if(target===config.SUPABASE_URL+'/auth/v1/user'){
   if(capture){authCalls++;await timed('auth',()=>delay(options.authMs));}
   return Response.json({id:'latency-tester'});
  }
  if(target!==config.N8N_WEBHOOK_URL)throw new Error('Offline harness rejected an unexpected transport destination');
  providerCalls++;assert.equal(providerCalls,1,'the fixture must reserve and dispatch exactly once');
  const payload=JSON.parse(String(request?.body)) as Awaited<ReturnType<Engine['prepare']>>;
  const message=payload.context.messages.findLast(item=>item.role==='user');assert.ok(message);
  const evidence={messageId:message.id,quote:profile};
  const result={bubbles:['Entendi: você pretende abrir em Vila Aurora e Caio participa da decisão.','Em qual prazo você pensa em começar?'],
   proposals:[{field:'city',value:{kind:'text',text:'Vila Aurora'},evidence,attribution:'candidate',capitalOrigin:null,relationId:null,replacesFactId:null}],
   relations:[{id:'synthetic-family',name:'Caio',role:'family',evidence}],referral:null,sourceRefs:[],nextAction:'continue',handoffReason:null};
  completion=(async()=>{
   const modelStarted=clock();
   await timed('model',()=>delay(options.providerMs));
   const modelRoundTripMs=Math.round(clock()-modelStarted);
   await actor.run('callback',()=>timed('callback',async()=>{
    const response=await app!.inject({method:'POST',url:'/internal/n8n/jobs/'+encodeURIComponent(payload.jobId)+'/complete',
     headers:{authorization:'Bearer '+config.N8N_CALLBACK_TOKEN},payload:{jobId:payload.jobId,contextVersion:payload.contextVersion,configVersion:payload.configVersion,
      model:payload.model,usage:{input_tokens:1000,output_tokens:80,total_tokens:1080},result,timings:{modelRoundTripMs}}});
    assert.equal(response.statusCode,200,'offline completion callback must succeed');assert.equal(response.json().accepted,true);
   }));
  })().catch(error=>{failure=error;});
  await timed('n8n-ack',()=>delay(options.ackMs));
  return Response.json({accepted:true},{status:202});
 };
 try {
  await seedPilot(actual,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  await actual.query("INSERT INTO sdr.memberships VALUES ('latency-tester','cognita-homologacao','sapore','tester',true)");
  app=await createServer(db,config,{transport});
  const created=await app.inject({method:'POST',url:'/v1/lab/sessions',headers,payload:{requestId:randomUUID(),label:'Synthetic timing fixture',scenario:'free'}});
  assert.equal(created.statusCode,200,'offline session setup must succeed');
  const sessionId=created.json().id as string;
  const store=new Store(db),engine=new Engine(store,config,transport),briefings=new Briefings(store,config,transport);
  origin=performance.now();capture=true;
  // A fixed phase: the first worker scan and the POST start together. Production phase varies.
  worker=actor.run('worker',async()=>{
   while(!stopped){
    for(const channel of await store.channels()){
     if((channel.kind??'whatsapp')!==config.EXECUTION_MODE)continue;
     await briefings.dispatch(channel);
     const job=await timed('claim',()=>store.claim(channel));
     if(job)await timed('dispatch',()=>engine.dispatch(channel,job));
    }
    if(!stopped)await sleep(options.workerIntervalMs,undefined,{signal:stopSleep.signal}).catch(error=>{if(!stopSleep.signal.aborted)throw error;});
   }
  }).catch(error=>{failure=error;});
  const sent=await actor.run('send',()=>timed('send',()=>app!.inject({method:'POST',url:'/v1/lab/sessions/'+sessionId+'/messages',headers,
   payload:{requestId:randomUUID(),text:profile}})));
  assert.equal(sent.statusCode,200,'offline send must succeed');
  let waitMs=options.pollIntervalMs;
  while(clock()<60000){
   await delay(waitMs);if(failure)throw failure;
   const pollStarted=clock();polls++;
   const response=await actor.run('detail',()=>timed('detail',()=>app!.inject({method:'GET',url:'/v1/lab/sessions/'+sessionId,headers})));
   assert.equal(response.statusCode,200,'offline detail must be authorized');
   const detail=response.json();
   if(detail.job?.state==='completed'){
    assert.equal(detail.messages.filter((message:{actor:string})=>message.actor==='agent').length,2,'completion must contain both validated bubbles');
    observedDetailMs=clock();break;
   }
   assert.ok(['pending','working','running'].includes(detail.job?.state),'unexpected terminal state invalidates the fixture');
   waitMs=Math.max(options.pollFloorMs,options.pollIntervalMs-(clock()-pollStarted));
  }
  assert.ok(observedDetailMs,'offline detail was not available within the fixture deadline');
  stopped=true;stopSleep.abort();await worker;await completion;if(failure)throw failure;
  capture=false;
  callbackCommittedMs=commits.find(item=>item.actor==='callback')?.atMs??0;assert.ok(callbackCommittedMs);
  const completionEvent=(await actual.query<{detail:{guardPassed:boolean}}>("SELECT detail FROM sdr.events WHERE type='turn_completed'")).rows;
  const reservations=(await actual.query<{detail:{settled:boolean}}>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(completionEvent.length,1);assert.equal(reservations.length,1);
  const invariants={guardPassed:completionEvent[0].detail.guardPassed,settled:reservations[0].detail.settled,
   facts:(await actual.query('SELECT id FROM sdr.facts')).rows.length,relations:(await actual.query('SELECT id FROM sdr.relations')).rows.length,
   deliveries:(await actual.query('SELECT job_id FROM sdr.deliveries')).rows.length};
  const window=operations.filter(item=>item.startMs<=observedDetailMs),byActor:Record<string,number>={};
  for(const operation of window)byActor[operation.actor]=(byActor[operation.actor]??0)+1;
  return {kind:'offline-simulation',endpoint:'authenticated-committed-detail-not-render',options,observedDetailMs,callbackCommittedMs,providerCalls,authCalls,polls,
   // Wire/query counts start within the observation window; transactions count completed commits.
   // A worker operation may drain after observation. Its full span is not added to critical time.
   database:{queries:window.filter(item=>item.type==='query').length,transactions:commits.filter(item=>item.atMs<=observedDetailMs).length,wireExchanges:window.length,byActor},
   spans:[...spans,...window.map(item=>({name:'db:'+item.actor+':'+item.type,startMs:item.startMs,endMs:item.endMs}))].sort((a,b)=>a.startMs-b.startMs),invariants};
 }finally{
  stopped=true;stopSleep.abort();await worker;await completion;capture=false;await app?.close();await actual.close();
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 for(const rttMs of [136.984,10])for(const providerMs of [3000,5500]){
  const sample=await runLatencyScenario({rttMs,providerMs});
  process.stdout.write(JSON.stringify(sample)+'\n');
 }
}
