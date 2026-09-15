import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { seedPilot } from '../src/seed.js';
import { LabSessions } from '../src/lab-sessions.js';
import { createLeadState } from '../src/domain.js';
import { ConversationReview } from '../src/conversation-review.js';

const identity={tenantId:'cognita-homologacao',brandId:'sapore',userId:'synthetic-reviewer',role:'reviewer'};
async function fixture(){
 const pg=new PGlite({extensions:{vector}});
 for(const file of ['001_sdr.sql','002_versions.sql','003_lab_sessions.sql'])await pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const db:Database={query:(sql,params)=>pg.query(sql,params),transaction:fn=>pg.transaction(tx=>fn(tx as Queryable)),close:()=>pg.close()};
 await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
 await db.query("INSERT INTO sdr.memberships VALUES($1,$2,$3,'reviewer',true)",[identity.userId,identity.tenantId,identity.brandId]);
 const session=await new LabSessions(db).create(identity,{requestId:randomUUID(),label:'Synthetic review',scenario:'free'});assert.ok(session.ok);
 const {id:conversationId,candidateId,versionId}=session.value;
 const lead=createLeadState(identity.tenantId,identity.brandId,candidateId);
 for(const n of [1,2]){
  const stamp=`2026-09-14T12:00:0${n}.000001Z`,input='input-'+n,job='job-'+n,response='Resposta '+n;
  await db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp,created_at) VALUES($1,$2,$3,$4,$5,'candidate','text',$6,$7,$7)",[input,identity.tenantId,identity.brandId,conversationId,candidateId,'Pergunta '+n,stamp]);
  await db.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state,result,context,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,'completed',$9,$10,$11,$12)",[job,identity.tenantId,identity.brandId,conversationId,candidateId,input,n,versionId,JSON.stringify({bubbles:[response]}),JSON.stringify({lead,sources:[],excludedSources:[],instructions:'PRIVATE PROMPT',guardReview:{bubbles:['PRIVATE REJECTED']}}),stamp,`2026-09-14T12:00:0${n}.000002Z`]);
  await db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp,created_at) VALUES($1,$2,$3,$4,$5,'agent','text',$6,$7,$7)",[job+':reply:0',identity.tenantId,identity.brandId,conversationId,candidateId,response,`2026-09-14T12:00:0${n}.000002Z`]);
 }
 return {db,conversationId,candidateId,versionId,service:new ConversationReview(db)};
}

test('target derives the exact laboratory response and excludes later turns without exposing private context',async()=>{
 const f=await fixture();try{
  const result=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});
  assert.ok(result.success,JSON.stringify(result));assert.ok('target' in result.data);
  assert.deepEqual(result.data.target.messages.map(m=>m.id),['input-1','job-1:reply:0']);
  assert.equal(result.data.target.turns[0].versionId,f.versionId);assert.equal(result.data.target.turns[0].completedAt,'2026-09-14T12:00:01.000002+00:00');
  assert.deepEqual(result.data.target.turns[0].memoryBefore,{facts:[],relations:[]});
  assert.match(result.data.targetHash,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|instructions|guardReview/);
 }finally{await f.db.close();}
});

test('a free greeting remains reviewable when its canonical response was inserted after completed_at',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE sdr.jobs SET context='{\"origin\":\"deterministic_greeting\"}' WHERE id='job-1'");
  await f.db.query("UPDATE sdr.messages SET id='job-1:greeting',created_at='2026-09-14T12:00:01.000003Z' WHERE id='job-1:reply:0'");
  const result=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});
  assert.ok(result.success,JSON.stringify(result));assert.ok('target' in result.data);
  assert.deepEqual(result.data.target.turns[0].responseMessageIds,['job-1:greeting']);
  assert.equal(result.data.target.messages[1].jobId,'job-1');
 }finally{await f.db.close();}
});

