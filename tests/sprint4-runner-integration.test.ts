import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { initialSnapshot, seedPilot } from '../src/seed.js';
import { Versioning } from '../src/versioning.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { ConversationReviewRecordSchema } from '../src/conversation-review.spec.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { Sprint4Journal } from '../evaluations/sprint4-journal.js';
import { Sprint4BootstrapStorage } from '../evaluations/sprint4-bootstrap-storage.js';
import { Sprint4Bootstrap } from '../evaluations/sprint4-bootstrap.js';
import { Sprint4Http } from '../evaluations/sprint4-http.js';
import { Sprint4Controller } from '../evaluations/sprint4-controller.js';
import { ControllerStateSchema, type AdmissionEvidence } from '../evaluations/sprint4-controller.spec.js';
import { Sprint4TerminalAudit } from '../evaluations/sprint4-terminal-audit.js';
import { Sprint4EvidenceStorage } from '../evaluations/sprint4-evidence-storage.js';
import { Sprint4EvidenceCapture } from '../evaluations/sprint4-evidence.js';
import { terminalEvidenceHash, type TerminalArtifact } from '../evaluations/sprint4-evidence.spec.js';
import { Sprint4ReviewPacket } from '../evaluations/sprint4-review-packet.js';
import { Sprint4ReviewedReceipt } from '../evaluations/sprint4-reviewed-receipt.js';
import { CriteriaArtifactSchema, type CriteriaArtifact, type CriterionEvidenceBinding } from '../evaluations/sprint4-reviewed-receipt.spec.js';
import { Sprint4Runner } from '../evaluations/sprint4-runner.js';
import { testConfig } from './config.js';

const scope = { tenantId: 'cognita-homologacao', brandId: 'sapore' } as const;
const credential = { actorUserId: 'synthetic-runner-admin', accessToken: 'synthetic-runner-token' };
const origin = 'https://sdr-api.cognitaai.com.br';
const syntheticNotice = 'SYNTHETIC LOCAL INTEGRATION ONLY: no paid campaign, real human judgment or commercial acceptance.';

