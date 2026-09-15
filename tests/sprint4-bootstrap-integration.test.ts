import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { initialSnapshot, seedPilot } from '../src/seed.js';
import { Versioning } from '../src/versioning.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { createServer } from '../src/server.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { Sprint4Http } from '../evaluations/sprint4-http.js';
import { Sprint4Bootstrap } from '../evaluations/sprint4-bootstrap.js';
import { Sprint4BootstrapStorage } from '../evaluations/sprint4-bootstrap-storage.js';
import { Sprint4BootstrapReconciler } from '../evaluations/sprint4-bootstrap-reconcile.js';
import type { BootstrapIntent, BootstrapReconciler } from '../evaluations/sprint4-bootstrap.spec.js';
import { testConfig } from './config.js';

const scope={tenantId:'cognita-homologacao',brandId:'sapore'},credential={actorUserId:'synthetic-bootstrap-admin',accessToken:'synthetic-bootstrap-token'};
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'sprint4-bootstrap-integration-')),pg=new PGlite({extensions:{vector}});
 const db:Database={query:(sql,params)=>pg.query(sql,params),transaction:fn=>pg.transaction(tx=>fn(tx as Queryable)),close:()=>pg.close()};
 const stores:Sprint4BootstrapStorage[]=[];let app:Awaited<ReturnType<typeof createServer>>|undefined;
 t.after(async()=>{await app?.close();for(const store of stores)await store.execute({action:'close'});await db.close();await rm(directory,{recursive:true,force:true});});
 for(const name of ['001_sdr.sql','002_versions.sql','003_lab_sessions.sql'])await pg.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic bootstrap'}],adminUserIds:[credential.actorUserId]});
 const draft=await new Versioning(db).saveDraft(scope,createFinancialDraftSnapshot(initialSnapshot(scope)),credential.actorUserId);assert.ok(draft.ok);
 const planned=new Sprint4CampaignPlanner().execute({runId:'bootstrap-integration',actorUserId:credential.actorUserId,target:{versionId:draft.value.versionId,contentHash:draft.value.contentHash,model:'gpt-5.4-2026-03-05'}});assert.ok(planned.success);
 app=await createServer(db,{...testConfig,EXECUTION_MODE:'laboratory'}, {transport:async(url)=>{
  assert.equal(url,testConfig.SUPABASE_URL+'/auth/v1/user');return Response.json({id:credential.actorUserId});
 }});
 let posts=0,dropAck=false;
 const transport:typeof fetch=async(url,init)=>{
  const target=new URL(String(url));assert.equal(target.origin,'https://sdr-api.cognitaai.com.br');
  assert.ok(init?.method==='GET'&&target.pathname==='/v1/me'||init?.method==='POST'&&target.pathname==='/v1/lab/evaluation-sessions');
  if(init?.method==='POST')posts++;
  const headers:Record<string,string>={};new Headers(init?.headers).forEach((value,key)=>{headers[key]=value;});
  const result=await app!.inject({method:init!.method as 'GET'|'POST',url:target.pathname,headers,...(init?.body===undefined?{}:{payload:String(init.body)})});
  if(dropAck&&init?.method==='POST'){assert.equal(result.statusCode,200);throw new Error('synthetic lost ACK after COMMIT');}
  return new Response(result.body,{status:result.statusCode});
 };
 const reconciler:BootstrapReconciler={inspect:(intent:BootstrapIntent)=>db.transaction(async tx=>{
  await tx.query('SET TRANSACTION READ ONLY');await tx.query("SELECT set_config('sdr.tenant_id',$1,true),set_config('sdr.brand_id',$2,true)",[scope.tenantId,scope.brandId]);
  return new Sprint4BootstrapReconciler(tx).inspect(intent);
 })};
 return {db,directory,plan:planned.data,http:new Sprint4Http(credential,transport),reconciler,
  store(initializeNew=false){const store=new Sprint4BootstrapStorage({directory,initializeNew});stores.push(store);return store;},
  get posts(){return posts;},set dropAck(value:boolean){dropAck=value;}};
}

