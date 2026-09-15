import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,chmod,stat,writeFile,readFile,symlink,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn,type ChildProcess } from 'node:child_process';
import { Sprint4Journal } from '../evaluations/sprint4-journal.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import type { ControllerState,LegacyControllerState } from '../evaluations/sprint4-controller.spec.js';

// Literal pre-v2 fixture: only tests seed this historical payload directly into SQLite.
function legacyInitial():LegacyControllerState {
 const result=new Sprint4CampaignPlanner().execute({runId:'journal-fixture',actorUserId:'offline-admin',target:{versionId:'offline-version',contentHash:'a'.repeat(64),model:'gpt-5.4-2026-03-05'}});assert.ok(result.success);
 const plan=result.data,turnId=plan.phases[0].executions[0].turns[0].id;
 return {revision:1,plan,entries:[{turnId,receipts:[],preflight:{turnId,actorUserId:plan.request.actorUserId,target:plan.request.target,evidenceRef:'offline-evidence',
  observedAtMs:1000,validUntilMs:2000,deadlineAtMs:61000,adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,
  tenantId:'cognita-homologacao',brandId:'sapore',executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,
  sessionId:'offline-session',sessionOwned:true,sessionReady:true,sessionFresh:true,requestId:'11111111-1111-4111-8111-111111111111',
  budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000,accountedMicroUsd:400000,exactPayloadBound:16000,reservationMicroUsd:58000,remainingCampaignReviewed:true},
  daily:{actorUserId:plan.request.actorUserId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}}}]};
}
function initial():ControllerState {
 const plan=legacyInitial().plan,turnId=plan.phases[0].executions[0].turns[0].id;
 return {protocol:'sprint4-admission-v2',revision:1,plan,entries:[{turnId,receipts:[],admission:{turnId,actorUserId:plan.request.actorUserId,target:plan.request.target,evidenceRef:'offline-evidence',
  observedAtMs:1000,validUntilMs:2000,adminActive:true,routeValidated:true,published:false,healthy:true,noUnexpectedJobs:true,
  tenantId:'cognita-homologacao',brandId:'sapore',executionMode:'laboratory',channelEnabled:false,nativeControlVerified:false,retentionEnabled:false,
  sessionId:'offline-session',sessionOwned:true,sessionReady:true,sessionFresh:true,requestId:'11111111-1111-4111-8111-111111111111',
  budget:{gateId:'sprint3-continuous-20260910',limitMicroUsd:1000000,accountedMicroUsd:400000,maxReservationMicroUsd:58000,remainingCampaignReviewed:true},
  daily:{actorUserId:plan.request.actorUserId,limitMessages:100,rollingWindowHours:24,usedMessages:0,stageAndControlsReviewed:true}}}]};
}
function withReceipt(state:ControllerState):ControllerState {
 const next=structuredClone(state);next.revision++;
 const entry=next.entries.at(-1)!;
 entry.receipts.push({receiptId:'offline-receipt',turnId:entry.turnId,requestId:entry.admission.requestId,sessionId:entry.admission.sessionId,target:state.plan.request.target,
  observedAtMs:1500,kind:'ambiguous',jobId:null,evidenceRef:'offline-timeout-evidence',jobState:'unknown',guardCodes:[],criticalCodes:[],objectiveAudit:'unknown',
  ledger:{reservationId:null,state:'unknown',costMicroUsd:null},jobDeadlineAtMs:null,preparation:null,responseArtifactRef:null,rawArtifactRef:null});
 return next;
}
function message(child:ChildProcess):Promise<unknown>{return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('offline child timed out')),10000);
 child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('error',error=>{clearTimeout(timer);reject(error);});
});}

test('failed COMMIT and rollback quarantine the journal instead of exposing an uncommitted receipt',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-rollback-')),journal=new Sprint4Journal({directory,initializeNew:true}),state=initial(),runId=state.plan.request.runId;
 let db:DatabaseSync|undefined,exec:((sql:string)=>void)|undefined;
 try{
  assert.equal((await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:state})).success,true);
  db=(journal as unknown as {db:DatabaseSync}).db;exec=db.exec.bind(db);
  db.exec=sql=>{if(sql==='COMMIT'||sql==='ROLLBACK')throw new Error('synthetic-private-rollback-failure');exec!(sql);};
  assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision:1,next:withReceipt(state)}),{success:false,error:{code:'STORAGE_FAILURE'}});
  const after=await journal.execute({action:'read',runId});assert.equal(after.success,false,'uncommitted revision must not be returned as durable');
  await assert.rejects(journal.asCampaignJournal().read(runId));
  db.exec=exec;await journal.execute({action:'close'});db=undefined;
  const reopened=new Sprint4Journal({directory});
  try{assert.deepEqual(await reopened.asCampaignJournal().read(runId),state);}finally{await reopened.execute({action:'close'});}
 }finally{
  if(db&&exec){db.exec=exec;try{exec('ROLLBACK');}catch{/* Already closed or rolled back. */}}
  await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});
 }
});

