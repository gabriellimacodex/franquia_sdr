import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { BootstrapIntentSchema, BootstrapObservationSchema, BootstrapStorageInputSchema, type BootstrapIntent, type BootstrapObservation, type BootstrapStorageResult, type BootstrapStorageSpec } from './sprint4-bootstrap.spec.js';

type ErrorCode = Extract<BootstrapStorageResult, { success: false }>['error']['code'];
class StorageFailure extends Error { constructor(readonly code: ErrorCode) { super(code); } }
const Options = z.object({ directory: z.string().min(1), initializeNew: z.boolean().default(false) }).strict();
const filename = 'sprint4-bootstrap.sqlite', applicationId = 0x53423431;
const canonicalHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runBinding = (value: BootstrapIntent) => JSON.stringify({ planHash: value.planHash, actorUserId: value.actorUserId, target: value.target });
const matchesIntent = (intent: BootstrapIntent, observed: BootstrapObservation) => observed.intentHash === canonicalHash(intent)
 && observed.observedAtMs >= intent.createdAtMs && observed.session.versionId === intent.target.versionId
 && observed.session.label === intent.label && observed.session.scenario === intent.scenario;
function privatePath(directory: string): string {
 if (!isAbsolute(directory) || typeof process.getuid !== 'function') throw new StorageFailure('UNSAFE_STORAGE');
 const dir = lstatSync(directory), uid = process.getuid();
 if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== uid || (dir.mode & 0o7777) !== 0o700) throw new StorageFailure('UNSAFE_STORAGE');
 for (const name of readdirSync(directory)) {
  if (![filename, filename + '-journal'].includes(name)) throw new StorageFailure('UNSAFE_STORAGE');
  try {
   const file = lstatSync(join(directory, name));
   if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== uid || (file.mode & 0o7777) !== 0o600) throw new StorageFailure('UNSAFE_STORAGE');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
 }
 return join(realpathSync(directory), filename);
}

