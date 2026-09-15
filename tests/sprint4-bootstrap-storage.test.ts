import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, chmod, stat, mkdir, symlink, link, rename, copyFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { Sprint4BootstrapStorage } from '../evaluations/sprint4-bootstrap-storage.js';
import { BootstrapIntentSchema, BootstrapObservationSchema, type BootstrapIntent, type BootstrapStorageResult } from '../evaluations/sprint4-bootstrap.spec.js';
import { Sprint4CampaignPlanner } from '../evaluations/sprint4-campaign.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function intent(): BootstrapIntent {
 const result = new Sprint4CampaignPlanner().execute({ runId: 'bootstrap-fixture', actorUserId: 'offline-admin',
  target: { versionId: 'offline-version', contentHash: 'a'.repeat(64), model: 'gpt-5.4-2026-03-05' } });
 assert.ok(result.success);
 return BootstrapIntentSchema.parse({ kind: 'sprint4-session-intent-v1', runId: result.data.request.runId,
  executionId: result.data.phases[0].executions[0].id, planHash: hash(result.data), actorUserId: result.data.request.actorUserId,
  target: result.data.request.target, requestId: '11111111-1111-4111-8111-111111111111', mode: 'evaluation',
  label: 'Offline session', scenario: 'free', createdAtMs: 1000 });
}
function observation(value = intent()) {
 return BootstrapObservationSchema.parse({ kind: 'sprint4-session-observation-v1', intentHash: hash(BootstrapIntentSchema.parse(value)),
  source: 'http', evidenceRef: 'offline-evidence', observedAtMs: 1500,
  session: { id: '22222222-2222-4222-8222-222222222222', candidateId: '33333333-3333-4333-8333-333333333333',
   label: value.label, scenario: value.scenario, versionId: value.target.versionId, state: 'automatic' } });
}
async function fixture(t: TestContext) {
 const directory = await mkdtemp(join(tmpdir(), 'sprint4-bootstrap-storage-'));
 const storage = new Sprint4BootstrapStorage({ directory, initializeNew: true });
 t.after(async () => { await storage.execute({ action: 'close' }); await rm(directory, { recursive: true, force: true }); });
 return { directory, storage, file: join(directory, 'sprint4-bootstrap.sqlite') };
}
function message(child: ChildProcess): Promise<unknown> {
 return new Promise((resolve, reject) => {
  const clear = () => { clearTimeout(timer); child.off('message', receive); child.off('error', fail); child.off('exit', exited); };
  const receive = (value: unknown) => { clear(); resolve(value); };
  const fail = (error: Error) => { clear(); reject(error); };
  const exited = () => fail(new Error('offline child exited before its result'));
  const timer = setTimeout(() => fail(new Error('offline child timed out')), 10_000);
  child.once('message', receive); child.once('error', fail); child.once('exit', exited);
 });
}

test('one committed bootstrap intent survives reopening and an identical claim never grants creation twice', async t => {
 const { directory, storage } = await fixture(t), value = intent();
 const read = { action: 'read', runId: value.runId, executionId: value.executionId };
 assert.deepEqual(await storage.execute(read), { success: true, data: { kind: 'read', record: null } });
 assert.deepEqual(await storage.execute({ action: 'claim-once', intent: value }), { success: true, data: { kind: 'claimed', claimed: true } });
 await storage.execute({ action: 'close' });
 const reopened = new Sprint4BootstrapStorage({ directory });
 try {
  assert.deepEqual(await reopened.execute(read), { success: true, data: { kind: 'read', record: { intent: value, observation: null } } });
  assert.deepEqual(await reopened.execute({ action: 'claim-once', intent: value }), { success: true, data: { kind: 'claimed', claimed: false } });
 } finally { await reopened.execute({ action: 'close' }); }
});