test('a committed intent survives closing and reopening the local journal with the exact fixed plan',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-'));const state=initial();
 const journal=new Sprint4Journal({directory,initializeNew:true});
 try{
  assert.deepEqual(await journal.execute({action:'read',runId:state.plan.request.runId}),{success:true,data:{kind:'read',state:null}});
  assert.deepEqual(await journal.execute({action:'compare-and-swap',runId:state.plan.request.runId,expectedRevision:null,next:state}),{success:true,data:{kind:'compared',swapped:true}});
  await journal.execute({action:'close'});
  const reopened=new Sprint4Journal({directory});
  assert.deepEqual(await reopened.execute({action:'read',runId:state.plan.request.runId}),{success:true,data:{kind:'read',state}});
  await reopened.execute({action:'close'});
 }finally{await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});

test('durability settings stay enabled and a real SQLite write failure rolls back without leaking its details through the bridge',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),journal=new Sprint4Journal({directory,initializeNew:true}),state=initial(),runId=state.plan.request.runId;
 try{
  await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:state});
  const db=(journal as unknown as {db:DatabaseSync}).db;
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode,'delete');assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous,3);assert.equal(db.prepare('PRAGMA fullfsync').get()?.fullfsync,1);
  db.exec("CREATE TRIGGER fail_fixture BEFORE INSERT ON revisions WHEN NEW.revision>1 BEGIN SELECT RAISE(ABORT,'private-fixture-canary'); END");
  const result=await journal.execute({action:'compare-and-swap',runId,expectedRevision:1,next:withReceipt(state)});
  assert.deepEqual(result,{success:false,error:{code:'STORAGE_FAILURE'}});
  await assert.rejects(journal.asCampaignJournal().compareAndSwap(runId,1,withReceipt(state)),error=>error instanceof Error&&error.message==='STORAGE_FAILURE');
  assert.deepEqual(await journal.asCampaignJournal().read(runId),state);assert.equal(db.prepare('SELECT count(*) AS n FROM revisions').get()?.n,1);
  await journal.execute({action:'close'});await assert.rejects(journal.asCampaignJournal().read(runId),/CLOSED/);
 }finally{await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});

test('rejecting a foreign SQLite format does not rewrite its journal mode or file bytes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),runId=initial().plan.request.runId;
 try{
  const path=join(directory,'sprint4-journal.sqlite');await writeFile(path,'',{mode:0o600});
  const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE unrelated(value TEXT)');db.close();
  const before=await readFile(path),journal=new Sprint4Journal({directory});
  assert.equal((await journal.execute({action:'read',runId})).success,false);await journal.execute({action:'close'});
  assert.deepEqual(await readFile(path),before);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('two real processes racing the same revision get one durable winner and reopening survives SIGKILL after acknowledgment',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),journal=new Sprint4Journal({directory,initializeNew:true}),state=initial(),runId=state.plan.request.runId;
 const children:ChildProcess[]=[];let blocker:DatabaseSync|undefined;
 try{
  await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:state});await journal.execute({action:'close'});
  const source=`import {Sprint4Journal} from ${JSON.stringify(new URL('../evaluations/sprint4-journal.js',import.meta.url).href)};
   const journal=new Sprint4Journal({directory:process.argv[1]});
   const ready=await journal.execute({action:'read',runId:${JSON.stringify(runId)}});process.send({ready:ready.success});
   process.on('message',async next=>{const result=await journal.execute({action:'compare-and-swap',runId:${JSON.stringify(runId)},expectedRevision:1,next});process.send(result);});`;
  for(let i=0;i<2;i++)children.push(spawn(process.execPath,['--import','tsx','--input-type=module','--eval',source,directory],{stdio:['ignore','ignore','ignore','ipc']}));
  assert.deepEqual(await Promise.all(children.map(message)),[{ready:true},{ready:true}]);
  blocker=new DatabaseSync(join(directory,'sprint4-journal.sqlite'));blocker.exec('BEGIN IMMEDIATE');
  const candidates=[withReceipt(state),withReceipt(state)];candidates[1].entries[0].receipts[0].receiptId='other-process-receipt';
  const outcomes=children.map(message);children.forEach((child,index)=>child.send(candidates[index]));
  await new Promise(resolve=>setTimeout(resolve,100));blocker.exec('COMMIT');blocker.close();blocker=undefined;
  const results=await Promise.all(outcomes) as Array<{success:boolean;data:{kind:string;swapped:boolean}}>;
  assert.ok(results.every(result=>result.success&&result.data.kind==='compared'));assert.equal(results.filter(result=>result.data.swapped).length,1);
  await Promise.all(children.map(child=>new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.kill('SIGKILL');})));
  const reopened=new Sprint4Journal({directory});assert.deepEqual(await reopened.asCampaignJournal().read(runId),candidates[results.findIndex(result=>result.data.swapped)]);await reopened.execute({action:'close'});
  const inspect=new DatabaseSync(join(directory,'sprint4-journal.sqlite'),{readOnly:true});assert.equal(inspect.prepare('SELECT count(*) AS n FROM revisions WHERE run_id=?').get(runId)?.n,2);inspect.close();
 }finally{if(blocker){try{blocker.exec('ROLLBACK');}finally{blocker.close();}}children.forEach(child=>child.kill('SIGKILL'));await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});

