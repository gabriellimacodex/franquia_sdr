import type { DeterministicCase } from './sprint4-deterministic.spec.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Snapshot } from '../src/versioning.js';
import { snapshotHash } from '../src/versioning.js';
import { testDatabase } from '../tests/db-helper.js';
import { testConfig } from '../tests/config.js';
import { seedPilot } from '../src/seed.js';
import { LabSessions } from '../src/lab-sessions.js';
import { Store } from '../src/store.js';
import { Briefings } from '../src/briefings.js';
import { indexVersionKnowledge } from '../src/knowledge.js';
import { Engine } from '../src/engine.js';
import type { Database } from '../src/database.js';
import { createLeadState, mergeFactProposals, AgentDecisionSchema, type FactProposal, type TrustedMessage } from '../src/domain.js';
import { reconcileMemoryReply } from '../src/memory-reply.js';
import { guardFinancialDecision } from '../src/financial-reply.js';

const config = { ...testConfig, EXECUTION_MODE: 'laboratory' as const, LAB_BUDGET_GATE_ID: 'sprint3-continuous-20260910', LAB_BUDGET_LIMIT_MICRO_USD: 1000000 };
async function fixture(snapshot: Snapshot) {
  const db = await testDatabase();
  try {
    const scope = { tenantId: snapshot.tenant.tenantId, brandId: snapshot.tenant.brandId };
    const legacy = await seedPilot(db, { ...scope, testers: [{ contactId: '5511999999999', label: 'Fictional offline fixture' }] });
    const hash = snapshotHash(snapshot), versionId = 'offline-deterministic-' + hash.slice(0, 12);
    // Ephemeral DB only: fixture setup is not publication, authorization or a recorded validation.
    await db.query('INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$4,$5,$6,$7)', [versionId, scope.tenantId, scope.brandId, 'Offline fixture only', JSON.stringify(snapshot), hash, snapshot.model]);
    assert.ok((await indexVersionKnowledge(db, scope, versionId)).ok);
    await db.query('UPDATE sdr.active_versions SET version_id=$1', [versionId]);
    const user = { ...scope, userId: 'fictional-offline-tester', role: 'tester' };
    const sessions = new LabSessions(db), store = new Store(db);
    const created = await sessions.create(user, { requestId: randomUUID(), label: 'Offline deterministic', scenario: 'free' }); assert.ok(created.ok);
    const counts = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM sdr.messages) messages,
      (SELECT count(*)::int FROM sdr.jobs) jobs,
      (SELECT count(*)::int FROM sdr.facts) facts,
      (SELECT count(*)::int FROM sdr.events) events,
      (SELECT count(*)::int FROM sdr.events WHERE type='lab_model_budget_reserved') reservations,
      (SELECT count(*)::int FROM sdr.deliveries) deliveries,
      (SELECT count(*)::int FROM sdr.briefings) briefings`)).rows[0];
    return { db, sessions, store, user, sessionId: created.value.id, versionId, legacyVersionId: legacy.versionId, counts };
  } catch (error) { await db.close(); throw error; }
}
export const controlCases: DeterministicCase[] = [];

async function stateOf(db: Database) {
  const state: Record<string, unknown[]> = {};
  for (const table of ['candidates', 'conversations', 'messages', 'facts', 'relations', 'jobs', 'events', 'deliveries', 'briefings']) {
    state[table] = (await db.query(`SELECT to_jsonb(t) AS row FROM sdr.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return state;
}