test('explicit four-dimensional review persists the presented target and server identity without a briefing',async()=>{
 const f=await fixture();try{
  const view=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-2'});assert.ok(view.success&&'target' in view.data);
  const submission={jobId:'job-2',targetHash:view.data.targetHash,idempotencyKey:randomUUID(),scores:{intentContext:3,commercialFidelity:2,clarityNaturalness:4,nextStepUtility:3},notes:'Faltou responder à intenção.'};
  const result=await f.service.execute(identity,{action:'record',conversationId:f.conversationId,submission});
  assert.ok(result.success,JSON.stringify(result));assert.ok('review' in result.data);assert.equal(result.data.duplicate,false);
  const review=result.data.review;assert.equal(review.actorUserId,identity.userId);assert.deepEqual(review.target,view.data.target);
  assert.deepEqual(review.target.messages.map(m=>m.id),['input-1','job-1:reply:0','input-2','job-2:reply:0']);
  assert.equal((await f.db.query('SELECT id FROM sdr.evaluations')).rows.length,0);
  const history=await new ConversationReview(f.db).execute(identity,{action:'history',conversationId:f.conversationId});
  assert.ok(history.success&&'reviews' in history.data);assert.deepEqual(history.data.reviews,[review]);
  const row=(await f.db.query<{detail:unknown,at:string}>("SELECT detail,to_jsonb(created_at)#>>'{}' AS at FROM sdr.events WHERE type='sprint4_human_review_recorded'")).rows[0];
  assert.deepEqual(row.detail,review);assert.equal(row.at,review.reviewedAt);
 }finally{await f.db.close();}
});

test('replays recover the original review and a fresh key cannot create another score for the same actor and target',async()=>{
 const f=await fixture();try{
  const view=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});assert.ok(view.success&&'target' in view.data);
  const submission={jobId:'job-1',targetHash:view.data.targetHash,idempotencyKey:randomUUID(),scores:{intentContext:3,commercialFidelity:2,clarityNaturalness:4,nextStepUtility:3},notes:'Revisão pessoal sintética.'};
  const command={action:'record',conversationId:f.conversationId,submission},first=await f.service.execute(identity,command);assert.ok(first.success&&'review' in first.data);
  await f.db.query("UPDATE sdr.messages SET text='Alterada depois da revisão' WHERE id='job-1:reply:0'");
  for(const idempotencyKey of [submission.idempotencyKey,randomUUID()]){
   const repeated=await f.service.execute(identity,{...command,submission:{...submission,idempotencyKey}});
   assert.deepEqual(repeated,{success:true,data:{review:first.data.review,duplicate:true}});
   const changed=await f.service.execute(identity,{...command,submission:{...submission,idempotencyKey,notes:'Outra nota'}});
   assert.deepEqual(changed,{success:false,error:{code:'REVIEW_CONFLICT'}});
  }
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='sprint4_human_review_recorded'")).rows.length,1);
 }finally{await f.db.close();}
});

test('a repaired final response retains original guard codes but never the rejected text',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE sdr.jobs SET context=context||$1::jsonb WHERE id='job-1'",[JSON.stringify({guardReview:{violations:['commercial_promise'],bubbles:['PRIVATE REJECTED']}})]);
  await f.db.query("INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES('guard-1',$1,$2,$3,'turn_completed',$4)",[identity.tenantId,identity.brandId,f.conversationId,JSON.stringify({jobId:'job-1',versionId:f.versionId,guardPassed:true,modelGuardPassed:false,originalGuardViolations:['invented_number']})]);
  const result=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});assert.ok(result.success&&'target' in result.data);
  assert.deepEqual(result.data.target.turns[0].guardCodes,['commercial_promise','invented_number']);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE REJECTED/);
 }finally{await f.db.close();}
});