test('a failed format check cannot leave an open connection that later returns an empty successful state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),runId=initial().plan.request.runId;
 try{
  const path=join(directory,'sprint4-journal.sqlite');await writeFile(path,'',{mode:0o600});
  const foreign=new DatabaseSync(path);foreign.exec('CREATE TABLE revisions(run_id TEXT,revision INTEGER,payload TEXT)');foreign.close();
  const journal=new Sprint4Journal({directory});
  assert.deepEqual(await journal.execute({action:'read',runId}),{success:false,error:{code:'CORRUPT_STATE'}});
  assert.deepEqual(await journal.execute({action:'read',runId}),{success:false,error:{code:'CORRUPT_STATE'}});
  await assert.rejects(journal.asCampaignJournal().read(runId),/CORRUPT_STATE/);await journal.execute({action:'close'});
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('reopening never initializes a missing or foreign database, and corrupt stored state is an error rather than null',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),state=initial(),runId=state.plan.request.runId;
 try{
  const absent=await new Sprint4Journal({directory}).execute({action:'read',runId});assert.equal(absent.success,false);
  const journal=new Sprint4Journal({directory,initializeNew:true});assert.equal((await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:state})).success,true);
  await journal.execute({action:'close'});
  const db=new DatabaseSync(join(directory,'sprint4-journal.sqlite'));
  try{db.prepare('INSERT INTO revisions(run_id,revision,payload) VALUES(?,?,?)').run(runId,2,'{}');}finally{db.close();}
  const corrupt=new Sprint4Journal({directory});assert.deepEqual(await corrupt.execute({action:'read',runId}),{success:false,error:{code:'CORRUPT_STATE'}});
  await assert.rejects(corrupt.asCampaignJournal().read(runId),/CORRUPT_STATE/);await corrupt.execute({action:'close'});
  const foreign=join(directory,'foreign');await mkdir(foreign,{mode:0o700});await writeFile(join(foreign,'sprint4-journal.sqlite'),'',{mode:0o600});
  assert.equal((await new Sprint4Journal({directory:foreign}).execute({action:'read',runId})).success,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('storage requires an explicit dedicated private directory and rejects permissive paths and symlink files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),runId=initial().plan.request.runId;
 try{
  await chmod(directory,0o755);const unsafe=new Sprint4Journal({directory});
  assert.deepEqual(await unsafe.execute({action:'read',runId}),{success:false,error:{code:'UNSAFE_STORAGE'}});
  await assert.rejects(unsafe.asCampaignJournal().read(runId),/UNSAFE_STORAGE/);
  await chmod(directory,0o700);
  const journal=new Sprint4Journal({directory,initializeNew:true});assert.equal((await journal.execute({action:'read',runId})).success,true);
  const file=join(directory,'sprint4-journal.sqlite');assert.equal((await stat(file)).mode&0o777,0o600);
  await chmod(file,0o644);assert.equal((await journal.execute({action:'read',runId})).success,false);await journal.execute({action:'close'});
  assert.equal((await new Sprint4Journal({directory:'.'}).execute({action:'read',runId})).success,false);
  const nested=join(directory,'nested');await mkdir(nested,{mode:0o700});const target=join(directory,'untouched');await writeFile(target,'private-fixture',{mode:0o600});
  await symlink(target,join(nested,'sprint4-journal.sqlite'));
  assert.deepEqual(await new Sprint4Journal({directory:nested}).execute({action:'read',runId}),{success:false,error:{code:'UNSAFE_STORAGE'}});
  assert.equal((await new Sprint4Journal({directory}).execute({action:'read',runId:'../escape'})).success,false);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('only append-only canonical transitions are stored: no reset, pin change, deleted receipt or mutated intent',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),journal=new Sprint4Journal({directory,initializeNew:true}),state=initial(),runId=state.plan.request.runId;
 try{
  await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:state});
  const reset={...state,revision:2,entries:[]};
  assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision:1,next:reset}),{success:false,error:{code:'INVALID_TRANSITION'}});
  const next=withReceipt(state);await journal.execute({action:'compare-and-swap',runId,expectedRevision:1,next});
  const changes:Array<(value:ControllerState)=>void>=[
   value=>{value.entries[0].receipts=[];},value=>{value.entries[0].admission.sessionId='changed';},
   value=>{value.plan.request.target.versionId='changed';},value=>{value.revision=9;},
   value=>{value.entries[0].receipts[0].evidenceRef='changed';},value=>{value.plan.request.cases[0].inputs[0]='changed';},
  ];
  for(const change of changes){const altered=structuredClone(next);altered.revision=3;change(altered);
   const result=await journal.execute({action:'compare-and-swap',runId,expectedRevision:2,next:altered});assert.equal(result.success,false);}
  assert.deepEqual(await journal.asCampaignJournal().read(runId),next);
  assert.equal((await journal.execute({action:'compare-and-swap',runId:'different-run',expectedRevision:null,next:state})).success,false);
 }finally{await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});