test('intent replays are exact and a run, execution or request identity cannot be reassigned', async t => {
 const { storage } = await fixture(t), value = intent();
 assert.ok((await storage.execute({ action: 'claim-once', intent: value })).success);
 for (const changed of [
  { ...value, label: 'changed' }, { ...value, requestId: '44444444-4444-4444-8444-444444444444' },
  { ...value, runId: 'other-run' }, { ...value, createdAtMs: 1001 }, { ...value, mode: 'published' },
  { ...value, actorUserId: 'other-admin' }, { ...value, planHash: 'b'.repeat(64) },
  { ...value, target: { ...value.target, contentHash: 'b'.repeat(64) } },
  { ...value, executionId: value.executionId + '-other' },
 ]) assert.deepEqual(await storage.execute({ action: 'claim-once', intent: changed }), { success: false, error: { code: 'STATE_CONFLICT' } });
 const next = { ...value, executionId: value.executionId.replace('C01', 'C02'), requestId: '44444444-4444-4444-8444-444444444444' };
 for (const changed of [{ ...next, actorUserId: 'other-admin' }, { ...next, planHash: 'b'.repeat(64) },
  { ...next, target: { ...value.target, versionId: 'different-version' } }]) {
  assert.deepEqual(await storage.execute({ action: 'claim-once', intent: changed }), { success: false, error: { code: 'STATE_CONFLICT' } });
 }
 assert.deepEqual(await storage.execute({ action: 'read', runId: 'foreign-run', executionId: value.executionId }),
  { success: false, error: { code: 'STATE_CONFLICT' } });
 assert.deepEqual(await storage.execute({ action: 'claim-once', intent: Object.fromEntries(Object.entries(value).reverse()) }),
  { success: true, data: { kind: 'claimed', claimed: false } }, 'Zod canonical ordering defines equality');
 assert.deepEqual(await storage.execute({ action: 'claim-once', intent: next }), { success: true, data: { kind: 'claimed', claimed: true } });
});

test('a confirmed session observation is appended once, survives reopening and cannot be replaced', async t => {
 const { directory, storage, file } = await fixture(t), value = intent(), observed = observation(value);
 await storage.execute({ action: 'claim-once', intent: value });
 const command = { action: 'record-session-once', runId: value.runId, executionId: value.executionId, observation: observed };
 assert.deepEqual(await storage.execute(command), { success: true, data: { kind: 'recorded', duplicate: false } });
 assert.deepEqual(await storage.execute({ ...command, observation: Object.fromEntries(Object.entries(observed).reverse()) }),
  { success: true, data: { kind: 'recorded', duplicate: true } });
 assert.deepEqual(await storage.execute({ ...command, observation: { ...observed, evidenceRef: 'changed' } }),
  { success: false, error: { code: 'STATE_CONFLICT' } });
 await storage.execute({ action: 'close' });
 const reopened = new Sprint4BootstrapStorage({ directory });
 try {
  assert.deepEqual(await reopened.execute({ action: 'read', runId: value.runId, executionId: value.executionId }),
   { success: true, data: { kind: 'read', record: { intent: value, observation: observed } } });
 } finally { await reopened.execute({ action: 'close' }); }
 const inspect = new DatabaseSync(file, { readOnly: true });
 try {
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM intents').get()?.n, 1);
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM observations').get()?.n, 1);
 } finally { inspect.close(); }
});

