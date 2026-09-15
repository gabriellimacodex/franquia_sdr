import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import { createServer } from '../src/server.js';
import {seedPilot} from '../src/seed.js';
import { testDatabase } from './db-helper.js';
import { testConfig } from './config.js';

test('conversation review routes require authentication before reading or writing a target', async () => {
 const db=await testDatabase();
 let providerCalls=0;
 const app=await createServer(db,{...testConfig,EXECUTION_MODE:'laboratory'},{transport:async()=>{providerCalls++;throw new Error('No provider access expected');}});
 try {
  for(const request of [
   {method:'GET' as const,url:'/v1/conversations/private/review-target/private-job'},
   {method:'GET' as const,url:'/v1/conversations/private/reviews'},
   {method:'POST' as const,url:'/v1/conversations/private/reviews',payload:{}},
  ]) {
   const response=await app.inject(request);
   assert.equal(response.statusCode,401,response.body);
   assert.equal(response.json().error.code,'AUTHENTICATION_REQUIRED');
  }
  assert.equal(providerCalls,0);
  assert.equal((await db.query('SELECT id FROM sdr.events')).rows.length,0);
 } finally {await app.close();await db.close();}
});

test('authenticated HTTP review records the reviewer once and survives reloading without briefing or model use',async()=>{
 const db=await testDatabase();
 const authCalls:string[]=[];
 const app=await createServer(db,{...testConfig,EXECUTION_MODE:'laboratory'},{transport:async(url,init)=>{
  assert.equal(String(url),'https://supabase.example/auth/v1/user');
  const id=new Headers(init?.headers).get('authorization')!.slice(7);authCalls.push(id);
  return Response.json({id});
 }});
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  for(const role of ['tester','reviewer'])await db.query("INSERT INTO sdr.memberships VALUES($1,'cognita-homologacao','sapore',$2,true)",['synthetic-'+role,role]);
  const testerHeaders={authorization:'Bearer synthetic-tester'},reviewerHeaders={authorization:'Bearer synthetic-reviewer'};
  const sessionResponse=await app.inject({method:'POST',url:'/v1/lab/sessions',headers:testerHeaders,payload:{requestId:randomUUID(),label:'Synthetic HTTP review',scenario:'free'}});
  assert.equal(sessionResponse.statusCode,200,sessionResponse.body);
  const session=sessionResponse.json();
  const greeting=await app.inject({method:'POST',url:`/v1/lab/sessions/${session.id}/messages`,headers:testerHeaders,payload:{requestId:randomUUID(),text:'oi'}});
  assert.equal(greeting.statusCode,200,greeting.body);
  const jobId=greeting.json().jobId;
  const base=`/v1/conversations/${session.id}`;
  const viewResponse=await app.inject({url:base+'/review-target/'+encodeURIComponent(jobId),headers:reviewerHeaders});
  assert.equal(viewResponse.statusCode,200,viewResponse.body);
  const view=viewResponse.json();
  assert.equal(view.target.selectedJobId,jobId);
  assert.equal(view.target.turns[0].versionId,session.versionId);
  assert.equal(view.target.messages.length,2);
  const payload={jobId,targetHash:view.targetHash,idempotencyKey:randomUUID(),scores:{intentContext:3,commercialFidelity:3,clarityNaturalness:4,nextStepUtility:3},notes:'Synthetic fixture; not a human acceptance.'};
  const recorded=await app.inject({method:'POST',url:base+'/reviews',headers:reviewerHeaders,payload});
  assert.equal(recorded.statusCode,200,recorded.body);
  const saved=recorded.json();assert.equal(saved.duplicate,false);
  assert.equal(saved.review.actorUserId,'synthetic-reviewer');
  assert.deepEqual(saved.review.target,view.target);
  const reload=await app.inject({url:base+'/reviews',headers:reviewerHeaders});
  assert.equal(reload.statusCode,200,reload.body);assert.deepEqual(reload.json().reviews,[saved.review]);
  const replay=await app.inject({method:'POST',url:base+'/reviews',headers:reviewerHeaders,payload});
  assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),{review:saved.review,duplicate:true});
  for(const url of [base+'/reviews',base+'/review-target/'+encodeURIComponent(jobId)])assert.equal((await app.inject({url,headers:testerHeaders})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:base+'/reviews',headers:reviewerHeaders,payload:{...payload,actorUserId:'synthetic-admin'}})).statusCode,400);
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='sprint4_human_review_recorded'")).rows.length,1);
  assert.equal((await db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
  assert.equal((await db.query('SELECT id FROM sdr.briefings')).rows.length,0);
  assert.equal((await db.query('SELECT job_id FROM sdr.deliveries')).rows.length,0);
  assert.deepEqual((await db.query('SELECT version_id FROM sdr.active_versions')).rows,[{version_id:session.versionId}]);
  assert.ok(authCalls.includes('synthetic-reviewer'));
 }finally{await app.close();await db.close();}
});