// Real local routing, creation transaction, SQLite COMMIT/reopen and read-only SQL reconciliation.
// Supabase identity is simulated; no socket/TLS, remote database, messages, model or paid call.
test('lost HTTP creation ACK is recovered after SQLite reopen without POST replay, even after draft change, admin revocation and pause',async t=>{
 const f=await fixture(t),storage=f.store(true),executionId=f.plan.phases[0].executions[0].id,key={plan:f.plan,executionId};f.dropAck=true;
 const first=await new Sprint4Bootstrap({storage,http:f.http}).execute({action:'ensure-session',...key});
 assert.deepEqual(first,{success:false,error:{code:'CREATION_UNCONFIRMED',requiresReconciliation:true}});assert.equal(f.posts,1);
 const sessions=(await f.db.query<{id:string,candidate_id:string}>('SELECT id,candidate_id FROM sdr.lab_sessions')).rows;assert.equal(sessions.length,1);
 await storage.execute({action:'close'});
 const reopened=f.store(),bootstrap=new Sprint4Bootstrap({storage:reopened,http:f.http,reconciler:f.reconciler});
 const pending=await bootstrap.execute({action:'ensure-session',...key});assert.ok(pending.success);assert.equal(pending.data.kind,'awaiting-reconciliation');assert.equal(f.posts,1);
 await f.db.query('UPDATE sdr.memberships SET active=false WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3',[scope.tenantId,scope.brandId,credential.actorUserId]);
 await f.db.query("UPDATE sdr.drafts SET snapshot=jsonb_set(snapshot,'{model}','\"synthetic-changed-model\"') WHERE tenant_id=$1 AND brand_id=$2",[scope.tenantId,scope.brandId]);
 await f.db.query("UPDATE sdr.conversations SET state='human' WHERE id=$1",[sessions[0].id]);
 const recovered=await bootstrap.execute({action:'reconcile',...key});assert.ok(recovered.success,JSON.stringify(recovered));assert.equal(recovered.data.kind,'session-recorded');
 if(recovered.data.kind!=='session-recorded')return;
 assert.equal(recovered.data.record.observation.session.id,sessions[0].id);assert.equal(recovered.data.record.observation.session.candidateId,sessions[0].candidate_id);
 assert.equal(recovered.data.record.observation.session.state,'human');assert.equal(recovered.data.record.observation.source,'database-readonly');
 assert.equal('readyToExecute' in recovered.data,false);assert.equal(f.posts,1);
 await reopened.execute({action:'close'});
 assert.deepEqual(await new Sprint4Bootstrap({storage:f.store(),http:f.http}).execute({action:'ensure-session',...key}),recovered);
 for(const table of ['jobs','messages','deliveries','publication_events'])assert.equal((await f.db.query(`SELECT count(*)::int AS n FROM sdr.${table}`)).rows[0].n,0);
 assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length,0);
 assert.equal((await f.db.query('SELECT phone_number_id FROM sdr.channels WHERE enabled')).rows.length,0);
});

test('two bootstrap executors with independent SQLite connections create one session and converge on the winner',async t=>{
 const f=await fixture(t),executionId=f.plan.phases[0].executions[0].id,key={plan:f.plan,executionId},first=f.store(true);
 assert.equal((await first.execute({action:'read',runId:f.plan.request.runId,executionId})).success,true);
 const second=f.store(),a=new Sprint4Bootstrap({storage:first,http:f.http}),b=new Sprint4Bootstrap({storage:second,http:f.http});
 const results=await Promise.all([a.execute({action:'ensure-session',...key}),b.execute({action:'ensure-session',...key})]);
 assert.ok(results.every(result=>result.success),JSON.stringify(results));assert.equal(f.posts,1);
 const recordA=await a.execute({action:'ensure-session',...key}),recordB=await b.execute({action:'ensure-session',...key});
 assert.deepEqual(recordA,recordB);assert.ok(recordA.success);assert.equal(recordA.data.kind,'session-recorded');assert.equal(f.posts,1);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM sdr.lab_sessions')).rows[0].n,1);
 assert.equal((await f.db.query("SELECT count(*)::int AS n FROM sdr.events WHERE type='lab_evaluation_session_created'")).rows[0].n,1);
 assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length,0);
});
