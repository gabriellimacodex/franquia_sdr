import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryCases } from '../evaluations/sprint4-deterministic-memory.js';
import { initialSnapshot } from '../src/seed.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { guardFinancialDecision } from '../src/financial-reply.js';
import type { AgentDecision, LeadState, TrustedMessage } from '../src/domain.js';
import type { Snapshot } from '../src/versioning.js';

const snapshot: Snapshot = createFinancialDraftSnapshot(initialSnapshot({ tenantId: 'cognita-homologacao', brandId: 'sapore' }));
type Trace = { original: LeadState; before: LeadState; after: LeadState; results: { reply: AgentDecision; result: AgentDecision; omitted: string[] }[] };

test('D22 repairs adoption of the disputed city using fresh scoped memory and preserves controls', async () => {
 const item = memoryCases.find(item => item.id === 'D22');
 assert.ok(item, 'D22 must exist in the deterministic memory catalog');
 const unchanged = structuredClone(snapshot);
 const first = await item.run(snapshot), second = await item.run(snapshot);
 assert.deepEqual(first, second);
 const observed = first.observed as Trace, repeated = second.observed as Trace;
 assert.notEqual(observed.before, repeated.before, 'each run must construct independent memory');
 assert.equal(observed.after.tenantId, snapshot.tenant.tenantId);
 assert.equal(observed.after.brandId, snapshot.tenant.brandId);
 assert.equal(observed.after.facts.at(-1)?.status, 'conflict');
 assert.deepEqual(observed.results.map(row => row.result.nextAction), ['continue', 'nurture', 'handoff', 'stop']);
 for (const row of observed.results) {
  assert.doesNotMatch(row.result.bubbles.join(' '), /vou considerar Vila Horizonte/i);
  assert.match(row.result.bubbles.join(' '), /Você, Marina, administra a loja; Caio participa da decisão\./);
 }
 assert.deepEqual(snapshot, unchanged);
});

test('D22 stop reaches the real financial guard without collection and retains its control after repair', async () => {
 const item = memoryCases.find(item => item.id === 'D22');assert.ok(item);
 const observation = await item.run(snapshot), observed = observation.observed as Trace;
 const input = observation.input as { profile: TrustedMessage; correction: TrustedMessage };
 const correctionAt = input.correction.createdAt;assert.ok(correctionAt);
 const row = observed.results.find(row => row.reply.nextAction === 'stop');assert.ok(row);
 const check = (decision: AgentDecision) => guardFinancialDecision({ decision: { ...decision, financialReply: null },
  tenant: snapshot.tenant, lead: observed.before, sources: snapshot.sources, now: correctionAt,
  trustedMessages: [input.profile, input.correction], conversationId: input.correction.conversationId,
  latestMessageId: input.correction.id, latestMessage: input.correction.text });
 assert.equal(check(row.reply).ok, true, 'stop fixture must pass the real pre-repair guard');
 assert.equal(check(row.result).ok, true, 'repaired stop must remain guard-valid');
 assert.deepEqual(row.reply.proposals, []);assert.deepEqual(row.reply.relations, []);
 assert.deepEqual({ ...row.result, bubbles: row.reply.bubbles }, row.reply);
 assert.equal(row.result.nextAction, 'stop');assert.equal(row.result.handoffReason, 'opt_out');
 assert.doesNotMatch(row.result.bubbles.join(' '), /vou considerar|\?/i);
 assert.match(row.result.bubbles.join(' '), /registrada para revisão/);
 assert.equal(observed.after.facts.length, 6);assert.equal(observed.after.relations.length, 1);
});

test('D23 preserves an honest negation without laundering the following positive adoption', async () => {
 const item = memoryCases.find(item => item.id === 'D23');
 assert.ok(item, 'D23 must exist in the deterministic memory catalog');
 const observed = (await item.run(snapshot)).observed as Trace;
 assert.deepEqual(observed.before, observed.after, 'an existing conflict remains unresolved');
 for (const row of observed.results) {
  assert.match(row.result.bubbles.join(' '), /Não vou considerar Vila Horizonte como cidade vigente antes da revisão\./);
  assert.ok(!row.result.bubbles.join(' ').includes(' Vou considerar Vila Horizonte.'));
  assert.match(row.result.bubbles.join(' '), /Caio participa da decisão\./);
 }
});

test('D24 preserves complete human approval conditions before and after adoption without confirming memory', async () => {
 const item = memoryCases.find(item => item.id === 'D24');
 assert.ok(item, 'D24 must exist in the deterministic memory catalog');
 const observed = (await item.run(snapshot)).observed as Trace;
 assert.equal(observed.results.length, 2);
 assert.match(observed.results[0].reply.bubbles[0], /^Se a equipe aprovar a correção,/);
 assert.match(observed.results[1].reply.bubbles[0], /somente se a equipe aprovar a correção\./);
 for (const row of observed.results) assert.deepEqual(row.result, row.reply);
 assert.equal(observed.after.facts.filter(fact => fact.status === 'confirmed').length, 0);
 assert.equal(observed.after.facts.at(-1)?.status, 'conflict');
});

test('D25 does not let a conditional preface exempt a contradictory immediate adoption', async () => {
 const item = memoryCases.find(item => item.id === 'D25');
 assert.ok(item, 'D25 must exist in the deterministic memory catalog');
 const observed = (await item.run(snapshot)).observed as Trace;
 const row = observed.results[0];
 assert.match(row.reply.bubbles[0], /Se a equipe aprovar a correção/);
 assert.match(row.reply.bubbles[0], /nossa referência a partir de agora/);
 assert.doesNotMatch(row.result.bubbles.join(' '), /nossa referência a partir de agora/);
 assert.match(row.result.bubbles.join(' '), /registrada para revisão/);
 assert.match(row.result.bubbles.join(' '), /Você, Marina, administra a loja; Caio participa da decisão\./);
 assert.deepEqual(observed.before, observed.after);
});

test('D26 preserves the complete numerical negation within two bounded bubbles and records whole omission', async () => {
 const item = memoryCases.find(item => item.id === 'D26');
 assert.ok(item, 'D26 must exist in the deterministic memory catalog');
 const observed = (await item.run(snapshot)).observed as Trace;
 assert.equal(observed.results.length, 2);
 const [fits, overflow] = observed.results;
 for (const row of observed.results) {
  assert.equal(row.result.bubbles.length, 2);
  assert.ok(row.result.bubbles.every(bubble => bubble.length <= 600));
  assert.ok(row.result.bubbles[1].startsWith('Não alterei o capital declarado de R$ 260.000,50.'));
  assert.ok(row.result.bubbles[1].includes('Você, Marina, administra a loja; Caio participa da decisão.'));
  assert.doesNotMatch(row.result.bubbles.join(' '), /Vou considerar Vila Horizonte/);
 }
 assert.deepEqual(fits.omitted, []);
 assert.ok(fits.result.bubbles[1].endsWith(fits.reply.bubbles[1]));
 assert.deepEqual(overflow.omitted, [overflow.reply.bubbles[1]]);
 assert.ok(!overflow.result.bubbles.join(' ').includes(overflow.reply.bubbles[1]));
 assert.equal(overflow.result.bubbles[1], overflow.reply.bubbles[0].replace('Vou considerar Vila Horizonte. ', ''));
});