test('confirmation must match its intent and cannot reuse a session or candidate from another execution', async t => {
 const { storage } = await fixture(t), value = intent(), observed = observation(value);
 const command = { action: 'record-session-once', runId: value.runId, executionId: value.executionId, observation: observed };
 assert.deepEqual(await storage.execute(command), { success: false, error: { code: 'STATE_CONFLICT' } });
 await storage.execute({ action: 'claim-once', intent: value });
 for (const changed of [
  { ...observed, intentHash: 'b'.repeat(64) }, { ...observed, observedAtMs: value.createdAtMs - 1 },
  { ...observed, session: { ...observed.session, versionId: 'other-version' } },
  { ...observed, session: { ...observed.session, label: 'other-label' } },
  { ...observed, session: { ...observed.session, scenario: 'human' } },
 ]) assert.deepEqual(await storage.execute({ ...command, observation: changed }), { success: false, error: { code: 'STATE_CONFLICT' } });
 assert.deepEqual(await storage.execute({ action: 'read', runId: value.runId, executionId: value.executionId }),
  { success: true, data: { kind: 'read', record: { intent: value, observation: null } } });
 assert.ok((await storage.execute(command)).success);
 const next = { ...value, executionId: value.executionId.replace('C01', 'C02'), requestId: '44444444-4444-4444-8444-444444444444' };
 await storage.execute({ action: 'claim-once', intent: next });
 const nextObservation = observation(next), sessionId = '55555555-5555-4555-8555-555555555555', candidateId = '66666666-6666-4666-8666-666666666666';
 for (const session of [{ ...nextObservation.session, candidateId }, { ...nextObservation.session, id: sessionId }]) {
  assert.deepEqual(await storage.execute({ ...command, executionId: next.executionId, observation: { ...nextObservation, session } }),
   { success: false, error: { code: 'STATE_CONFLICT' } });
 }
 assert.deepEqual(await storage.execute({ ...command, executionId: next.executionId,
  observation: { ...nextObservation, source: 'database-readonly', session: { ...nextObservation.session, id: sessionId, candidateId } } }),
 { success: true, data: { kind: 'recorded', duplicate: false } });
});

test('storage rejects nonprivate directories, loose file permissions, links, foreign entries and replaced inodes', async t => {
 const { directory, storage, file } = await fixture(t), value = intent();
 const read = { action: 'read', runId: value.runId, executionId: value.executionId };
 const unsafe = { success: false, error: { code: 'UNSAFE_STORAGE' } };
 await chmod(directory, 0o755); assert.deepEqual(await storage.execute(read), unsafe);
 await chmod(directory, 0o700); assert.ok((await storage.execute({ action: 'claim-once', intent: value })).success);
 assert.equal((await stat(file)).mode & 0o777, 0o600);
 await chmod(file, 0o644); assert.deepEqual(await storage.execute(read), unsafe); await chmod(file, 0o600);
 const outside = await mkdtemp(join(tmpdir(), 'sprint4-bootstrap-links-'));
 t.after(() => rm(outside, { recursive: true, force: true }));
 await symlink(directory, join(outside, 'directory-link'));
 const alias = new Sprint4BootstrapStorage({ directory: join(outside, 'directory-link') });
 assert.deepEqual(await alias.execute(read), unsafe); await alias.execute({ action: 'close' });
 await link(file, join(outside, 'hard-link')); assert.deepEqual(await storage.execute(read), unsafe);
 await rm(join(outside, 'hard-link'));
 await mkdir(join(outside, 'private'), { mode: 0o700 });
 await symlink(file, join(outside, 'private', 'sprint4-bootstrap.sqlite'));
 const symlinked = new Sprint4BootstrapStorage({ directory: join(outside, 'private') });
 assert.deepEqual(await symlinked.execute(read), unsafe); await symlinked.execute({ action: 'close' });
 await mkdir(join(directory, 'foreign-entry'), { mode: 0o700 }); assert.deepEqual(await storage.execute(read), unsafe);
 await rm(join(directory, 'foreign-entry'), { recursive: true });
 await rename(file, join(outside, 'original.sqlite')); await copyFile(join(outside, 'original.sqlite'), file);
 assert.deepEqual(await storage.execute(read), unsafe, 'an open connection cannot silently follow a replacement database');
 assert.deepEqual(await new Sprint4BootstrapStorage({ directory: '.' }).execute(read), unsafe);
});

