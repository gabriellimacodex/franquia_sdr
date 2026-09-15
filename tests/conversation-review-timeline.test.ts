import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {testDatabase} from './db-helper.js';
import {seedPilot} from '../src/seed.js';
import {LabSessions} from '../src/lab-sessions.js';
import {Lab} from '../src/lab.js';

test('the ordinary conversation timeline summarizes reviews without loading their archived transcript',async()=>{
 const db=await testDatabase();
 const identity={tenantId:'cognita-homologacao',brandId:'sapore',userId:'synthetic-reviewer',role:'reviewer'};
 try {
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Synthetic'}]});
  const created=await new LabSessions(db).create(identity,{requestId:randomUUID(),label:'Review timeline fixture',scenario:'free'});
  assert.ok(created.ok);
  for(const [id,type,detail] of [
   ['review','sprint4_human_review_recorded',{target:{messages:[{text:'ARCHIVED_REVIEW_TRANSCRIPT'.repeat(4000)}]}}],
   ['control','handoff',{reason:'human_request'}],
  ] as const)await db.query('INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail) VALUES($1,$2,$3,$4,$5,$6)',[id,identity.tenantId,identity.brandId,created.value.id,type,JSON.stringify(detail)]);
  const detail=await new Lab(db).detail(identity,created.value.id);
  assert.equal(JSON.stringify(detail).includes('ARCHIVED_REVIEW_TRANSCRIPT'),false);
  const events=detail.events as {id:string,description:string}[];
  assert.equal(events.find(e=>e.id==='review')?.description,'Avaliação humana registrada. Consulte a aba Avaliar para ver as notas e o conteúdo avaliado.');
  assert.deepEqual(JSON.parse(events.find(e=>e.id==='control')!.description),{reason:'human_request'});
  assert.equal((await db.query<{detail:{target:unknown}}>("SELECT detail FROM sdr.events WHERE id='review'")).rows[0].detail.target!==undefined,true);
 } finally {await db.close();}
});
