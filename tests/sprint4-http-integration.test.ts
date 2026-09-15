import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type { Database, Queryable } from '../src/database.js';
import { seedPilot, initialSnapshot } from '../src/seed.js';
import { Versioning } from '../src/versioning.js';
import { createFinancialDraftSnapshot } from '../src/financial-version.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { CampaignAdmissionSchema, CampaignAdmissionMarkerSchema } from '../src/campaign-admission.spec.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';
import { Sprint4Controller } from '../evaluations/sprint4-controller.js';
import { ControllerStateSchema, type AdmissionEvidence } from '../evaluations/sprint4-controller.spec.js';
import { Sprint4Journal } from '../evaluations/sprint4-journal.js';
import { Sprint4Http } from '../evaluations/sprint4-http.js';
import { HttpResultSchema, HttpSendResponseSchema } from '../evaluations/sprint4-http.spec.js';
import { testConfig } from './config.js';

const scope = { tenantId: 'cognita-homologacao', brandId: 'sapore' } as const;
const credential = { actorUserId: 'http-integration-admin', accessToken: 'synthetic-http-integration-token' };
const origin = 'https://sdr-api.cognitaai.com.br';

async function fixture(t: TestContext) {
 const directory = await mkdtemp(join(tmpdir(), 'sprint4-http-integration-'));
 const pg = new PGlite({ extensions: { vector } });
 const db: Database = { query: (sql, params) => pg.query(sql, params), transaction: fn => pg.transaction(tx => fn(tx as Queryable)), close: () => pg.close() };
 const journal = new Sprint4Journal({ directory, initializeNew: true });
 let app: Awaited<ReturnType<typeof createServer>> | undefined;
 t.after(async () => { await app?.close(); await journal.execute({ action: 'close' }); await db.close(); await rm(directory, { recursive: true, force: true }); });
 for (const migration of ['001_sdr.sql', '002_versions.sql', '003_lab_sessions.sql']) await pg.exec(await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
 await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Synthetic HTTP integration' }], adminUserIds: [credential.actorUserId] });
 const draft = await new Versioning(db).saveDraft(scope, createFinancialDraftSnapshot(initialSnapshot(scope)), credential.actorUserId);
 assert.ok(draft.ok);
 const planned = new Sprint4CampaignPlanner().execute({ runId: 'http-integration', actorUserId: credential.actorUserId,
  target: { versionId: draft.value.versionId, contentHash: draft.value.contentHash, model: 'gpt-5.4-2026-03-05' } });
 assert.ok(planned.success);
 const config = { ...testConfig, EXECUTION_MODE: 'laboratory' as const, LAB_BUDGET_GATE_ID: 'sprint3-continuous-20260910', LAB_BUDGET_LIMIT_MICRO_USD: 1000000 };
 let authCalls = 0;
 app = await createServer(db, config, { transport: async (url, init) => {
  assert.equal(url, config.SUPABASE_URL + '/auth/v1/user', 'only the synthetic Supabase user lookup is allowed');
  assert.equal(init?.method ?? 'GET', 'GET');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer ' + credential.accessToken);
  assert.equal(headers.get('apikey'), config.SUPABASE_ANON_KEY);
  authCalls++;
  return Response.json({ id: credential.actorUserId });
 } });
 return { db, journal, app, config, plan: planned.data, get authCalls() { return authCalls; } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function bridge(f: Fixture, afterResponse?: (path: string, body: string, status: number) => Promise<void>) {
 const requests: { method: string; path: string }[] = [];
 const transport: typeof fetch = async (url, init) => {
  assert.equal(typeof url, 'string');
  const parsed = new URL(String(url));
  assert.equal(parsed.origin, origin); assert.equal(parsed.search, ''); assert.equal(parsed.hash, '');
  assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
  const method = init?.method;
  assert.ok(method === 'GET' || method === 'POST');
  assert.ok(method === 'GET' && parsed.pathname === '/v1/me' || method === 'POST' &&
   (parsed.pathname === '/v1/lab/evaluation-sessions' || /^\/v1\/lab\/sessions\/[0-9a-f-]{36}\/messages$/.test(parsed.pathname)));
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer ' + credential.accessToken);
  assert.equal(headers.get('x-tenant-id'), scope.tenantId); assert.equal(headers.get('x-brand-id'), scope.brandId);
  requests.push({ method, path: parsed.pathname });
  const injectedHeaders: Record<string, string> = {};
  headers.forEach((value, name) => { injectedHeaders[name] = value; });
  const response = await f.app.inject({ method, url: parsed.pathname, headers: injectedHeaders,
   ...(init?.body === undefined ? {} : { payload: String(init.body) }) });
  if (afterResponse) await afterResponse(parsed.pathname, response.body, response.statusCode);
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
 };
 return { transport, requests };
}

function controllerFor(f: Fixture, sessionId: string) {
 const turn = f.plan.phases[0].executions[0].turns[0], now = Date.now();
 // Readiness is synthetic; this fixture proves HTTP/runtime binding, not real operational admission or human acceptance.
 const evidence: AdmissionEvidence = { turnId: turn.id, actorUserId: credential.actorUserId, target: f.plan.request.target, evidenceRef: 'synthetic-http-readiness',
  observedAtMs: now, validUntilMs: now + 60000, adminActive: true, routeValidated: true, published: false, healthy: true, noUnexpectedJobs: true, ...scope,
  executionMode: 'laboratory', channelEnabled: false, nativeControlVerified: false, retentionEnabled: false,
  sessionId, sessionOwned: true, sessionReady: true, sessionFresh: true, requestId: randomUUID(),
  budget: { gateId: 'sprint3-continuous-20260910', limitMicroUsd: 1000000, accountedMicroUsd: 0, maxReservationMicroUsd: 100000, remainingCampaignReviewed: true },
  daily: { actorUserId: credential.actorUserId, limitMessages: 100, rollingWindowHours: 24, usedMessages: 0, stageAndControlsReviewed: true } };
 return { turn, evidence, controller: new Sprint4Controller(f.journal.asCampaignJournal(), { nowMs: Date.now, async inspect() { return structuredClone(evidence); } }) };
}

// Fastify routing/auth/JSON, SQLite journal and PostgreSQL-compatible state are real in-process.
// No socket/TLS, external Supabase, n8n/model request, paid usage, publication or human review occurs.
test('HTTP pending ACK delivered after the synthetic worker reserved remains only a submission observation', async t => {
 const f = await fixture(t);
 const setup = bridge(f), setupClient = new Sprint4Http(credential, setup.transport);
 const identity = await setupClient.execute({ action: 'identity' });
 assert.deepEqual(identity, { success: true, data: { kind: 'identity', identity: { userId: credential.actorUserId, ...scope, role: 'admin' } } });
 const created = await setupClient.execute({ action: 'create-session', mode: 'evaluation', requestId: randomUUID(), label: 'Synthetic HTTP candidate', scenario: 'free', target: f.plan.request.target });
 assert.ok(created.success, JSON.stringify(created)); assert.equal(created.data.kind, 'session-created');
 if (created.data.kind !== 'session-created') return;
 const session = created.data.session;
 assert.equal(session.versionId, f.plan.request.target.versionId);
 assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length, 0);
 assert.equal((await f.db.query('SELECT id FROM sdr.publication_events')).rows.length, 0);
 const c = controllerFor(f, session.id), store = new Store(f.db);
 let syntheticPosts = 0, pendingSnapshotJobId: string | undefined;
 const wire = bridge(f, async (path, body, status) => {
  if (!path.endsWith('/messages')) return;
  assert.equal(status, 200);
  const snapshot = HttpSendResponseSchema.parse(JSON.parse(body));
  assert.ok(snapshot.jobId); assert.equal(snapshot.detail.job?.state, 'pending');
  pendingSnapshotJobId = snapshot.jobId;
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  const state = ControllerStateSchema.parse(await f.journal.asCampaignJournal().read(f.plan.request.runId));
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].receipts.length, 0);
  const admissionRow = (await f.db.query<{ id: string; detail: unknown }>("SELECT id,detail FROM sdr.events WHERE type='lab_campaign_admitted'")).rows;
  assert.equal(admissionRow.length, 1);
  const admission = CampaignAdmissionSchema.parse(admissionRow[0].detail);
  assert.equal(admission.jobId, snapshot.jobId); assert.equal(admission.requestId, c.evidence.requestId);
  assert.equal(admission.sessionId, session.id); assert.deepEqual(admission.target, f.plan.request.target);
  const jobRow = (await f.db.query<{ context: { campaignAdmission: unknown } }>('SELECT context FROM sdr.jobs WHERE id=$1', [snapshot.jobId])).rows[0];
  const marker = CampaignAdmissionMarkerSchema.parse(jobRow.context.campaignAdmission);
  assert.equal(marker.id, admissionRow[0].id); assert.equal(marker.contentHash, createHash('sha256').update(JSON.stringify(admission)).digest('hex'));
  const channel = await store.scopeForJob(snapshot.jobId), job = await store.claim(channel);
  assert.ok(job); assert.equal(job.id, snapshot.jobId); assert.equal(job.attempts, 1);
  assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows.length, 0);
  const engine = new Engine(store, f.config, async (url, init) => {
   assert.equal(url, f.config.N8N_WEBHOOK_URL); assert.equal(init?.method, 'POST');
   const payload = JSON.parse(String(init?.body));
   assert.equal(payload.jobId, job.id); assert.equal(payload.configVersion, session.versionId); assert.equal(payload.model, f.plan.request.target.model);
   syntheticPosts++; return Response.json({ accepted: true });
  });
  await engine.dispatch(channel, job);
  assert.equal(syntheticPosts, 1);
  const reservations = (await f.db.query<{ detail: { jobId: string; gateId: string; attempt: number; reservedMicroUsd: number; costMicroUsd: number; settled: boolean } }>("SELECT detail FROM sdr.events WHERE type='lab_model_budget_reserved'")).rows;
  assert.equal(reservations.length, 1);
  const reservation = reservations[0].detail;
  assert.equal(reservation.jobId, job.id); assert.equal(reservation.gateId, c.evidence.budget.gateId); assert.equal(reservation.attempt, 1);
  assert.equal(reservation.settled, false); assert.ok(reservation.reservedMicroUsd > 0 && reservation.reservedMicroUsd <= c.evidence.budget.maxReservationMicroUsd);
  assert.equal(reservation.costMicroUsd, reservation.reservedMicroUsd, 'conservative pending reservation, not paid/model usage');
  // Only now release the older pending JSON to the HTTP adapter: the reservation already committed.
 });
 const client = new Sprint4Http(credential, wire.transport, { controller: c.controller });
 const sent = await client.execute({ action: 'advance', plan: f.plan });
 assert.ok(sent.success, JSON.stringify(sent)); assert.equal(sent.data.kind, 'submission-confirmed');
 if (sent.data.kind !== 'submission-confirmed') return;
 assert.equal(HttpResultSchema.safeParse(sent).success, true);
 assert.equal(sent.data.jobId, pendingSnapshotJobId); assert.equal(sent.data.detail.job?.state, 'pending');
 assert.equal(sent.data.executionAudit, 'pending');
 for (const privateField of ['ledger', 'preparation', 'receipt', 'objectiveAudit', 'humanReview']) assert.equal(privateField in sent.data, false);
 assert.equal(sent.data.detail.messages.find(message => message.id === session.id + ':' + c.evidence.requestId)?.text, c.turn.input);
 const persisted = ControllerStateSchema.parse(await f.journal.asCampaignJournal().read(f.plan.request.runId));
 assert.equal(persisted.entries.length, 1); assert.equal(persisted.entries[0].receipts.length, 0);
 const next = await client.execute({ action: 'advance', plan: f.plan });
 assert.deepEqual(next, { success: true, data: { kind: 'controller', state: { kind: 'awaiting-receipt', turnId: c.turn.id } } });
 assert.equal(wire.requests.filter(request => request.method === 'POST').length, 1); assert.equal(syntheticPosts, 1);
 assert.equal(f.authCalls, setup.requests.length + wire.requests.length, 'every HTTP request traverses the existing authentication path');
 assert.equal((await f.db.query<{ n: number }>('SELECT count(*)::int AS n FROM sdr.deliveries')).rows[0].n, 0);
 assert.equal((await f.db.query('SELECT phone_number_id FROM sdr.channels WHERE enabled')).rows.length, 0);
 assert.equal((await f.db.query('SELECT id FROM sdr.publication_events')).rows.length, 0);
});