test('missing, foreign and corrupt storage never becomes an empty successful state or gets reinitialized', async t => {
 const { directory, storage, file } = await fixture(t), value = intent();
 const read = { action: 'read', runId: value.runId, executionId: value.executionId };
 const absent = new Sprint4BootstrapStorage({ directory });
 assert.equal((await absent.execute(read)).success, false); assert.equal((await absent.execute(read)).success, false);
 await absent.execute({ action: 'close' });
 assert.ok((await storage.execute({ action: 'claim-once', intent: value })).success);
 await storage.execute({ action: 'close' });
 const corruptor = new DatabaseSync(file);
 corruptor.prepare('UPDATE intents SET payload=? WHERE execution_id=?').run('{}', value.executionId); corruptor.close();
 const before = await readFile(file), corrupt = new Sprint4BootstrapStorage({ directory });
 assert.deepEqual(await corrupt.execute(read), { success: false, error: { code: 'CORRUPT_STATE' } });
 assert.deepEqual(await corrupt.execute(read), { success: false, error: { code: 'CORRUPT_STATE' } });
 await corrupt.execute({ action: 'close' });
 const reset = new Sprint4BootstrapStorage({ directory, initializeNew: true });
 assert.deepEqual(await reset.execute(read), { success: false, error: { code: 'UNSAFE_STORAGE' } });
 await reset.execute({ action: 'close' }); assert.deepEqual(await readFile(file), before);
 const foreignDirectory = await mkdtemp(join(tmpdir(), 'sprint4-bootstrap-foreign-'));
 t.after(() => rm(foreignDirectory, { recursive: true, force: true }));
 const foreignFile = join(foreignDirectory, 'sprint4-bootstrap.sqlite');
 const fd = await open(foreignFile, 'wx', 0o600); await fd.close();
 const foreignDb = new DatabaseSync(foreignFile); foreignDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE unrelated(value TEXT)'); foreignDb.close();
 const foreignBefore = await readFile(foreignFile), foreign = new Sprint4BootstrapStorage({ directory: foreignDirectory });
 assert.deepEqual(await foreign.execute(read), { success: false, error: { code: 'CORRUPT_STATE' } });
 assert.deepEqual(await foreign.execute(read), { success: false, error: { code: 'CORRUPT_STATE' } });
 await foreign.execute({ action: 'close' }); assert.deepEqual(await readFile(foreignFile), foreignBefore);
});

test('a single read snapshot cannot mistake a concurrently committed intent and observation for corrupt state', async t => {
 const { directory, storage } = await fixture(t), value = intent(), observed = observation(value);
 const read = { action: 'read', runId: value.runId, executionId: value.executionId };
 await storage.execute(read);
 const writer = new Sprint4BootstrapStorage({ directory });
 t.after(() => writer.execute({ action: 'close' }));
 const db = (storage as unknown as { db: DatabaseSync }).db, prepare = db.prepare.bind(db);
 const writes: Promise<BootstrapStorageResult>[] = [];
 let interleaved = false;
 db.prepare = sql => {
  const statement = prepare(sql);
  if (!/\b(?:FROM|JOIN)\s+intents\b/.test(sql)) return statement;
  return new Proxy(statement, { get(target, key) {
   const member = Reflect.get(target, key);
   if (key !== 'get') return typeof member === 'function' ? member.bind(target) : member;
   return (...parameters: unknown[]) => {
    const row = Reflect.apply(target.get, target, parameters);
    if (!interleaved) {
     interleaved = true;
     // Execute has no awaits inside its SQLite transaction: both real commits occur here before the reader continues.
     writes.push(writer.execute({ action: 'claim-once', intent: value }));
     writes.push(writer.execute({ action: 'record-session-once', runId: value.runId, executionId: value.executionId, observation: observed }));
    }
    return row;
   };
  } });
 };
 try {
  const result = await storage.execute(read);
  assert.ok((await Promise.all(writes)).every(write => write.success)); assert.equal(writes.length, 2);
  assert.deepEqual(result, { success: true, data: { kind: 'read', record: null } });
 } finally { db.prepare = prepare; }
 assert.deepEqual(await storage.execute(read), { success: true, data: { kind: 'read', record: { intent: value, observation: observed } } });
});

