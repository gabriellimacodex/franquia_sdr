import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, stat, mkdir, symlink, link, rename, copyFile, readFile, open, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sprint4EvidenceStorage } from '../evaluations/sprint4-evidence-storage.js';
import { TerminalArtifactSchema, terminalEvidenceHash, type TerminalArtifact } from '../evaluations/sprint4-evidence.spec.js';
import { evidenceFixture } from './sprint4-evidence-fixture.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(t: TestContext) {
 const directory = await mkdtemp(join(tmpdir(), 'sprint4-evidence-storage-'));
 const storage = new Sprint4EvidenceStorage({ directory, initializeNew: true });
 t.after(async () => { await storage.execute({ action: 'close' }); await rm(directory, { recursive: true, force: true }); });
 return { directory, storage, file: join(directory, 'sprint4-evidence.sqlite') };
}
function changed(edit: (artifact: TerminalArtifact) => void): TerminalArtifact {
 const artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact); edit(artifact);
 artifact.sha256 = terminalEvidenceHash(artifact.payload); artifact.ref = 'terminal-sha256:' + artifact.sha256;
 return TerminalArtifactSchema.parse(artifact);
}
function nextArtifact(edit: (artifact: TerminalArtifact) => void = () => {}): TerminalArtifact {
 return changed(value => {
  const { observation: o, admission: a } = value.payload;
  o.binding.turnId += '-next'; a.turnId = o.binding.turnId;
  o.binding.requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; a.requestId = o.binding.requestId;
  o.binding.jobId += '-next'; o.job.id = o.binding.jobId; o.guard.detail.jobId = o.binding.jobId;
  o.ledger.detail.jobId = o.binding.jobId; o.ledger.id += '-next'; o.preparation.reservationId = o.ledger.id;
  o.input.id = o.binding.sessionId + ':' + o.binding.requestId; o.job.trigger_message_id = o.input.id;
  o.response[0].id = o.binding.jobId + ':reply:0'; edit(value);
  // Keep negative storage-identity fixtures valid under the shared artifact cross-binding contract.
  a.turnId = o.binding.turnId; a.actorUserId = o.binding.actorUserId; a.requestId = o.binding.requestId; a.target = structuredClone(o.binding.target);
  o.job.id = o.binding.jobId; o.job.version_id = o.binding.target.versionId; o.guard.detail.jobId = o.binding.jobId;
  o.guard.detail.versionId = o.binding.target.versionId; o.ledger.detail.jobId = o.binding.jobId; o.preparation.reservationId = o.ledger.id;
  o.input.id = o.binding.sessionId + ':' + o.binding.requestId; o.job.trigger_message_id = o.input.id;
  o.response[0].id = o.binding.jobId + ':reply:0';
 });
}

test('a terminal artifact is committed before acknowledgment and survives close and reopen unchanged', async t => {
 const { directory, storage } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
 const { runId, turnId } = artifact.payload.observation.binding, read = { action: 'read', runId, turnId };
 assert.deepEqual(await storage.execute(read), { success: true, data: { kind: 'read', artifact: null } });
 assert.deepEqual(await storage.execute({ action: 'archive-once', artifact }), { success: true, data: { kind: 'archived', duplicate: false } });
 const observer = new Sprint4EvidenceStorage({ directory });
 try { assert.deepEqual(await observer.execute(read), { success: true, data: { kind: 'read', artifact } }); }
 finally { await observer.execute({ action: 'close' }); }
 await storage.execute({ action: 'close' });
 const reopened = new Sprint4EvidenceStorage({ directory });
 try { assert.deepEqual(await reopened.execute(read), { success: true, data: { kind: 'read', artifact } }); }
 finally { await reopened.execute({ action: 'close' }); }
});