async function dispatch(f: Awaited<ReturnType<typeof fixture>>, text: string, sessionId = f.sessionId) {
  const requestId = randomUUID();
  const sent = await f.sessions.send(f.user, sessionId, { requestId, text }); assert.ok(sent.ok); assert.ok(sent.value.jobId);
  const channel = await f.store.scopeForJob(sent.value.jobId), job = await f.store.claim(channel); assert.ok(job);
  assert.equal(job.id, sent.value.jobId);
  let calls = 0;
  const engine = new Engine(f.store, config, async () => { calls++; return Response.json({ accepted: true }); });
  await engine.dispatch(channel, job); assert.equal(calls, 1);
  const result = { bubbles: ['Obrigado pelo interesse.'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null, financialReply: null };
  const callback = { jobId: job.id, contextVersion: job.context_version, configVersion: job.version_id, model: 'gpt-5.4-2026-03-05', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, result };
  return { sent, requestId, text, channel, job, engine, callback, simulatedDispatchCalls: () => calls };
}

controlCases.push({
  id: 'D30', fixture: 'fresh PGlite per fault: duplicate second reply; injected settlement error after completion event',
  expected: 'Both faults roll back all memory, projections, messages, job and events; the original unsettled reservation remains fully charged.',
  async run(snapshot) {
    const observed = [];
    for (const fault of ['second-bubble', 'settlement'] as const) {
      const f = await fixture(snapshot);
      try {
        const d = await dispatch(f, 'Sou Marina Teste e meu irmão Caio participa da decisão.');
        const evidence = { messageId: d.job.trigger_message_id, quote: d.text };
        const result = { ...d.callback.result, bubbles: ['Entendi, Marina.', 'Em qual cidade pretende abrir?'],
          proposals: [{ field: 'name', value: { kind: 'text', text: 'Marina Teste' }, evidence, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: null }],
          relations: [{ id: 'offline-caio', name: 'Caio', role: 'family', evidence }] };
        const callback = { ...d.callback, result };
        if (fault === 'second-bubble') {
          await f.db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($1,$2,$3,$4,$5,'agent','text','Preexisting offline collision',now())", [d.job.id + ':reply:1', f.user.tenantId, f.user.brandId, d.job.conversation_id, d.job.candidate_id]);
        }
        const before = await stateOf(f.db), countsBefore = await f.counts();
        let completionEventWritten = false, settlementAttempted = false;
        const failing: Database = { ...f.db, transaction: fn => f.db.transaction(tx => fn({ query: async <T>(sql: string, params?: unknown[]) => {
          if (sql.startsWith('UPDATE sdr.events SET detail=detail||')) { settlementAttempted = true; throw new Error('OFFLINE_SETTLEMENT_FAULT'); }
          const rows = await tx.query<T>(sql, params);
          if (sql.startsWith('INSERT INTO sdr.events') && params?.includes('turn_completed')) completionEventWritten = true;
          return rows;
        } })) };
        const engine = fault === 'second-bubble' ? d.engine : new Engine(new Store(failing), config, async () => { assert.fail('No provider during completion'); });
        if (fault === 'second-bubble') await assert.rejects(engine.complete(callback), error => (error as { code?: string }).code === '23505');
        else {
          await assert.rejects(engine.complete(callback), /OFFLINE_SETTLEMENT_FAULT/);
          assert.equal(completionEventWritten, true); assert.equal(settlementAttempted, true);
        }
        const after = await stateOf(f.db); assert.deepEqual(after, before);
        assert.deepEqual(await f.counts(), countsBefore);
        assert.equal(after.facts.length, 0); assert.equal(after.relations.length, 0); assert.equal(after.deliveries.length, 0);
        const reservation = (await f.db.query<{ detail: { settled: boolean; costMicroUsd: number; reservedMicroUsd: number } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
        assert.equal(reservation.length, 1); assert.equal(reservation[0].detail.settled, false);
        assert.equal(reservation[0].detail.costMicroUsd, reservation[0].detail.reservedMicroUsd);
        const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        observed.push({ fault, callback, countsBefore, countsAfter: await f.counts(), beforeStateHash: digest(before), afterStateHash: digest(after), comparedTables: Object.keys(before), reservation, completionEventWritten, settlementAttempted, simulatedDispatchCalls: d.simulatedDispatchCalls() });
      } finally { await f.db.close(); }
    }
    return { input: { faults: ['second-bubble', 'settlement'], fictionalText: 'Sou Marina Teste e meu irmão Caio participa da decisão.' }, observed };
  },
});

controlCases.push({
  id: 'D29', fixture: 'fresh PGlite; two dispatched turns, A becomes stale, B completes; no worker retry simulation',
  expected: 'Stale A and wrong revision B do not mutate; valid B persists once; callback and POST replay do not duplicate message/fact/cost.',
  async run(snapshot) {
    const f = await fixture(snapshot);
    try {
      const a = await dispatch(f, 'Quero abrir em Vila Aurora.');
      const b = await dispatch(f, 'Sou Marina Teste.');
      const proposal: FactProposal = { field: 'name', value: { kind: 'text', text: 'Marina Teste' }, evidence: { messageId: b.job.trigger_message_id, quote: b.text }, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: null };
      const valid = { ...b.callback, result: { ...b.callback.result, proposals: [proposal] } };
      const before = await stateOf(f.db);
      const staleA = await a.engine.complete(a.callback); assert.deepEqual(staleA, { accepted: false, reason: 'STALE_RESULT' });
      const staleRevision = await b.engine.complete({ ...valid, contextVersion: b.job.context_version - 1 }); assert.deepEqual(staleRevision, staleA);
      assert.deepEqual(await stateOf(f.db), before);
      assert.deepEqual(await b.engine.complete(valid), { accepted: true });
      const committed = await stateOf(f.db);
      const replay = await b.engine.complete(valid); assert.deepEqual(replay, staleA);
      const postReplay = await f.sessions.send(f.user, f.sessionId, { requestId: b.requestId, text: b.text }); assert.ok(postReplay.ok);
      assert.equal(postReplay.value.jobId, b.job.id);
      assert.deepEqual(await a.engine.complete(a.callback), staleA);
      assert.deepEqual(await stateOf(f.db), committed);
      const facts = (await f.db.query<{ data: { status: string; confirmedBy: unknown; evidence: unknown } }>('SELECT data FROM sdr.facts')).rows;
      assert.equal(facts.length, 1); assert.equal(facts[0].data.status, 'declared'); assert.equal(facts[0].data.confirmedBy, null); assert.deepEqual(facts[0].data.evidence, proposal.evidence);
      const ledger = (await f.db.query<{ detail: { jobId: string; settled: boolean; costMicroUsd: number; reservedMicroUsd: number } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved' ORDER BY id")).rows;
      assert.equal(ledger.length, 2);
      const staleReservation = ledger.find(row => row.detail.jobId === a.job.id)!.detail;
      const completedReservation = ledger.find(row => row.detail.jobId === b.job.id)!.detail;
      assert.equal(staleReservation.settled, false); assert.equal(staleReservation.costMicroUsd, staleReservation.reservedMicroUsd);
      assert.equal(completedReservation.settled, true); assert.equal(completedReservation.costMicroUsd, 400);
      const detail = await f.sessions.detail(f.user, f.sessionId); assert.ok(detail.ok);
      assert.equal(detail.value.messages.filter(m => m.actor === 'candidate').length, 2);
      assert.deepEqual(detail.value.messages.filter(m => m.actor === 'agent').map(m => m.text), valid.result.bubbles);
      assert.equal((await f.counts()).deliveries, 0); assert.equal(a.simulatedDispatchCalls() + b.simulatedDispatchCalls(), 2);
      return { input: { textA: a.text, textB: b.text, callbackB: valid }, observed: { staleA, staleRevision, replay, postReplayJobId: postReplay.value.jobId, facts, ledger, stateUnchangedOnReplay: true, simulatedDispatchCalls: 2, deliveries: 0 } };
    } finally { await f.db.close(); }
  },
});

controlCases.push({
  id: 'D28', fixture: 'real LabSessions stop/negations in fresh PGlite, plus financial guard followed by memory repair for a stopped conflict',
  expected: 'Negated stop stays automatic; actual stop synchronizes stopped state and blocks SEND. Guard then repair retain stop without proposals or questions.',
  async run(snapshot) {
    const f = await fixture(snapshot);
    const input = ['Não quero parar, pode continuar.', 'Não pare, pode continuar.', 'Pare de me enviar mensagens.'];
    try {
      const observations = [];
      for (const text of input) {
        const sent = await f.sessions.send(f.user, f.sessionId, { requestId: randomUUID(), text }); assert.ok(sent.ok);
        const detail = await f.sessions.detail(f.user, f.sessionId); assert.ok(detail.ok);
        const expected = text === input[2] ? 'stopped' : 'automatic';
        assert.equal(detail.value.session.state, expected);
        observations.push({ text, state: detail.value.session.state, bubbles: detail.value.messages.filter(m => m.actor === 'agent').map(m => m.text) });
      }
      assert.ok(observations[2].bubbles.every(text => !String(text).includes('?')));
      const states = (await f.db.query<{ state: string; status: string }>("SELECT c.state,p.lead_state->>'status' status FROM sdr.conversations c JOIN sdr.candidates p ON p.id=c.candidate_id")).rows;
      assert.deepEqual(states, [{ state: 'stopped', status: 'stopped' }]);
      const counts = await f.counts(); assert.equal(counts.reservations, 0); assert.equal(counts.deliveries, 0);
      const blocked = await f.sessions.send(f.user, f.sessionId, { requestId: randomUUID(), text: 'Continuar' });
      assert.ok(!blocked.ok); assert.equal(blocked.error.code, 'SESSION_PAUSED'); assert.deepEqual(await f.counts(), counts);
      const original: TrustedMessage = { id: 'stop-city-original', tenantId: f.user.tenantId, brandId: f.user.brandId, leadId: 'stop-memory', role: 'user', text: 'Quero abrir em Vila Aurora.' };
      const proposal: FactProposal = { field: 'city', value: { kind: 'text', text: 'Vila Aurora' }, evidence: { messageId: original.id, quote: original.text }, attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: null };
      const before = mergeFactProposals(createLeadState(original.tenantId, original.brandId, original.leadId), [proposal], [original]);
      const correction = { ...original, id: 'stop-city-correction', text: 'Corrigindo: a cidade é Vila Horizonte.' };
      const proposed = { ...proposal, value: { kind: 'text' as const, text: 'Vila Horizonte' }, evidence: { messageId: correction.id, quote: correction.text }, replacesFactId: before.facts[0].id };
      const after = mergeFactProposals(before, [proposed], [correction]);
      const decision = AgentDecisionSchema.parse({ bubbles: ['Vou considerar Vila Horizonte.', 'O atendimento automático será interrompido.'], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'stop', handoffReason: 'opt_out' });
      const untouched = structuredClone({ before, after, decision });
      const stopMessage = { ...correction, id: 'stop-control', text: input[2] };
      const guard = guardFinancialDecision({ decision: { ...decision, financialReply: null }, tenant: snapshot.tenant, lead: after,
        sources: snapshot.sources, now: '2026-09-13T12:00:00.000Z', trustedMessages: [original, correction, stopMessage], latestMessageId: stopMessage.id, latestMessage: stopMessage.text });
      assert.ok(guard.ok, JSON.stringify(guard));
      const repaired = reconcileMemoryReply(guard.decision, after, after);
      assert.equal(repaired.nextAction, 'stop'); assert.equal(repaired.handoffReason, 'opt_out');
      assert.doesNotMatch(repaired.bubbles.join(' '), /Vou considerar|\?/);
      assert.match(repaired.bubbles[0], /registrada para revisão/);
      assert.equal(repaired.bubbles[1], guard.decision.bubbles[1]);
      assert.deepEqual({ ...repaired, bubbles: guard.decision.bubbles }, guard.decision); assert.ok(AgentDecisionSchema.safeParse(repaired).success);
      assert.deepEqual({ before, after, decision }, untouched); assert.deepEqual(repaired.proposals, []); assert.deepEqual(repaired.relations, []); assert.equal(repaired.referral, null);
      return { input: { messages: input, memory: untouched, stopMessage }, observed: { observations, states, counts, blocked, guardPassed: guard.ok, guard, repaired } };
    } finally { await f.db.close(); }
  },
});

controlCases.push({
  id: 'D10', fixture: 'fresh real PGlite v2 fixture plus its legacy v1 seed; transport is simulated',
  expected: 'Reject wrong model/config/contract without mutation, then accept only each job’s pinned contract independently of active version.',
  async run(snapshot) {
    const f = await fixture(snapshot), observed = [];
    try {
      for (const v2 of [true, false]) {
        if (!v2) await f.db.query('UPDATE sdr.active_versions SET version_id=$1', [f.legacyVersionId]);
        const created = await f.sessions.create(f.user, { requestId: randomUUID(), label: 'Contract compatibility', scenario: 'free' }); assert.ok(created.ok);
        const d = await dispatch(f, 'Quero conhecer a franquia.', created.value.id);
        const { financialReply: _financial, ...legacy } = d.callback.result;
        const valid = { ...d.callback, result: v2 ? d.callback.result : legacy };
        await f.db.query('UPDATE sdr.active_versions SET version_id=$1', [v2 ? f.legacyVersionId : f.versionId]);
        const before = await stateOf(f.db), rejections = [];
        for (const [change, code] of [
          [{ model: 'unauthorized-model' }, 'MODEL_MISMATCH'],
          [{ configVersion: 'forged-config' }, 'VERSION_MISMATCH'],
          [{ result: v2 ? legacy : d.callback.result }, 'OUTPUT_CONTRACT_MISMATCH'],
        ] as const) {
          await assert.rejects(d.engine.complete({ ...valid, ...change }), new RegExp(code));
          assert.deepEqual(await stateOf(f.db), before);
          rejections.push({ change, code, stateUnchanged: true });
        }
        const accepted = await d.engine.complete(valid); assert.deepEqual(accepted, { accepted: true });
        const detail = await f.sessions.detail(f.user, created.value.id); assert.ok(detail.ok);
        assert.equal(detail.value.session.versionId, v2 ? f.versionId : f.legacyVersionId);
        assert.deepEqual(detail.value.messages.filter(m => m.actor === 'agent').map(m => m.text), valid.result.bubbles);
        observed.push({ contract: v2 ? 'financial-v2' : 'legacy-v1', jobId: d.job.id, versionId: d.job.version_id, rejections, accepted, simulatedDispatchCalls: d.simulatedDispatchCalls() });
      }
      assert.equal((await f.counts()).facts, 0); assert.equal((await f.counts()).deliveries, 0);
      return { input: { candidateHash: snapshotHash(snapshot), mutations: ['model', 'configVersion', 'contract'], fixtureLegacyVersion: f.legacyVersionId }, observed };
    } finally { await f.db.close(); }
  },
});

controlCases.push({
  id: 'D27', fixture: 'real LabSessions/Briefings; fresh PGlite; pending turn then human request',
  expected: 'Human pause synchronizes state, stales pending work and rejects continuation without provider, reservation or delivery.',
  async run(snapshot) {
    const f = await fixture(snapshot);
    const input = ['Quero conhecer a franquia.', 'Quero falar com um humano', 'Outra pergunta'];
    try {
      const pending = await f.sessions.send(f.user, f.sessionId, { requestId: randomUUID(), text: input[0] }); assert.ok(pending.ok);
      const paused = await f.sessions.send(f.user, f.sessionId, { requestId: randomUUID(), text: input[1] }); assert.ok(paused.ok);
      const detail = await f.sessions.detail(f.user, f.sessionId); assert.ok(detail.ok); assert.equal(detail.value.session.state, 'human');
      const state = (await f.db.query<{ state: string; status: string }>("SELECT c.state,p.lead_state->>'status' status FROM sdr.conversations c JOIN sdr.candidates p ON p.id=c.candidate_id")).rows[0];
      assert.deepEqual(state, { state: 'human', status: 'handoff' });
      const jobs = (await f.db.query<{ state: string }>('SELECT state FROM sdr.jobs')).rows;
      assert.ok(jobs.length > 0); assert.ok(jobs.every(job => job.state === 'stale'));
      const briefings = (await f.db.query<{ assignment_status: string; version_id: string }>('SELECT assignment_status,version_id FROM sdr.briefings')).rows;
      assert.equal(briefings.length, 1); assert.equal(briefings[0].assignment_status, 'not_applicable'); assert.equal(briefings[0].version_id, f.versionId);
      let calls = 0;
      const briefs = new Briefings(f.store, config, async () => { calls++; assert.fail('No external briefing allowed'); });
      await briefs.dispatch(await f.store.scopeForJob(pending.value.jobId!));
      await briefs.dispatch(await f.store.channel('1052683654599692'));
      const before = await f.counts();
      const blocked = await f.sessions.send(f.user, f.sessionId, { requestId: randomUUID(), text: input[2] });
      assert.ok(!blocked.ok); assert.equal(blocked.error.code, 'SESSION_PAUSED');
      const after = await f.counts(); assert.deepEqual(after, before);
      assert.equal(after.reservations, 0); assert.equal(after.deliveries, 0); assert.equal(calls, 0);
      return { input, observed: { state, jobs, briefings, before, after, blocked, providerCalls: calls } };
    } finally { await f.db.close(); }
  },
});