// The API routes, SQL transactions, services and three private SQLite stores are real.
// Auth, operational attestations, model callback and all adjudications are explicitly synthetic.
// Every transport is injected: this test never opens a socket or calls a remote service.
async function fixture(t: TestContext) {
 const directory = await mkdtemp(join(tmpdir(), 'sprint4-runner-integration-'));
 const paths = Object.fromEntries(['journal', 'bootstrap', 'evidence'].map(name => [name, join(directory, name)]));
 await Promise.all(Object.values(paths).map(path => mkdir(path, { mode: 0o700 })));
 const pg = new PGlite({ extensions: { vector } });
 const db: Database = { query: (sql, params) => pg.query(sql, params), transaction: fn => pg.transaction(tx => fn(tx as Queryable)), close: () => pg.close() };
 let app: Awaited<ReturnType<typeof createServer>> | undefined;
 let journal!: Sprint4Journal, bootstrapStorage!: Sprint4BootstrapStorage, archive!: Sprint4EvidenceStorage;
 const closeStores = async () => { for (const store of [journal, bootstrapStorage, archive]) if (store) assert.ok((await store.execute({ action: 'close' })).success); };
 t.after(async () => { await app?.close(); await closeStores(); await db.close(); await rm(directory, { recursive: true, force: true }); });
 for (const migration of ['001_sdr.sql', '002_versions.sql', '003_lab_sessions.sql', '004_candidate_reset.sql']) await pg.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
 await seedPilot(db, { testers: [{ contactId: '5511999999999', label: syntheticNotice }], adminUserIds: [credential.actorUserId] });
 const draft = await new Versioning(db).saveDraft(scope, createFinancialDraftSnapshot(initialSnapshot(scope)), credential.actorUserId);
 assert.ok(draft.ok);
 const planned = new Sprint4CampaignPlanner().execute({ runId: 'synthetic-runner-integration', actorUserId: credential.actorUserId,
  target: { versionId: draft.value.versionId, contentHash: draft.value.contentHash, model: 'gpt-5.4-2026-03-05' } });
 assert.ok(planned.success);
 const plan = planned.data, execution = plan.phases[0].executions[0], [t1, t2] = execution.turns;
 assert.equal(execution.caseId, 'C01');
 const config = { ...testConfig, EXECUTION_MODE: 'laboratory' as const, LAB_BUDGET_GATE_ID: 'sprint3-continuous-20260910', LAB_BUDGET_LIMIT_MICRO_USD: 1_000_000 };
 app = await createServer(db, config, { transport: async (url, init) => {
  assert.equal(url, config.SUPABASE_URL + '/auth/v1/user');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + credential.accessToken);
  return Response.json({ id: credential.actorUserId });
 } });
 const requests: { method: string; path: string }[] = [];
 const transport: typeof fetch = async (url, init) => {
  const parsed = new URL(String(url)), method = init?.method ?? 'GET', headers = new Headers(init?.headers);
  assert.equal(parsed.origin, origin); assert.equal(parsed.search, ''); assert.equal(parsed.hash, '');
  assert.ok(method === 'GET' || method === 'POST');
  assert.equal(headers.get('authorization'), 'Bearer ' + credential.accessToken);
  assert.equal(headers.get('x-tenant-id'), scope.tenantId); assert.equal(headers.get('x-brand-id'), scope.brandId);
  requests.push({ method, path: parsed.pathname });
  const injectedHeaders: Record<string, string> = {}; headers.forEach((value, name) => { injectedHeaders[name] = value; });
  const response = await app!.inject({ method, url: parsed.pathname, headers: injectedHeaders,
   ...(init?.body === undefined ? {} : { payload: String(init.body) }) });
  return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
 };
 const api = async (path: string, body?: unknown) => {
  const response = await transport(origin + path, { method: body === undefined ? 'GET' : 'POST',
   headers: { authorization: 'Bearer ' + credential.accessToken, 'x-tenant-id': scope.tenantId, 'x-brand-id': scope.brandId, 'content-type': 'application/json' },
   ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value: unknown = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
 };
 const criteriaArchive = new Map<string, CriteriaArtifact>();
 const proofs = new Map<string, { kind: string; notice: string; binding: CriterionEvidenceBinding }>();
 let sessionId = '', audits = 0, syntheticModelPosts = 0;
 const open = (initializeNew = false) => {
  journal = new Sprint4Journal({ directory: paths.journal, initializeNew });
  bootstrapStorage = new Sprint4BootstrapStorage({ directory: paths.bootstrap, initializeNew });
  archive = new Sprint4EvidenceStorage({ directory: paths.evidence, initializeNew });
  const campaignJournal = journal.asCampaignJournal();
  const controller = new Sprint4Controller(campaignJournal, { nowMs: Date.now, async inspect({ turnId, expectedSessionId }) {
   const stored = await bootstrapStorage.execute({ action: 'read', runId: plan.request.runId, executionId: execution.id });
   assert.ok(stored.success); assert.equal(stored.data.kind, 'read');
   assert.ok(stored.data.kind === 'read' && stored.data.record?.observation);
   sessionId = stored.data.record.observation.session.id;
   if (expectedSessionId !== null) assert.equal(sessionId, expectedSessionId);
   const session = (await db.query<{ owner_user_id: string }>('SELECT owner_user_id FROM sdr.lab_sessions WHERE id=$1', [sessionId])).rows[0];
   const localJobs = (await db.query<{ state: string }>('SELECT state FROM sdr.jobs WHERE conversation_id=$1', [sessionId])).rows;
   const ledger = (await db.query<{ cost: number }>("SELECT COALESCE(sum((detail->>'costMicroUsd')::int),0)::int AS cost FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows[0];
   const now = Date.now();
   // Route/health/operational budget attestations below are synthetic, never live admission proof.
   const evidence: AdmissionEvidence = { turnId, actorUserId: credential.actorUserId, target: plan.request.target,
    evidenceRef: 'synthetic-runner-readiness', observedAtMs: now, validUntilMs: now + 60000,
    adminActive: true, routeValidated: true, published: false, healthy: true, noUnexpectedJobs: localJobs.every(job => job.state === 'completed'), ...scope,
    executionMode: 'laboratory', channelEnabled: false, nativeControlVerified: false, retentionEnabled: false,
    sessionId, sessionOwned: session.owner_user_id === credential.actorUserId, sessionReady: true, sessionFresh: localJobs.length === 0, requestId: randomUUID(),
    budget: { gateId: 'sprint3-continuous-20260910', limitMicroUsd: 1_000_000, accountedMicroUsd: ledger.cost, maxReservationMicroUsd: 200000, remainingCampaignReviewed: true },
    daily: { actorUserId: credential.actorUserId, limitMessages: 100, rollingWindowHours: 24, usedMessages: localJobs.length, stageAndControlsReviewed: true } };
   return evidence;
  } });
  const http = new Sprint4Http(credential, transport, { controller });
  const bootstrap = new Sprint4Bootstrap({ storage: bootstrapStorage, http });
  const capture = new Sprint4EvidenceCapture({ journal: campaignJournal, storage: archive, audit: { execute: raw => db.transaction(async tx => {
   audits++; await tx.query('SET TRANSACTION READ ONLY');
   await tx.query("SELECT set_config('sdr.tenant_id',$1,true),set_config('sdr.brand_id',$2,true)", [scope.tenantId, scope.brandId]);
   return new Sprint4TerminalAudit(tx, campaignJournal).execute(raw);
  }) } });
  const review = new Sprint4ReviewedReceipt({ storage: archive, reviews: { read: async id => {
   const history = await api('/v1/conversations/' + sessionId + '/reviews') as { reviews: unknown[] };
   return history.reviews.map(value => ConversationReviewRecordSchema.parse(value)).find(record => record.id === id) ?? null;
  } }, criteria: { read: async ref => structuredClone(criteriaArchive.get(ref) ?? null), verifyEvidence: async request => {
   const proof = proofs.get(request.ref);
   return !!proof && request.ref === 'proof-sha256:' + request.sha256 && terminalEvidenceHash(proof) === request.sha256 && isDeepStrictEqual(proof.binding, request.binding);
  } } });
  return { runner: new Sprint4Runner({ journal: campaignJournal, bootstrap, http, controller, capture, review }), capture, review };
 };
 const state = async () => ControllerStateSchema.parse(await journal.asCampaignJournal().read(plan.request.runId));
 const readArtifact = async (turnId: string): Promise<TerminalArtifact> => {
  const read = await archive.execute({ action: 'read', runId: plan.request.runId, turnId });
  assert.ok(read.success); assert.ok(read.data.kind === 'read' && read.data.artifact); return read.data.artifact;
 };
 const completeSyntheticJob = async (turn: typeof t1) => {
  const store = new Store(db), row = (await db.query<{ id: string }>('SELECT id FROM sdr.jobs WHERE trigger_message_id=$1', [sessionId + ':' + (await state()).entries.at(-1)!.admission.requestId])).rows[0];
  const channel = await store.scopeForJob(row.id), job = await store.claim(channel); assert.ok(job); assert.equal(job.id, row.id); assert.equal(job.attempts, 1);
  await new Engine(store, config, async (url, init) => {
   assert.equal(url, config.N8N_WEBHOOK_URL); assert.equal(init?.method, 'POST');
   const payload = JSON.parse(String(init?.body)); assert.equal(payload.jobId, job.id); assert.equal(payload.configVersion, plan.request.target.versionId);
   assert.equal(payload.model, plan.request.target.model); syntheticModelPosts++; return Response.json({ accepted: true });
  }).dispatch(channel, job);
  const result = { bubbles: ['Você vai administrar a loja, e Caio participa da decisão.', 'O que motivou seu interesse na franquia?'],
   proposals: turn.id === t1.id ? [{ field: 'city', value: { kind: 'text', text: 'Vila Aurora' }, evidence: { messageId: job.trigger_message_id, quote: turn.input },
    attribution: 'candidate', capitalOrigin: null, relationId: null, replacesFactId: null }] : [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null, financialReply: null };
  const callback = await app!.inject({ method: 'POST', url: '/internal/n8n/jobs/' + job.id + '/complete',
   headers: { authorization: 'Bearer ' + config.N8N_CALLBACK_TOKEN }, payload: { jobId: job.id, contextVersion: job.context_version,
    configVersion: job.version_id, model: plan.request.target.model, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, result } });
  assert.equal(callback.statusCode, 200, callback.body); assert.deepEqual(callback.json(), { accepted: true }); return job.id;
 };
 const messagePosts = () => requests.filter(r => r.method === 'POST' && r.path.endsWith('/messages')).length;
 const adjudicate = async (jobId: string, failedCriterion?: 'O2') => {
  const firstArtifact = await readArtifact(t1.id);
  const target = await api('/v1/conversations/' + sessionId + '/review-target/' + jobId) as { targetHash: string };
  const recorded = await api('/v1/conversations/' + sessionId + '/reviews', { jobId, targetHash: target.targetHash,
   idempotencyKey: randomUUID(), scores: { intentContext: 4, commercialFidelity: 4, clarityNaturalness: 4, nextStepUtility: 4 }, notes: syntheticNotice }) as { review: unknown };
  const review = ConversationReviewRecordSchema.parse(recorded.review); assert.equal(review.actorUserId, credential.actorUserId);
  const packet = await new Sprint4ReviewPacket(archive).execute({ plan, turnId: t1.id }); assert.ok(packet.success);
  assert.equal(packet.data.readyForReceipt, false); assert.equal(packet.data.objectiveAudit, 'pending'); assert.deepEqual(packet.data.findingsByTurn, []);
  const assessedAt = new Date().toISOString();
  const payload = { kind: 'sprint4-criteria-v1', planHash: packet.data.planHash, executionId: execution.id, turnId: t1.id,
   reviewId: review.id, reviewTargetHash: review.targetHash, assessedAt, turns: [{ turnId: t1.id, artifactRef: firstArtifact.ref,
    criteria: packet.data.checks.map(check => {
     const assessor = { kind: 'human' as const, actorUserId: credential.actorUserId };
     const status = check.id === failedCriterion ? 'failed' as const : 'passed' as const;
     return { id: check.id, status, assessor, notes: syntheticNotice, evidence: check.pending.map(obligation => {
      const binding: CriterionEvidenceBinding = { planHash: packet.data.planHash, executionId: execution.id, turnId: t1.id, artifactRef: firstArtifact.ref,
       reviewId: review.id, reviewTargetHash: review.targetHash, criterion: check.id, obligation, assessor,
       judgment: { status, notes: syntheticNotice, assessedAt } };
      const proof = { kind: 'synthetic-proof-only', notice: syntheticNotice, binding }, sha256 = terminalEvidenceHash(proof), ref = 'proof-sha256:' + sha256;
      proofs.set(ref, proof); return { obligation, ref, sha256 };
     }) };
    }) }] };
  const sha256 = terminalEvidenceHash(payload), criteria = CriteriaArtifactSchema.parse({ ref: 'criteria-sha256:' + sha256, sha256, payload });
  criteriaArchive.set(criteria.ref, structuredClone(criteria));
  return { review, criteria, selected: { reviewId: review.id, criteriaArtifactRef: criteria.ref } };
 };
 return { plan, execution, t1, t2, db, api, requests, open, closeStores, state, readArtifact, completeSyntheticJob, messagePosts, adjudicate, proofs,
  get archive() { return archive; }, get sessionId() { return sessionId; }, get audits() { return audits; }, get syntheticModelPosts() { return syntheticModelPosts; } };
}

test('local runner resumes C01 after bound synthetic review, preserves T1 and cannot replay a send', async t => {
 const f = await fixture(t), { plan, t1, t2, db, api, requests, open, closeStores, state, readArtifact, completeSyntheticJob, messagePosts } = f;
 let runtime = open(true);
 assert.deepEqual(await runtime.runner.execute({ action: 'observe', plan }), { success: true, data: { kind: 'idle' } });
 const first = await runtime.runner.execute({ action: 'advance', plan }); assert.ok(first.success, JSON.stringify(first));
 assert.equal(messagePosts(), 1, JSON.stringify(first)); assert.equal((await state()).entries[0].turnId, t1.id);
 const firstJobId = await completeSyntheticJob(t1);
 const captured = await runtime.runner.execute({ action: 'observe', plan }); assert.ok(captured.success, JSON.stringify(captured));
 assert.equal(captured.data.kind, 'awaiting-review');
 const firstArtifact = await readArtifact(t1.id), firstBytes = JSON.stringify(firstArtifact);
 assert.equal(firstArtifact.payload.observation.binding.jobId, firstJobId); assert.equal(firstArtifact.payload.observation.ledger.detail.settled, true);
 assert.equal(f.audits, 1);
 await closeStores(); runtime = open();
 assert.equal(JSON.stringify(await readArtifact(t1.id)), firstBytes);
 assert.deepEqual(await runtime.runner.execute({ action: 'advance', plan }), { success: true, data: { kind: 'awaiting-receipt', turnId: t1.id } });
 assert.equal(messagePosts(), 1); assert.equal((await state()).entries[0].receipts.length, 0);

 const { selected } = await f.adjudicate(firstJobId);
 const receipt = await runtime.review.execute({ plan, turnId: t1.id, ...selected });
 assert.ok(receipt.success, JSON.stringify(receipt)); assert.equal(receipt.data.kind, 'receipt');
 if (receipt.data.kind !== 'receipt') return;
 assert.equal(receipt.data.package.payload.acceptance, 'pending'); assert.equal(receipt.data.package.payload.humanSample, 'partial-execution');
 assert.equal(receipt.data.receipt.objectiveAudit, 'passed'); assert.equal(receipt.data.receipt.jobId, firstJobId);
 const observedReview = await runtime.runner.execute({ action: 'observe', plan, review: selected }); assert.ok(observedReview.success, JSON.stringify(observedReview));
 assert.deepEqual((await state()).entries[0].receipts, [receipt.data.receipt]); assert.equal(messagePosts(), 1);
 assert.ok((await runtime.runner.execute({ action: 'observe', plan, review: selected })).success);
 assert.deepEqual((await state()).entries[0].receipts, [receipt.data.receipt]);
 await closeStores(); runtime = open();
 const second = await runtime.runner.execute({ action: 'advance', plan }); assert.ok(second.success, JSON.stringify(second));
 assert.equal(messagePosts(), 2);
 const entries = (await state()).entries; assert.equal(entries.length, 2); assert.equal(entries[1].turnId, t2.id);
 assert.equal(entries[1].admission.sessionId, entries[0].admission.sessionId); assert.equal(entries[1].admission.sessionFresh, false);
 const secondJobId = await completeSyntheticJob(t2); assert.notEqual(secondJobId, firstJobId);
 const secondCaptured = await runtime.runner.execute({ action: 'observe', plan }); assert.ok(secondCaptured.success, JSON.stringify(secondCaptured));
 const secondArtifact = await readArtifact(t2.id); assert.equal(secondArtifact.payload.observation.memory.revision, firstArtifact.payload.observation.memory.revision + 1);
 assert.equal(secondArtifact.payload.observation.binding.candidateId, firstArtifact.payload.observation.binding.candidateId);
 assert.deepEqual(secondArtifact.payload.observation.memory.facts, firstArtifact.payload.observation.memory.facts);
 const completePacket = await new Sprint4ReviewPacket(f.archive).execute({ plan, turnId: t2.id }); assert.ok(completePacket.success, JSON.stringify(completePacket));
 assert.equal(completePacket.data.allTurnsArchived, true); assert.equal(completePacket.data.readyForReceipt, false);
 assert.deepEqual(completePacket.data.artifacts, [firstArtifact, secondArtifact]);
 assert.equal(JSON.stringify(await readArtifact(t1.id)), firstBytes);
 const replay = await runtime.capture.execute({ plan, turnId: t1.id }); assert.ok(replay.success); assert.equal(replay.data.source, 'archive'); assert.equal(f.audits, 2);
 assert.equal(JSON.stringify(replay.data.artifact), firstBytes);
 await closeStores(); runtime = open();
 assert.deepEqual(await runtime.runner.execute({ action: 'advance', plan }), { success: true, data: { kind: 'awaiting-receipt', turnId: t2.id } });
 assert.equal(messagePosts(), 2); assert.equal(f.syntheticModelPosts, 2);
 assert.equal(requests.filter(r => r.method === 'POST' && r.path === '/v1/lab/evaluation-sessions').length, 1);
 assert.equal((await db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 1); assert.equal((await db.query('SELECT id FROM sdr.jobs')).rows.length, 2);
 const reservations = (await db.query<{ detail: { settled: boolean; costMicroUsd: number } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
 assert.equal(reservations.length, 2); assert.ok(reservations.every(row => row.detail.settled && row.detail.costMicroUsd === 400));
 assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM sdr.deliveries')).rows[0].count, 0);
 assert.equal((await db.query('SELECT phone_number_id FROM sdr.channels WHERE enabled')).rows.length, 0);
 assert.equal((await db.query('SELECT id FROM sdr.publication_events')).rows.length, 0);
 assert.equal((await api('/v1/conversations/' + f.sessionId + '/reviews') as { reviews: unknown[] }).reviews.length, 1);
 assert.equal(JSON.stringify(await readArtifact(t1.id)), firstBytes);
});

test('a bound synthetic O2 failure remains halted after SQLite reopen and later favorable adjudication', async t => {
 const f = await fixture(t), { plan, t1 } = f;
 let runtime = f.open(true);
 const sent = await runtime.runner.execute({ action: 'advance', plan }); assert.ok(sent.success, JSON.stringify(sent));
 const jobId = await f.completeSyntheticJob(t1);
 const captured = await runtime.runner.execute({ action: 'observe', plan }); assert.ok(captured.success, JSON.stringify(captured));
 const original = JSON.stringify(await f.readArtifact(t1.id));
 const failed = await f.adjudicate(jobId, 'O2');
 const bound = await runtime.review.execute({ plan, turnId: t1.id, ...failed.selected });
 assert.ok(bound.success, JSON.stringify(bound)); assert.equal(bound.data.kind, 'halted');
 if (bound.data.kind !== 'halted') return;
 assert.equal(bound.data.receipt.objectiveAudit, 'failed'); assert.equal(bound.data.receipt.jobId, jobId);
 const recorded = await runtime.runner.execute({ action: 'observe', plan, review: failed.selected });
 assert.ok(recorded.success, JSON.stringify(recorded)); assert.equal(recorded.data.kind, 'halted');
 const failedState = await f.state(); assert.deepEqual(failedState.entries[0].receipts, [bound.data.receipt]);
 assert.equal(f.messagePosts(), 1);
 await f.closeStores(); runtime = f.open();
 const blocked = await runtime.runner.execute({ action: 'advance', plan }); assert.ok(blocked.success, JSON.stringify(blocked));
 assert.equal(blocked.data.kind, 'halted'); assert.deepEqual(await f.state(), failedState);
 // A distinct, fully verified favorable criteria artifact must not erase an earlier persisted failure.
 // The API itself keeps the original immutable review record; these are synthetic O1–O8 judgments.
 const favorable = await f.adjudicate(jobId);
 assert.equal(favorable.review.id, failed.review.id); assert.notEqual(favorable.criteria.ref, failed.criteria.ref);
 const favorableBound = await runtime.review.execute({ plan, turnId: t1.id, ...favorable.selected });
 assert.ok(favorableBound.success, JSON.stringify(favorableBound)); assert.equal(favorableBound.data.kind, 'receipt');
 const reconsidered = await runtime.runner.execute({ action: 'observe', plan, review: favorable.selected });
 assert.ok(reconsidered.success, JSON.stringify(reconsidered)); assert.equal(reconsidered.data.kind, 'halted');
 await f.closeStores(); runtime = f.open();
 const stillBlocked = await runtime.runner.execute({ action: 'advance', plan }); assert.ok(stillBlocked.success, JSON.stringify(stillBlocked));
 assert.equal(stillBlocked.data.kind, 'halted'); assert.deepEqual(await f.state(), failedState);
 assert.equal(f.messagePosts(), 1); assert.equal(f.syntheticModelPosts, 1); assert.equal(f.audits, 1);
 assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length, 1);
 assert.equal((await f.db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 1);
 assert.equal(JSON.stringify(await f.readArtifact(t1.id)), original);
});

test('a passed persisted receipt cannot advance after its private proof is lost or altered', async t => {
 for (const mutation of ['missing', 'altered'] as const) {
  const f = await fixture(t), { plan, t1 } = f;
  let runtime = f.open(true);
  const sent = await runtime.runner.execute({ action: 'advance', plan }); assert.ok(sent.success, JSON.stringify(sent));
  const jobId = await f.completeSyntheticJob(t1);
  const captured = await runtime.runner.execute({ action: 'observe', plan }); assert.ok(captured.success, JSON.stringify(captured));
  const judged = await f.adjudicate(jobId);
  const recorded = await runtime.runner.execute({ action: 'observe', plan, review: judged.selected }); assert.ok(recorded.success, JSON.stringify(recorded));
  const originalState = await f.state(), receipt = originalState.entries[0].receipts[0];
  assert.equal(receipt.objectiveAudit, 'passed'); assert.equal(receipt.jobId, jobId);
  const originalArtifact = JSON.stringify(await f.readArtifact(t1.id));
  const evidence = judged.criteria.payload.turns[0].criteria[0].evidence[0];
  const proof = f.proofs.get(evidence.ref); assert.ok(proof); assert.equal(terminalEvidenceHash(proof), evidence.sha256);
  await f.closeStores();
  if (mutation === 'missing') assert.equal(f.proofs.delete(evidence.ref), true);
  else proof.notice += ' Synthetic tampering after receipt persistence.';
  runtime = f.open();
  const verified = await runtime.review.execute({ plan, turnId: t1.id, receipt });
  assert.ok(verified.success, JSON.stringify(verified)); assert.equal(verified.data.kind, 'awaiting-review', mutation);
  const blocked = await runtime.runner.execute({ action: 'advance', plan });
  assert.ok(blocked.success, JSON.stringify(blocked)); assert.equal(blocked.data.kind, 'awaiting-review', mutation);
  if (blocked.data.kind === 'awaiting-review') assert.ok(blocked.data.gaps.some(gap => gap.endsWith(':proof-unverified')));
  assert.equal(f.messagePosts(), 1); assert.equal(f.syntheticModelPosts, 1); assert.equal(f.audits, 1);
  assert.deepEqual(await f.state(), originalState); assert.equal(JSON.stringify(await f.readArtifact(t1.id)), originalArtifact);
  assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length, 1);
  assert.equal((await f.db.query('SELECT id FROM sdr.lab_sessions')).rows.length, 1);
  assert.equal(f.requests.filter(request => request.method === 'POST' && request.path === '/v1/lab/evaluation-sessions').length, 1);
 }
});