test('failed rollback quarantines even an unclosable handle; reopening resolves both lost COMMIT acknowledgments and uncommitted writes', async t => {
 for (const committed of [false, true]) {
  const { directory, storage } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
  const { runId, turnId } = artifact.payload.observation.binding, read = { action: 'read', runId, turnId };
  await storage.execute(read);
  const db = (storage as unknown as { db: DatabaseSync }).db, exec = db.exec.bind(db), close = db.close.bind(db);
  db.exec = sql => {
   if (sql === 'COMMIT') { if (committed) exec(sql); throw new Error('private-commit-canary'); }
   if (sql === 'ROLLBACK') throw new Error('private-rollback-canary');
   return exec(sql);
  };
  db.close = () => { throw new Error('private-close-canary'); };
  assert.deepEqual(await storage.execute({ action: 'archive-once', artifact }), { success: false, error: { code: 'STORAGE_FAILURE' } });
  assert.deepEqual(await storage.execute(read), { success: false, error: { code: 'STORAGE_FAILURE' } });
  assert.deepEqual(await storage.execute({ action: 'archive-once', artifact }), { success: false, error: { code: 'STORAGE_FAILURE' } });
  db.exec = exec; db.close = close; await storage.execute({ action: 'close' });
  const reopened = new Sprint4EvidenceStorage({ directory });
  try {
   assert.deepEqual(await reopened.execute(read), { success: true, data: { kind: 'read', artifact: committed ? artifact : null } });
   if (committed) assert.deepEqual(await reopened.execute({ action: 'archive-once', artifact }), { success: true, data: { kind: 'archived', duplicate: true } });
  } finally { await reopened.execute({ action: 'close' }); }
 }
});

test('reopening never creates missing storage, migrates foreign SQLite or reinitializes an existing archive', async t => {
 const { directory, storage, file } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
 const { runId, turnId } = artifact.payload.observation.binding, read = { action: 'read', runId, turnId };
 const absent = new Sprint4EvidenceStorage({ directory });
 assert.equal((await absent.execute(read)).success, false); assert.deepEqual(await readdir(directory), []); await absent.execute({ action: 'close' });
 await storage.execute({ action: 'archive-once', artifact }); await storage.execute({ action: 'close' });
 const before = await readFile(file), reset = new Sprint4EvidenceStorage({ directory, initializeNew: true });
 assert.deepEqual(await reset.execute(read), { success: false, error: { code: 'UNSAFE_STORAGE' } }); await reset.execute({ action: 'close' });
 assert.deepEqual(await readFile(file), before);
 const foreignDirectory = await mkdtemp(join(tmpdir(), 'sprint4-evidence-foreign-')); t.after(() => rm(foreignDirectory, { recursive: true, force: true }));
 const foreignFile = join(foreignDirectory, 'sprint4-evidence.sqlite'), fd = await open(foreignFile, 'wx', 0o600); await fd.close();
 const db = new DatabaseSync(foreignFile); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE unrelated(value TEXT)'); db.close();
 const foreignBefore = await readFile(foreignFile), foreign = new Sprint4EvidenceStorage({ directory: foreignDirectory });
 try {
  assert.deepEqual(await foreign.execute(read), { success: false, error: { code: 'CORRUPT_STATE' } });
  assert.deepEqual(await foreign.execute(read), { success: false, error: { code: 'CORRUPT_STATE' } });
 } finally { await foreign.execute({ action: 'close' }); }
 assert.deepEqual(await readFile(foreignFile), foreignBefore);
});

test('corrupt JSON, altered digests, index bindings and orphaned run bindings cannot be read or replayed as intact evidence', async t => {
 const { storage } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
 const { runId, turnId } = artifact.payload.observation.binding, read = { action: 'read', runId, turnId };
 await storage.execute({ action: 'archive-once', artifact });
 const db = (storage as unknown as { db: DatabaseSync }).db;
 const corrupt = { success: false, error: { code: 'CORRUPT_STATE' } };
 for (const payload of ['{}', JSON.stringify({ ...artifact, sha256: 'b'.repeat(64) })]) {
  db.prepare('UPDATE artifacts SET payload=?').run(payload);
  assert.deepEqual(await storage.execute(read), corrupt);
  assert.deepEqual(await storage.execute({ action: 'archive-once', artifact }), corrupt);
 }
 db.prepare('UPDATE artifacts SET payload=?').run(JSON.stringify(artifact));
 for (const [column, original] of [['job_id', artifact.payload.observation.binding.jobId], ['request_id', artifact.payload.observation.binding.requestId], ['reservation_id', artifact.payload.observation.ledger.id]]) {
  db.prepare(`UPDATE artifacts SET ${column}=?`).run('different');
  assert.deepEqual(await storage.execute(read), corrupt); db.prepare(`UPDATE artifacts SET ${column}=?`).run(original);
 }
 db.exec("UPDATE runs SET binding='{}'"); assert.deepEqual(await storage.execute(read), corrupt);
 db.exec('PRAGMA foreign_keys=OFF; DELETE FROM runs'); assert.deepEqual(await storage.execute(read), corrupt);
});