test('membership revoked after GET me is rejected by the real POST auth without dispatch or invented receipt', async t => {
 const f = await fixture(t), setup = bridge(f);
 const created = await new Sprint4Http(credential, setup.transport).execute({ action: 'create-session', mode: 'evaluation',
  requestId: randomUUID(), label: 'Synthetic revoked admin', scenario: 'free', target: f.plan.request.target });
 assert.ok(created.success, JSON.stringify(created)); assert.equal(created.data.kind, 'session-created');
 if (created.data.kind !== 'session-created') return;
 const session = created.data.session, c = controllerFor(f, session.id);
 let revocations = 0;
 const wire = bridge(f, async (path, body, status) => {
  if (path === '/v1/me' && status === 200) {
   assert.equal(JSON.parse(body).role, 'admin');
   await f.db.query('UPDATE sdr.memberships SET active=false WHERE tenant_id=$1 AND brand_id=$2 AND user_id=$3', [scope.tenantId, scope.brandId, credential.actorUserId]);
   revocations++;
  }
  if (path.endsWith('/messages')) {
   assert.equal(status, 403); assert.equal(JSON.parse(body).error.code, 'ACCESS_DENIED');
  }
 });
 const client = new Sprint4Http(credential, wire.transport, { controller: c.controller });
 const failed = await client.execute({ action: 'advance', plan: f.plan });
 assert.equal(failed.success, false);
 if (failed.success) return;
 assert.equal(HttpResultSchema.safeParse(failed).success, true);
 assert.equal(failed.error.requestAttempted, true); assert.equal(failed.error.requiresAudit, true);
 assert.equal(revocations, 1); assert.equal(wire.requests.filter(request => request.method === 'POST').length, 1);
 assert.equal((await f.db.query('SELECT id FROM sdr.messages')).rows.length, 0);
 assert.equal((await f.db.query('SELECT id FROM sdr.jobs')).rows.length, 0);
 assert.equal((await f.db.query("SELECT id FROM sdr.events WHERE type IN('lab_model_budget_reserved','lab_campaign_admitted')")).rows.length, 0);
 const state = ControllerStateSchema.parse(await f.journal.asCampaignJournal().read(f.plan.request.runId));
 assert.equal(state.entries.length, 1); assert.equal(state.entries[0].receipts.length, 0);
 assert.deepEqual(await c.controller.execute({ action: 'next', plan: f.plan }),
  { success: true, data: { kind: 'awaiting-receipt', turnId: c.turn.id } });
 const again = await client.execute({ action: 'advance', plan: f.plan });
 assert.equal(again.success, false);
 if (!again.success) assert.equal(again.error.requestAttempted, false);
 assert.equal(wire.requests.filter(request => request.method === 'POST').length, 1);
 assert.equal((await f.db.query<{ n: number }>('SELECT count(*)::int AS n FROM sdr.deliveries')).rows[0].n, 0);
 assert.equal((await f.db.query('SELECT id FROM sdr.publication_events')).rows.length, 0);
});