test('tampered archived target is rejected on history and replay instead of attributing changed text to a reviewer',async()=>{
 const f=await fixture();try{
  const view=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});assert.ok(view.success&&'target' in view.data);
  const submission={jobId:'job-1',targetHash:view.data.targetHash,idempotencyKey:randomUUID(),scores:{intentContext:3,commercialFidelity:2,clarityNaturalness:4,nextStepUtility:3},notes:'Revisão pessoal sintética.'};
  const command={action:'record',conversationId:f.conversationId,submission};assert.ok((await f.service.execute(identity,command)).success);
  await f.db.query("UPDATE sdr.events SET detail=jsonb_set(detail,'{target,messages,0,text}','\"Fabricado depois\"') WHERE type='sprint4_human_review_recorded'");
  for(const input of [command,{action:'history',conversationId:f.conversationId}])assert.deepEqual(await f.service.execute(identity,input),{success:false,error:{code:'READ_FAILED'}});
 }finally{await f.db.close();}
});

test('job context cannot expose a source absent from its pinned version',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE sdr.jobs SET context=context||$1::jsonb WHERE id='job-1'",[JSON.stringify({sources:[{id:'foreign-source',title:'Other tenant',content:'PRIVATE OTHER TENANT'}]})]);
  const result=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});
  assert.deepEqual(result,{success:false,error:{code:'INCOMPLETE_TARGET'}});
 }finally{await f.db.close();}
});

test('fresh target changes reject submission while current memory and active version are not review authorities',async()=>{
 const f=await fixture();try{
  const view=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});assert.ok(view.success&&'target' in view.data);
  await f.db.query("UPDATE sdr.candidates SET lead_state=jsonb_set(lead_state,'{qualification,reasons}','[\"FUTURE PRIVATE MEMORY\"]') WHERE id=$1",[f.candidateId]);
  await f.db.query('DELETE FROM sdr.active_versions WHERE tenant_id=$1 AND brand_id=$2',[identity.tenantId,identity.brandId]);
  assert.deepEqual(await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'}),view);
  await f.db.query("UPDATE sdr.messages SET text='Outra resposta completa' WHERE id='job-1:reply:0'");
  await f.db.query("UPDATE sdr.jobs SET result='{\"bubbles\":[\"Outra resposta completa\"]}' WHERE id='job-1'");
  const result=await f.service.execute(identity,{action:'record',conversationId:f.conversationId,submission:{jobId:'job-1',targetHash:view.data.targetHash,idempotencyKey:randomUUID(),scores:{intentContext:1,commercialFidelity:1,clarityNaturalness:1,nextStepUtility:1},notes:'Revisão vinculada ao texto anterior.'}});
  assert.deepEqual(result,{success:false,error:{code:'TARGET_CHANGED'}});
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='sprint4_human_review_recorded'")).rows.length,0);
 }finally{await f.db.close();}
});

test('the transaction revalidates membership instead of trusting a caller role and never leaks another scope',async()=>{
 const f=await fixture();try{
  const target={action:'target',conversationId:f.conversationId,jobId:'job-1'};
  assert.deepEqual(await f.service.execute({...identity,userId:'not-a-member',role:'admin'},target),{success:false,error:{code:'FORBIDDEN'}});
  assert.deepEqual(await f.service.execute({...identity,brandId:'another-brand'},target),{success:false,error:{code:'FORBIDDEN'}});
  await f.db.query("UPDATE sdr.memberships SET role='tester' WHERE user_id=$1",[identity.userId]);
  for(const action of [target,{action:'history',conversationId:f.conversationId},{action:'record',conversationId:f.conversationId,submission:{jobId:'job-1',targetHash:'a'.repeat(64),idempotencyKey:randomUUID(),scores:{intentContext:1,commercialFidelity:1,clarityNaturalness:1,nextStepUtility:1},notes:'Tentativa sem autoridade.'}}]){
   assert.deepEqual(await f.service.execute({...identity,role:'admin'},action),{success:false,error:{code:'FORBIDDEN'}});
  }
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='sprint4_human_review_recorded'")).rows.length,0);
 }finally{await f.db.close();}
});