test('private paths reject loose permissions, symlinks, hardlinks, unrelated entries and replaced database inodes', async t => {
 const { directory, storage, file } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
 const { runId, turnId } = artifact.payload.observation.binding, read = { action: 'read', runId, turnId }, unsafe = { success: false, error: { code: 'UNSAFE_STORAGE' } };
 await chmod(directory, 0o755); assert.deepEqual(await storage.execute(read), unsafe); await chmod(directory, 0o700);
 assert.ok((await storage.execute({ action: 'archive-once', artifact })).success);
 assert.equal((await stat(file)).mode & 0o7777, 0o600);
 await chmod(file, 0o644); assert.deepEqual(await storage.execute(read), unsafe); await chmod(file, 0o600);
 const outside = await mkdtemp(join(tmpdir(), 'sprint4-evidence-links-')); t.after(() => rm(outside, { recursive: true, force: true }));
 await symlink(directory, join(outside, 'alias'));
 const alias = new Sprint4EvidenceStorage({ directory: join(outside, 'alias') });
 assert.deepEqual(await alias.execute(read), unsafe); await alias.execute({ action: 'close' });
 await link(file, join(outside, 'hard-link')); assert.deepEqual(await storage.execute(read), unsafe); await rm(join(outside, 'hard-link'));
 await mkdir(join(outside, 'private'), { mode: 0o700 }); await symlink(file, join(outside, 'private', 'sprint4-evidence.sqlite'));
 const symlinked = new Sprint4EvidenceStorage({ directory: join(outside, 'private') });
 assert.deepEqual(await symlinked.execute(read), unsafe); await symlinked.execute({ action: 'close' });
 await mkdir(join(directory, 'foreign-entry'), { mode: 0o700 }); assert.deepEqual(await storage.execute(read), unsafe); await rm(join(directory, 'foreign-entry'), { recursive: true });
 await rename(file, join(outside, 'original.sqlite')); await copyFile(join(outside, 'original.sqlite'), file);
 assert.deepEqual(await storage.execute(read), unsafe);
 assert.deepEqual(await new Sprint4EvidenceStorage({ directory: '.' }).execute(read), unsafe);
});

test('run binding and globally unique job, request and reservation IDs prevent reusing an artifact across turns', async t => {
 const { storage } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact), original = artifact.payload.observation.binding;
 assert.ok((await storage.execute({ action: 'archive-once', artifact })).success);
 for (const value of [
  nextArtifact(v => { v.payload.planHash = 'b'.repeat(64); }),
  nextArtifact(v => { v.payload.observation.binding.actorUserId = 'other-admin'; v.payload.admission.actorUserId = 'other-admin'; }),
  nextArtifact(v => { v.payload.observation.binding.target.versionId = 'other-version'; v.payload.admission.target.versionId = 'other-version'; v.payload.observation.job.version_id = 'other-version'; }),
  nextArtifact(v => { v.payload.observation.binding.requestId = original.requestId; v.payload.admission.requestId = original.requestId; }),
  nextArtifact(v => { v.payload.observation.binding.jobId = original.jobId; v.payload.observation.job.id = original.jobId; }),
  nextArtifact(v => { v.payload.observation.ledger.id = artifact.payload.observation.ledger.id; v.payload.observation.preparation.reservationId = v.payload.observation.ledger.id; }),
  changed(v => { v.payload.observation.binding.runId = 'other-run'; }),
 ]) assert.deepEqual(await storage.execute({ action: 'archive-once', artifact: value }), { success: false, error: { code: 'STATE_CONFLICT' } });
 const next = nextArtifact();
 assert.deepEqual(await storage.execute({ action: 'archive-once', artifact: next }), { success: true, data: { kind: 'archived', duplicate: false } });
 const caseVariant = nextArtifact(v => { v.payload.observation.binding.turnId += '-upper'; v.payload.admission.turnId = v.payload.observation.binding.turnId;
  v.payload.observation.binding.jobId += '-upper'; v.payload.observation.job.id = v.payload.observation.binding.jobId; v.payload.observation.ledger.id += '-upper';
  v.payload.observation.binding.requestId = v.payload.observation.binding.requestId.toUpperCase(); v.payload.admission.requestId = v.payload.observation.binding.requestId; });
 assert.deepEqual(await storage.execute({ action: 'archive-once', artifact: caseVariant }), { success: false, error: { code: 'STATE_CONFLICT' } });
});