test('two processes racing one execution get one durable winner and a fresh process recovers it after SIGKILL', async t => {
 const { directory, storage, file } = await fixture(t), value = intent();
 const read = { action: 'read', runId: value.runId, executionId: value.executionId };
 await storage.execute(read); await storage.execute({ action: 'close' });
 const source = `import {Sprint4BootstrapStorage} from ${JSON.stringify(new URL('../evaluations/sprint4-bootstrap-storage.js', import.meta.url).href)};
  const storage=new Sprint4BootstrapStorage({directory:process.argv[1]});
  process.send(await storage.execute(${JSON.stringify(read)}));
  process.on('message',async command=>process.send(await storage.execute(command)));`;
 const children: ChildProcess[] = [];
 let blocker: DatabaseSync | undefined;
 const start = () => {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.push(child); return { child, ready: message(child) };
 };
 const kill = (child: ChildProcess) => new Promise<void>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
  child.once('exit', () => resolve()); child.kill('SIGKILL');
 });
 try {
  const contenders = [start(), start()];
  assert.deepEqual(await Promise.all(contenders.map(c => c.ready)), [
   { success: true, data: { kind: 'read', record: null } }, { success: true, data: { kind: 'read', record: null } },
  ]);
  blocker = new DatabaseSync(file); blocker.exec('BEGIN IMMEDIATE');
  const candidates = [value, { ...value, requestId: '77777777-7777-4777-8777-777777777777', createdAtMs: 1001 }];
  const pending = contenders.map(c => message(c.child));
  contenders.forEach((c, i) => c.child.send({ action: 'claim-once', intent: candidates[i] }));
  await new Promise(resolve => setTimeout(resolve, 100)); blocker.exec('COMMIT'); blocker.close(); blocker = undefined;
  const results = await Promise.all(pending) as BootstrapStorageResult[];
  const winner = results.findIndex(result => result.success && result.data.kind === 'claimed' && result.data.claimed);
  assert.ok(winner >= 0); assert.deepEqual(results[1 - winner], { success: false, error: { code: 'STATE_CONFLICT' } });
  await Promise.all(contenders.map(c => kill(c.child)));
  const resumed = start();
  assert.deepEqual(await resumed.ready, { success: true, data: { kind: 'read', record: { intent: candidates[winner], observation: null } } });
  const replay = message(resumed.child); resumed.child.send({ action: 'claim-once', intent: candidates[winner] });
  assert.deepEqual(await replay, { success: true, data: { kind: 'claimed', claimed: false } });
  await kill(resumed.child);
  const inspect = new DatabaseSync(file, { readOnly: true });
  try {
   assert.equal(inspect.prepare('SELECT count(*) AS n FROM intents').get()?.n, 1);
   assert.equal(inspect.prepare('SELECT count(*) AS n FROM runs').get()?.n, 1);
   assert.equal(inspect.prepare('SELECT count(*) AS n FROM observations').get()?.n, 0);
  } finally { inspect.close(); }
 } finally {
  if (blocker) { try { blocker.exec('ROLLBACK'); } finally { blocker.close(); } }
  await Promise.all(children.map(kill));
 }
});

