import { testDatabase } from './db-helper.js';
import { Store } from '../src/store.js';
import { TurnInputSchema } from '../src/contracts.js';
import { initialSnapshot } from '../src/seed.js';

export async function setup() {
 const db=await testDatabase(); const store=new Store(db);
 await db.query("INSERT INTO sdr.brands VALUES ('team','sapore','Sapore')");
 await db.query("INSERT INTO sdr.channels VALUES ('1052683654599692','team','sapore',false,'operator-test')");
 await db.query("INSERT INTO sdr.testers VALUES ('team','sapore','allowed','Tester',true)");
 await db.query("INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES ('v1','team','sapore','v1',$1,'v1hash','gpt-5.4-2026-03-05')",[JSON.stringify(initialSnapshot({tenantId:'team',brandId:'sapore'}))]);
 await db.query("INSERT INTO sdr.active_versions VALUES ('team','sapore','v1')");
 return {db,store};
}
export const input=(messageId='m1',text='Gostaria de conhecer a franquia')=>TurnInputSchema.parse({phoneNumberId:'1052683654599692',contactId:'allowed',conversationId:'c1',messageId,text,executionId:'execution-1',controlFingerprint:'epoch-1'});