test('CAS compares the durable revision and appends a new receipt without replacing the earlier revision',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),journal=new Sprint4Journal({directory,initializeNew:true}),state=initial(),runId=state.plan.request.runId;
 try{
  await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:state});
  assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:state}),{success:true,data:{kind:'compared',swapped:false}});
  const next=withReceipt(state);
  assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision:9,next}),{success:true,data:{kind:'compared',swapped:false}});
  assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision:1,next}),{success:true,data:{kind:'compared',swapped:true}});
  assert.deepEqual(await journal.asCampaignJournal().read(runId),next);
 }finally{await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});

test('legacy history is read literally but every CAS or upgrade is refused before revision comparison',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),legacy=legacyInitial(),runId=legacy.plan.request.runId;
 const nextLegacy=structuredClone(legacy);nextLegacy.revision=2;
 const entry=nextLegacy.entries[0];entry.receipts.push({receiptId:'legacy-receipt',turnId:entry.turnId,requestId:entry.preflight.requestId,sessionId:entry.preflight.sessionId,target:legacy.plan.request.target,
  observedAtMs:1500,kind:'ambiguous',jobId:null,evidenceRef:'legacy-timeout-evidence',jobState:'unknown',guardCodes:[],criticalCodes:[],objectiveAudit:'unknown',
  ledger:{reservationId:null,state:'unknown',costMicroUsd:null},responseArtifactRef:null,rawArtifactRef:null});
 const path=join(directory,'sprint4-journal.sqlite'),journal=new Sprint4Journal({directory});
 try{
  await writeFile(path,'',{mode:0o600});const seed=new DatabaseSync(path);
  seed.exec('CREATE TABLE revisions(run_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,revision)) STRICT; PRAGMA application_id=1396986420; PRAGMA user_version=1;');
  for(const state of [legacy,nextLegacy])seed.prepare('INSERT INTO revisions(run_id,revision,payload) VALUES(?,?,?)').run(runId,state.revision,JSON.stringify(state,null,2));
  seed.close();const before=await readFile(path);
  assert.deepEqual(await journal.execute({action:'read',runId}),{success:true,data:{kind:'read',state:nextLegacy}});
  assert.deepEqual(await journal.asCampaignJournal().read(runId),nextLegacy);
  for(const expectedRevision of [2,null,999])for(const next of [{...nextLegacy,revision:3},{...initial(),revision:3}]){
   assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision,next}),{success:false,error:{code:'INVALID_TRANSITION'}});
  }
  await assert.rejects(journal.asCampaignJournal().compareAndSwap(runId,2,{...initial(),revision:3}),/INVALID_TRANSITION/);
  await journal.execute({action:'close'});assert.deepEqual(await readFile(path),before);
  const inspect=new DatabaseSync(path,{readOnly:true});
  assert.equal(inspect.prepare('PRAGMA user_version').get()?.user_version,1);
  assert.deepEqual(inspect.prepare('SELECT revision,payload FROM revisions WHERE run_id=? ORDER BY revision').all(runId).map(row=>({...row})),
   [legacy,nextLegacy].map(state=>({revision:state.revision,payload:JSON.stringify(state,null,2)})));inspect.close();
 }finally{await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});