test('SQLite failures roll back the whole write and preserve durable settings without exposing errors or inventing observations', async t => {
 const { storage } = await fixture(t), value = intent(), observed = observation(value);
 const read = { action: 'read', runId: value.runId, executionId: value.executionId };
 await storage.execute(read);
 const db = (storage as unknown as { db: DatabaseSync }).db;
 assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
 assert.equal(db.prepare('PRAGMA synchronous').get()?.synchronous, 3);
 assert.equal(db.prepare('PRAGMA fullfsync').get()?.fullfsync, 1);
 assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
 assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1);
 db.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON intents BEGIN SELECT RAISE(ABORT,'private-fixture-canary'); END");
 assert.deepEqual(await storage.execute({ action: 'claim-once', intent: value }), { success: false, error: { code: 'STORAGE_FAILURE' } });
 assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get()?.n, 0, 'run insertion and intent insertion are atomic');
 assert.deepEqual(await storage.execute(read), { success: true, data: { kind: 'read', record: null } });
 db.exec('DROP TRIGGER fail_intent');
 assert.ok((await storage.execute({ action: 'claim-once', intent: value })).success);
 db.exec("CREATE TRIGGER fail_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'private-fixture-canary'); END");
 assert.deepEqual(await storage.execute({ action: 'record-session-once', runId: value.runId, executionId: value.executionId, observation: observed }),
  { success: false, error: { code: 'STORAGE_FAILURE' } });
 assert.deepEqual(await storage.execute(read), { success: true, data: { kind: 'read', record: { intent: value, observation: null } } });
 assert.deepEqual(await storage.execute({ action: 'reset' }), { success: false, error: { code: 'INVALID_INPUT' } });
 await storage.execute({ action: 'close' });
 assert.deepEqual(await storage.execute(read), { success: false, error: { code: 'CLOSED' } });
});

test('UUID case variants cannot bypass request, session or candidate uniqueness while canonical payloads remain exact', async t => {
 const { storage } = await fixture(t), value = { ...intent(), requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
 const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', candidateId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 await storage.execute({ action: 'claim-once', intent: value });
 const next = { ...value, executionId: value.executionId.replace('C01', 'C02') };
 assert.deepEqual(await storage.execute({ action: 'claim-once', intent: { ...next, requestId: value.requestId.toUpperCase() } }),
  { success: false, error: { code: 'STATE_CONFLICT' } });
 const observed = observation(value); observed.session.id = sessionId; observed.session.candidateId = candidateId;
 assert.ok((await storage.execute({ action: 'record-session-once', runId: value.runId, executionId: value.executionId, observation: observed })).success);
 next.requestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 assert.ok((await storage.execute({ action: 'claim-once', intent: next })).success);
 const nextObservation = observation(next);
 for (const session of [{ ...nextObservation.session, id: sessionId.toUpperCase() },
  { ...nextObservation.session, candidateId: candidateId.toUpperCase() }]) {
  assert.deepEqual(await storage.execute({ action: 'record-session-once', runId: next.runId, executionId: next.executionId,
   observation: { ...nextObservation, session } }), { success: false, error: { code: 'STATE_CONFLICT' } });
 }
 assert.deepEqual(await storage.execute({ action: 'read', runId: value.runId, executionId: value.executionId }),
  { success: true, data: { kind: 'read', record: { intent: value, observation: observed } } });
});

test('failed COMMIT and failed ROLLBACK quarantine the handle instead of exposing an uncommitted confirmation', async t => {
 const { directory, storage } = await fixture(t), value = intent(), observed = observation(value);
 await storage.execute({ action: 'claim-once', intent: value });
 const db = (storage as unknown as { db: DatabaseSync }).db, exec = db.exec.bind(db);
 const record = { action: 'record-session-once', runId: value.runId, executionId: value.executionId, observation: observed };
 const read = { action: 'read', runId: value.runId, executionId: value.executionId };
 db.exec = sql => {
  if (sql === 'COMMIT' || sql === 'ROLLBACK') throw new Error('private-transaction-failure');
  return exec(sql);
 };
 assert.deepEqual(await storage.execute(record), { success: false, error: { code: 'STORAGE_FAILURE' } });
 for (const command of [read, record, { action: 'claim-once', intent: value }]) {
  assert.deepEqual(await storage.execute(command), { success: false, error: { code: 'STORAGE_FAILURE' } });
 }
 db.exec = exec;
 await storage.execute({ action: 'close' });
 const reopened = new Sprint4BootstrapStorage({ directory });
 try {
  assert.deepEqual(await reopened.execute(read), { success: true, data: { kind: 'read', record: { intent: value, observation: null } } });
 } finally { await reopened.execute({ action: 'close' }); }
});
