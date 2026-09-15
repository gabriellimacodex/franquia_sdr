import test from 'node:test';
import assert from 'node:assert/strict';
import { sprint2AcceptanceScenarios } from '../evaluations/sprint-02-acceptance.js';

test('Sprint 2 acceptance matrix has 15 fictional no-send scenarios and every required failure boundary',()=>{
 assert.equal(sprint2AcceptanceScenarios.length,15);
 assert.equal(new Set(sprint2AcceptanceScenarios.map(item=>item.id)).size,15);
 assert.ok(sprint2AcceptanceScenarios.every(item=>item.fictional&&item.externalSendAllowed===false&&item.expected.length>0));
 const tags=new Set(sprint2AcceptanceScenarios.flatMap(item=>item.tags));
 for(const required of ['duplicate-request','cross-tester','cross-organization','invalid-model-response','n8n-timeout','post-handoff-block','human-pause'])assert.ok(tags.has(required),required);
});

test('Sprint 2 acceptance matrix follows the 15 numbered scenarios in the approved order',()=>{
 assert.deepEqual(sprint2AcceptanceScenarios.map(item=>item.tags[0]),[
  'first-contact','interest-city','investment-below','investment-within','territory-question',
  'unknown-investment-composition','correction','partner-participation','human-pause',
  'post-handoff-block','duplicate-request','cross-tester','cross-organization',
  'invalid-model-response','n8n-timeout',
 ]);
});