test('new runs require explicit v2 and cannot initialize a legacy, unknown or mixed protocol',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),journal=new Sprint4Journal({directory,initializeNew:true}),state=initial(),runId=state.plan.request.runId;
 try{
  assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next:legacyInitial()}),{success:false,error:{code:'INVALID_TRANSITION'}});
  for(const next of [{...state,protocol:'sprint4-admission-v3'},{...legacyInitial(),protocol:'sprint4-admission-v2'},
   {...state,entries:[{...state.entries[0],preflight:legacyInitial().entries[0].preflight}]}]){
   assert.deepEqual(await journal.execute({action:'compare-and-swap',runId,expectedRevision:null,next}),{success:false,error:{code:'INVALID_INPUT'}});
  }
  assert.equal(await journal.asCampaignJournal().read(runId),null);
  assert.equal(await journal.asCampaignJournal().compareAndSwap(runId,null,state),true);
  await journal.execute({action:'close'});
  const db=new DatabaseSync(join(directory,'sprint4-journal.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) AS n FROM revisions').get()?.n,1);assert.equal(db.prepare('PRAGMA user_version').get()?.user_version,1);db.close();
 }finally{await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});

test('v2 records job acceptance and later measured preparation without backfilling the admission or earlier receipt',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sprint4-journal-')),journal=new Sprint4Journal({directory,initializeNew:true}),state=initial(),runId=state.plan.request.runId;
 try{
  assert.equal(await journal.asCampaignJournal().compareAndSwap(runId,null,state),true);
  const accepted=withReceipt(state),receipt=accepted.entries[0].receipts[0];
  receipt.receiptId='accepted-receipt';receipt.kind='accepted';receipt.jobId='offline-job';receipt.jobState='pending';receipt.jobDeadlineAtMs=65000;
  receipt.ledger={state:'not-reserved',reservationId:null,costMicroUsd:null};receipt.objectiveAudit='pending';
  assert.equal(await journal.asCampaignJournal().compareAndSwap(runId,1,accepted),true);
  const prepared=structuredClone(accepted);prepared.revision=3;
  prepared.entries[0].receipts.push({...receipt,receiptId:'prepared-receipt',kind:'prepared',jobState:'working',observedAtMs:1600,
   preparation:{attempt:2,inputTokenBound:16000,reservedMicroUsd:58000,reservationId:'offline-reservation'},
   ledger:{state:'reserved',reservationId:'offline-reservation',costMicroUsd:58000}});
  assert.equal(await journal.asCampaignJournal().compareAndSwap(runId,2,prepared),true);
  await journal.execute({action:'close'});
  const reopened=new Sprint4Journal({directory});assert.deepEqual(await reopened.asCampaignJournal().read(runId),prepared);await reopened.execute({action:'close'});
  const db=new DatabaseSync(join(directory,'sprint4-journal.sqlite'),{readOnly:true});
  const history=db.prepare('SELECT payload FROM revisions ORDER BY revision').all().map(row=>JSON.parse(String(row.payload)));
  assert.deepEqual(history,[state,accepted,prepared]);db.close();
  assert.equal('deadlineAtMs' in state.entries[0].admission,false);assert.equal('exactPayloadBound' in state.entries[0].admission.budget,false);
  assert.equal(accepted.entries[0].receipts[0].preparation,null);
 }finally{await journal.execute({action:'close'});await rm(directory,{recursive:true,force:true});}
});
