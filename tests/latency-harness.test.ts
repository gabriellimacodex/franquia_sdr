import test from 'node:test';
import assert from 'node:assert/strict';
import { runLatencyScenario } from '../evaluations/latency-harness.js';

test('offline harness exercises authenticated send, asynchronous model callback, atomic completion and committed detail',async()=>{
 const sample=await runLatencyScenario({rttMs:0,providerMs:40,workerIntervalMs:5,pollIntervalMs:5,pollFloorMs:1});
 assert.equal(sample.kind,'offline-simulation');
 assert.equal(sample.endpoint,'authenticated-committed-detail-not-render');
 assert.equal(sample.providerCalls,1);
 assert.equal(sample.authCalls,sample.polls+1,'one real authentication path per send and detail, all transported offline');
 assert.deepEqual(sample.invariants,{guardPassed:true,settled:true,facts:1,relations:1,deliveries:0});
 assert.ok(sample.callbackCommittedMs<=sample.observedDetailMs,'only committed, validated output is observed');
 assert.ok(sample.database.queries>0&&sample.database.transactions>0);
 assert.ok(sample.database.wireExchanges>=sample.database.queries+sample.database.transactions*2);
 const model=sample.spans.find(span=>span.name==='model')!;
 assert.ok(model&&model.endMs-model.startMs>=35);
 assert.ok(sample.spans.some(span=>span.name==='dispatch'&&span.startMs<model.startMs&&span.endMs>model.startMs),'dispatch ACK and model interval overlap');
 assert.ok(sample.spans.some(span=>span.name==='send')&&sample.spans.some(span=>span.name==='detail'));
 for(const forbidden of ['Marina','Caio','Bearer','contentHash','prompt','jobId','candidateId'])assert.equal(JSON.stringify(sample).includes(forbidden),false,forbidden);
});

test('invalid artificial delays are rejected instead of silently producing misleading timing results',async()=>{
 await assert.rejects(runLatencyScenario({rttMs:-1,providerMs:1,workerIntervalMs:1,pollIntervalMs:1,pollFloorMs:1}),/Invalid latency option: rttMs/);
});
