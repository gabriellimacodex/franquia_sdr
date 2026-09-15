import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { closeSync, constants, fsyncSync, openSync, lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { EvidenceStorageInputSchema, TerminalArtifactSchema, type TerminalArtifact, type EvidenceStorageResult, type EvidenceStorageSpec } from './sprint4-evidence.spec.js';

type ErrorCode = Extract<EvidenceStorageResult, { success: false }>['error']['code'];
class StorageFailure extends Error { constructor(readonly code: ErrorCode) { super(code); } }
const Options = z.object({ directory: z.string().min(1), initializeNew: z.boolean().default(false) }).strict();
const filename = 'sprint4-evidence.sqlite', applicationId = 0x53453431;
const runBinding = (artifact: TerminalArtifact) => JSON.stringify({ planHash: artifact.payload.planHash,
 actorUserId: artifact.payload.observation.binding.actorUserId, target: artifact.payload.observation.binding.target });
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

/** Durable artifact retention only; a digest is not a content, reviewer or publication approval. */
export class Sprint4EvidenceStorage implements EvidenceStorageSpec {
 private db: DatabaseSync | undefined; private closed = false; private quarantined = false; private initialized = false; private identity: Stats | undefined;
 constructor(private readonly options: unknown) {}
 async execute(raw: unknown): Promise<EvidenceStorageResult> {
  let transaction = false;
  try {
   const input = EvidenceStorageInputSchema.safeParse(raw), options = Options.safeParse(this.options);
   if (!input.success || !options.success) return { success: false, error: { code: 'INVALID_INPUT' } };
   if (input.data.action === 'close') { this.db?.close(); this.db = undefined; this.closed = true; return { success: true, data: { kind: 'closed' } }; }
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
    // Another process can hold a commit lock even during format inspection.
    this.db.exec('PRAGMA busy_timeout=5000;');
    if (!options.data.initializeNew && (this.db.prepare('PRAGMA application_id').get()?.application_id !== applicationId
     || this.db.prepare('PRAGMA user_version').get()?.user_version !== 1)) throw new StorageFailure('CORRUPT_STATE');
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    if (options.data.initializeNew) {
     this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE runs(run_id TEXT PRIMARY KEY,binding TEXT NOT NULL) STRICT;
      CREATE TABLE artifacts(run_id TEXT NOT NULL REFERENCES runs(run_id),turn_id TEXT NOT NULL,
       job_id TEXT NOT NULL COLLATE NOCASE UNIQUE,request_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
       reservation_id TEXT NOT NULL COLLATE NOCASE UNIQUE,payload TEXT NOT NULL,PRIMARY KEY(run_id,turn_id)) STRICT;
       PRAGMA application_id=${applicationId}; PRAGMA user_version=1; COMMIT;`);
     const fd = openSync(options.data.directory, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new StorageFailure('CORRUPT_STATE');
    this.initialized = true;
   }
   const current = lstatSync(path);
   if (current.dev !== this.identity?.dev || current.ino !== this.identity?.ino) throw new StorageFailure('UNSAFE_STORAGE');
   const command = input.data;
   const { runId, turnId } = command.action === 'read' ? command : command.artifact.payload.observation.binding;
   if (command.action !== 'read') { this.db.exec('BEGIN IMMEDIATE'); transaction = true; }
   // One SQLite statement keeps artifact and run metadata in a coherent read snapshot.
   const row = this.db.prepare('SELECT a.*,r.binding FROM artifacts a LEFT JOIN runs r ON r.run_id=a.run_id WHERE a.run_id=? AND a.turn_id=?').get(runId, turnId);
   let stored: TerminalArtifact | null = null;
   if (row) {
    try { stored = TerminalArtifactSchema.parse(JSON.parse(String(row.payload))); } catch { throw new StorageFailure('CORRUPT_STATE'); }
    const binding = stored.payload.observation.binding;
    if (binding.runId !== row.run_id || binding.turnId !== row.turn_id || binding.jobId !== row.job_id || binding.requestId !== row.request_id
     || stored.payload.observation.ledger.id !== row.reservation_id || row.binding !== runBinding(stored)) throw new StorageFailure('CORRUPT_STATE');
   }
   if (command.action === 'read') return { success: true, data: { kind: 'read', artifact: stored } };
   const artifact = command.artifact;
   if (stored) {
    if (JSON.stringify(stored) !== JSON.stringify(artifact)) throw new StorageFailure('STATE_CONFLICT');
    this.db.exec('ROLLBACK'); transaction = false;
    return { success: true, data: { kind: 'archived', duplicate: true } };
   }
   const { jobId, requestId } = artifact.payload.observation.binding, reservationId = artifact.payload.observation.ledger.id;
   const binding = this.db.prepare('SELECT binding FROM runs WHERE run_id=?').get(runId);
   if (binding && binding.binding !== runBinding(artifact) || this.db.prepare('SELECT turn_id FROM artifacts WHERE job_id=? OR request_id=? OR reservation_id=?')
    .get(jobId, requestId, reservationId)) throw new StorageFailure('STATE_CONFLICT');
   if (!binding) this.db.prepare('INSERT INTO runs(run_id,binding) VALUES(?,?)').run(runId, runBinding(artifact));
   this.db.prepare('INSERT INTO artifacts(run_id,turn_id,job_id,request_id,reservation_id,payload) VALUES(?,?,?,?,?,?)')
    .run(runId, turnId, jobId, requestId, reservationId, JSON.stringify(artifact));
   this.db.exec('COMMIT'); transaction = false;
   return { success: true, data: { kind: 'archived', duplicate: false } };
  } catch (error) {
   if (transaction) try { this.db?.exec('ROLLBACK'); } catch {
    this.quarantined = true;
    try { this.db?.close(); this.db = undefined; } catch { /* Quarantined even if closing fails. */ }
   }
   if (!this.initialized) { try { this.db?.close(); } catch { /* Preserve the initialization failure. */ } this.db = undefined; }
   return { success: false, error: { code: error instanceof StorageFailure ? error.code : 'STORAGE_FAILURE' } };
  }
 }
}