test('canonical capability and budget responses are readable without inventing a paid model execution',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE sdr.messages SET id='job-1:capability' WHERE id='job-1:reply:0'");
  await f.db.query("UPDATE sdr.messages SET id='job-2:budget' WHERE id='job-2:reply:0'");
  await f.db.query("UPDATE sdr.jobs SET state='handoff',error_code='LAB_BUDGET_EXHAUSTED' WHERE id='job-2'");
  const result=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-2'});
  assert.ok(result.success,JSON.stringify(result));assert.ok('target' in result.data);
  assert.deepEqual(result.data.target.turns.map(t=>t.responseMessageIds),[['job-1:capability'],['job-2:budget']]);
  assert.deepEqual(result.data.target.turns[1].guardCodes,['LAB_BUDGET_EXHAUSTED']);
  assert.ok(result.data.target.limitations.includes('conversation-prefix-not-campaign-execution-proof'));
 }finally{await f.db.close();}
});

test('pre-turn memory citations must belong to canonical candidate messages in the retained prefix',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE sdr.jobs SET context=jsonb_set(context,'{lead,relations}',$1) WHERE id='job-1'",[JSON.stringify([{id:'relative',name:'Other person',role:'family',evidence:{messageId:'input-2',quote:'Pergunta 2'}}])]);
  assert.deepEqual(await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'}),{success:false,error:{code:'INCOMPLETE_TARGET'}});
 }finally{await f.db.close();}
});

test('the selected job candidate must also match the owning conversation',async()=>{
 const f=await fixture();try{
  const other=await new LabSessions(f.db).create(identity,{requestId:randomUUID(),label:'Other synthetic candidate',scenario:'free'});assert.ok(other.ok);
  await f.db.query("UPDATE sdr.jobs SET candidate_id=$1,context=NULL WHERE id='job-1'",[other.value.candidateId]);
  await f.db.query("UPDATE sdr.messages SET candidate_id=$1 WHERE id IN ('input-1','job-1:reply:0')",[other.value.candidateId]);
  assert.deepEqual(await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'}),{success:false,error:{code:'INCOMPLETE_TARGET'}});
 }finally{await f.db.close();}
});

test('SQL cutoff preserves microsecond order and excludes backdated future-job messages',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE sdr.messages SET created_at='2026-09-14T12:00:01.000000Z' WHERE id IN ('input-2','job-2:reply:0')");
  await f.db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp,created_at) VALUES('later',$1,$2,$3,$4,'system','text','Future unlinked message','2026-09-14T12:00:01.000003Z','2026-09-14T12:00:01.000003Z')",[identity.tenantId,identity.brandId,f.conversationId,f.candidateId]);
  const result=await f.service.execute(identity,{action:'target',conversationId:f.conversationId,jobId:'job-1'});assert.ok(result.success&&'target' in result.data);
  assert.deepEqual(result.data.target.messages.map(m=>m.id),['input-1','job-1:reply:0']);
  assert.deepEqual(result.data.target.messages.map(m=>m.createdAt),['2026-09-14T12:00:01.000001+00:00','2026-09-14T12:00:01.000002+00:00']);
 }finally{await f.db.close();}
});

test('submission rejects missing scores, automatic defaults, actor fields and arbitrary target content before database access',async()=>{
 const db:Database={query:async()=>{throw new Error('No read permitted');},transaction:async()=>{throw new Error('No transaction permitted');},close:async()=>{}};
 const service=new ConversationReview(db),submission={jobId:'job',targetHash:'a'.repeat(64),idempotencyKey:randomUUID(),scores:{intentContext:1,commercialFidelity:1,clarityNaturalness:1,nextStepUtility:1},notes:'Comentário humano.'};
 for(const body of [{...submission,actorUserId:'someone-else'},{...submission,target:{}},{...submission,notes:' '},{...submission,scores:{}},{...submission,scores:{...submission.scores,intentContext:0}},{...submission,scores:{...submission.scores,nextStepUtility:4.5}}]){
  assert.deepEqual(await service.execute(identity,{action:'record',conversationId:'conversation',submission:body}),{success:false,error:{code:'INVALID_INPUT'}});
 }
});
