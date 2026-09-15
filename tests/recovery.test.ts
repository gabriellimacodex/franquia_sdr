import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabase } from './db-helper.js';
import { seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { TurnInputSchema } from '../src/contracts.js';

test('database restart preserves identity/history/pending work and recovers an expired processing lease',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sapore-sdr-recovery-'));
 let db=await testDatabase(join(directory,'postgres'));
 try{
  await seedPilot(db,{testers:[{contactId:'5511999999999',label:'Fictional tester'}]});
  const store=new Store(db);
  const input=TurnInputSchema.parse({phoneNumberId:'1052683654599692',conversationId:'c1',contactId:'5511999999999',messageId:'m1',text:'Quero conhecer a franquia',executionId:'e1',controlFingerprint:'e1:initial'});
  const turn=await store.startTurn(input);
  await db.query("UPDATE sdr.jobs SET state='working',lease_until=now()-interval '1 second',available_at=now()");
  await db.close();
  db=await testDatabase(join(directory,'postgres'));
  const restored=new Store(db),channel=await restored.channel(input.phoneNumberId);
  assert.equal((await restored.startTurn(input)).id,turn.id);
  assert.equal((await restored.claim(channel))?.id,turn.id);
  assert.equal((await db.query('SELECT * FROM sdr.messages')).rows.length,1);
  await restored.startTurn({...input,conversationId:'c2',messageId:'m2',text:'Voltei hoje'});
  assert.equal((await db.query('SELECT * FROM sdr.candidates')).rows.length,1);
  assert.equal((await db.query('SELECT * FROM sdr.conversations')).rows.length,2);
 }finally{await db.close();await rm(directory,{recursive:true,force:true});}
});