/** Dedicated local SQLite store. No credential, environment, transport, reset or deletion API. */
export class Sprint4BootstrapStorage implements BootstrapStorageSpec {
 private db: DatabaseSync | undefined; private closed = false; private initialized = false; private quarantined = false; private identity: Stats | undefined;
 constructor(private readonly options: unknown) {}
 async execute(raw: unknown): Promise<BootstrapStorageResult> {
  let transaction = false;
  try {
   const parsed = BootstrapStorageInputSchema.safeParse(raw), options = Options.safeParse(this.options);
   if (!parsed.success || !options.success) return { success: false, error: { code: 'INVALID_INPUT' } };
   if (parsed.data.action === 'close') { this.db?.close(); this.db = undefined; this.closed = true; return { success: true, data: { kind: 'closed' } }; }
   if (this.closed) return { success: false, error: { code: 'CLOSED' } };
   if (this.quarantined) return { success: false, error: { code: 'STORAGE_FAILURE' } };
   const path = privatePath(options.data.directory);
   if (!this.db) {
    if (options.data.initializeNew) {
     if (readdirSync(options.data.directory).length) throw new StorageFailure('UNSAFE_STORAGE');
     const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
     try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    privatePath(options.data.directory); this.identity = lstatSync(path);
    this.db = new DatabaseSync(path);
    if (!options.data.initializeNew && (this.db.prepare('PRAGMA application_id').get()?.application_id !== applicationId
     || this.db.prepare('PRAGMA user_version').get()?.user_version !== 1)) throw new StorageFailure('CORRUPT_STATE');
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if (options.data.initializeNew) {
     this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE runs(run_id TEXT PRIMARY KEY,binding TEXT NOT NULL) STRICT;
      CREATE TABLE intents(execution_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(run_id),request_id TEXT NOT NULL COLLATE NOCASE UNIQUE,intent_hash TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
      CREATE TABLE observations(execution_id TEXT PRIMARY KEY REFERENCES intents(execution_id),session_id TEXT NOT NULL COLLATE NOCASE UNIQUE,candidate_id TEXT NOT NULL COLLATE NOCASE UNIQUE,payload TEXT NOT NULL) STRICT;
      PRAGMA application_id=${applicationId}; PRAGMA user_version=1; COMMIT;`);
     const fd = openSync(dirname(path), constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new StorageFailure('CORRUPT_STATE');
    this.initialized = true;
   }
   const current = lstatSync(path);
   if (current.dev !== this.identity?.dev || current.ino !== this.identity?.ino) throw new StorageFailure('UNSAFE_STORAGE');
   const command = parsed.data;
   if (command.action !== 'read') { this.db.exec('BEGIN IMMEDIATE'); transaction = true; }
   const key = command.action === 'claim-once' ? command.intent : command;
   // One statement gives read a coherent snapshot even when another process appends between application steps.
   const row = this.db.prepare(`SELECT i.*,r.binding,o.execution_id AS observed_execution_id,o.session_id,o.candidate_id,o.payload AS observation_payload
    FROM (SELECT ? AS execution_id) requested LEFT JOIN intents i ON i.execution_id=requested.execution_id
    LEFT JOIN runs r ON r.run_id=i.run_id LEFT JOIN observations o ON o.execution_id=requested.execution_id`).get(key.executionId)!;
   let stored = null;
   if (row.execution_id !== null) {
    try { stored = BootstrapIntentSchema.parse(JSON.parse(String(row.payload))); } catch { throw new StorageFailure('CORRUPT_STATE'); }
    if (stored.executionId !== row.execution_id || stored.runId !== row.run_id || stored.requestId !== row.request_id
     || canonicalHash(stored) !== row.intent_hash || row.binding !== runBinding(stored)) throw new StorageFailure('CORRUPT_STATE');
    if (stored.runId !== key.runId) throw new StorageFailure('STATE_CONFLICT');
   }
   let observed = null;
   if (row.observed_execution_id !== null) {
    try { observed = BootstrapObservationSchema.parse(JSON.parse(String(row.observation_payload))); } catch { throw new StorageFailure('CORRUPT_STATE'); }
    if (!stored || !matchesIntent(stored, observed) || row.session_id !== observed.session.id
     || row.candidate_id !== observed.session.candidateId) throw new StorageFailure('CORRUPT_STATE');
   }
   if (command.action === 'read') return { success: true, data: { kind: 'read', record: stored ? { intent: stored, observation: observed } : null } };
   if (command.action === 'record-session-once') {
    if (!stored || !matchesIntent(stored, command.observation) || observed && JSON.stringify(observed) !== JSON.stringify(command.observation)) throw new StorageFailure('STATE_CONFLICT');
    if (observed) { this.db.exec('ROLLBACK'); transaction = false; return { success: true, data: { kind: 'recorded', duplicate: true } }; }
    if (this.db.prepare('SELECT execution_id FROM observations WHERE session_id=? OR candidate_id=?')
     .get(command.observation.session.id, command.observation.session.candidateId)) throw new StorageFailure('STATE_CONFLICT');
    this.db.prepare('INSERT INTO observations(execution_id,session_id,candidate_id,payload) VALUES(?,?,?,?)')
     .run(key.executionId, command.observation.session.id, command.observation.session.candidateId, JSON.stringify(command.observation));
    this.db.exec('COMMIT'); transaction = false;
    return { success: true, data: { kind: 'recorded', duplicate: false } };
   }
   if (stored) {
    if (JSON.stringify(stored) !== JSON.stringify(command.intent)) throw new StorageFailure('STATE_CONFLICT');
    this.db.exec('ROLLBACK'); transaction = false; return { success: true, data: { kind: 'claimed', claimed: false } };
   }
   const value = command.intent;
   const binding = this.db.prepare('SELECT binding FROM runs WHERE run_id=?').get(value.runId);
   if (binding && binding.binding !== runBinding(value)
    || this.db.prepare('SELECT execution_id FROM intents WHERE request_id=?').get(value.requestId)) throw new StorageFailure('STATE_CONFLICT');
   if (!binding) this.db.prepare('INSERT INTO runs(run_id,binding) VALUES(?,?)').run(value.runId, runBinding(value));
   this.db.prepare('INSERT INTO intents(execution_id,run_id,request_id,intent_hash,payload) VALUES(?,?,?,?,?)')
    .run(value.executionId, value.runId, value.requestId, canonicalHash(value), JSON.stringify(value));
   this.db.exec('COMMIT'); transaction = false;
   return { success: true, data: { kind: 'claimed', claimed: true } };
  } catch (error) {
   if (transaction) try { this.db?.exec('ROLLBACK'); } catch {
    // This connection may still expose uncommitted data. Never reuse it or reinitialize automatically.
    this.quarantined = true;
    try { this.db?.close(); this.db = undefined; } catch { /* Still quarantined if close itself fails. */ }
   }
   if (!this.initialized) { try { this.db?.close(); } catch { /* Preserve the failure. */ } this.db = undefined; }
   return { success: false, error: { code: error instanceof StorageFailure ? error.code : 'STORAGE_FAILURE' } };
  }
 }
}