test('archive-once accepts exact canonical replay but never overwrites a differing artifact for the same turn', async t => {
 const { storage } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
 assert.ok((await storage.execute({ action: 'archive-once', artifact })).success);
 assert.deepEqual(await storage.execute({ action: 'archive-once', artifact: Object.fromEntries(Object.entries(artifact).reverse()) }),
  { success: true, data: { kind: 'archived', duplicate: true } });
 const different = changed(value => { value.payload.observation.observedAt = new Date(4000).toISOString(); });
 assert.deepEqual(await storage.execute({ action: 'archive-once', artifact: different }), { success: false, error: { code: 'STATE_CONFLICT' } });
 assert.deepEqual(await storage.execute({ action: 'read', ...artifact.payload.observation.binding, turnId: artifact.payload.observation.binding.turnId }),
  { success: false, error: { code: 'INVALID_INPUT' } }, 'strict read DTO does not accept unrelated metadata');
 const { runId, turnId } = artifact.payload.observation.binding;
 assert.deepEqual(await storage.execute({ action: 'read', runId, turnId }), { success: true, data: { kind: 'read', artifact } });
});

test('competing processes cannot replace the winning artifact and SIGKILL after acknowledgment preserves its bytes', { timeout: 15000 }, async t => {
 const { directory, storage } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
 const { runId, turnId } = artifact.payload.observation.binding, read = { action: 'read', runId, turnId };
 await storage.execute(read); await storage.execute({ action: 'close' });
 const alternative = changed(a => { a.payload.observation.observedAt = new Date(4000).toISOString(); });
 const script = `import { Sprint4EvidenceStorage } from ${JSON.stringify(new URL('../evaluations/sprint4-evidence-storage.ts', import.meta.url).href)};
 const store = new Sprint4EvidenceStorage({directory:process.argv[1]});
 const result = await store.execute({action:'archive-once',artifact:JSON.parse(process.argv[2])});
 process.send(result); setInterval(()=>{},1000);`;
 const children = [artifact, alternative].map(a => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory, JSON.stringify(a)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
 t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
 const results = await Promise.all(children.map(child => new Promise<unknown>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Child artifact acknowledgment timeout')), 10000);
  child.once('message', message => { clearTimeout(timer); resolve(message); });
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', () => { clearTimeout(timer); reject(new Error('Child exited before acknowledgment')); });
 })));
 const success = { success: true, data: { kind: 'archived', duplicate: false } }, conflict = { success: false, error: { code: 'STATE_CONFLICT' } };
 const winner = results.findIndex(result => JSON.stringify(result) === JSON.stringify(success)); assert.ok(winner >= 0);
 assert.deepEqual(results[1-winner], conflict);
 for (const child of children) { const exited = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL'); }
 const reopened = new Sprint4EvidenceStorage({ directory });
 try {
  const expected = [artifact, alternative][winner];
  assert.deepEqual(await reopened.execute(read), { success: true, data: { kind: 'read', artifact: expected } });
  assert.deepEqual(await reopened.execute({ action: 'archive-once', artifact: expected }), { success: true, data: { kind: 'archived', duplicate: true } });
  assert.deepEqual(await reopened.execute({ action: 'archive-once', artifact: [artifact, alternative][1-winner] }), conflict);
 } finally { await reopened.execute({ action: 'close' }); }
});

test('reopen applies its bounded lock wait before reading SQLite format metadata', { timeout: 15000 }, async t => {
 const { directory, storage, file } = await fixture(t), artifact = TerminalArtifactSchema.parse(evidenceFixture().artifact);
 const { runId, turnId } = artifact.payload.observation.binding;
 assert.ok((await storage.execute({action:'archive-once',artifact})).success);await storage.execute({action:'close'});
 const script = `import {DatabaseSync} from 'node:sqlite';
 const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.send('locked');
 setTimeout(()=>{db.exec('ROLLBACK');db.close();},300);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script,file],{stdio:['ignore','ignore','pipe','ipc']});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}});
 const exited=once(child,'exit');assert.deepEqual(await once(child,'message'),['locked',undefined]);
 const reopened=new Sprint4EvidenceStorage({directory});
 try{assert.deepEqual(await reopened.execute({action:'read',runId,turnId}),{success:true,data:{kind:'read',artifact}});}
 finally{await reopened.execute({action:'close'});}
 const [code]=await exited;assert.equal(code,0);
});
