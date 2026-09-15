import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { z } from 'zod';
import { connectDatabase, scoped, type Database } from '../src/database.js';
import { CompletionSnapshot } from '../src/completion-snapshot.js';
import { LaboratoryDispatch } from '../src/laboratory-dispatch.js';
import { Store } from '../src/store.js';
import { initialSnapshot } from '../src/seed.js';
import { snapshotHash } from '../src/versioning.js';
import { createLeadState } from '../src/domain.js';
import { testConfig } from '../tests/config.js';

// Opt-in verification against a disposable LOCAL PostgreSQL. No runtime env/URL,
// user data, provider or remote schema. Every invocation creates a fresh database.
const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.SAPORE_FIXTURE_PG_PORT);
const config = { host: '127.0.0.1', port, user: 'fixture_owner', password: 'synthetic-local-owner',
  database: 'sapore_lock_fixture', connectionTimeoutMillis: 3000, statement_timeout: 5000 };
const scope = { tenantId: 'synthetic-tenant', brandId: 'synthetic-brand' };

async function fixture(work: (context: {owner: pg.Client; first: Database; second: Database; name: string}) => Promise<void>, fixtureScope = scope) {
  const control = new pg.Client(config);
  await control.connect();
  const name = 's4_lock_' + randomUUID().replaceAll('-', '');
  assert.match(name, /^s4_lock_[a-f0-9]{32}$/);
  const role = name + '_runtime';
  let owner: pg.Client | undefined;
  let first: ReturnType<typeof connectDatabase> | undefined, second: ReturnType<typeof connectDatabase> | undefined;
  try {
    assert.equal((await control.query('SELECT current_database() AS name')).rows[0].name, 'sapore_lock_fixture');
    await control.query(`CREATE DATABASE ${name}`);
    owner = new pg.Client({ ...config, database: name }); await owner.connect();
    await owner.query('CREATE SCHEMA sdr');
    const migration = await readFile(new URL('../migrations/001_sdr.sql', import.meta.url), 'utf8');
    const tables = ['brands', 'channels', 'versions', 'candidates', 'conversations', 'messages', 'jobs', 'events'];
    for (const table of tables) {
      const ddl = migration.match(new RegExp(`CREATE TABLE sdr\\.${table} \\([\\s\\S]*?\\n\\);`));
      assert.ok(ddl, 'Use exact source table definitions, not a hand-simplified fixture');
      await owner.query(ddl[0]);
    }
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-runtime' NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA sdr TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA sdr TO ${role}`);
    for (const table of tables.slice(2)) await owner.query(`ALTER TABLE sdr.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE sdr.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY brand_isolation ON sdr.${table}
      USING (tenant_id=current_setting('sdr.tenant_id',true) AND brand_id=current_setting('sdr.brand_id',true))
      WITH CHECK (tenant_id=current_setting('sdr.tenant_id',true) AND brand_id=current_setting('sdr.brand_id',true))`);
    const s = [fixtureScope.tenantId, fixtureScope.brandId];
    await owner.query('INSERT INTO sdr.brands VALUES($1,$2,$2)', s);
    await owner.query("INSERT INTO sdr.channels(phone_number_id,tenant_id,brand_id) VALUES('channel',$1,$2)", s);
    await owner.query("INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES('version',$1,$2,'fixture','{}','fixture-hash','fixture-model')", s);
    await owner.query("INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state,revision) VALUES('candidate',$1,$2,'synthetic-contact','synthetic-contact','fixture','{}',1)", s);
    await owner.query("INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) VALUES('conversation',$1,$2,'candidate','channel')", s);
    await owner.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES('input',$1,$2,'conversation','candidate','candidate','text','Mensagem fictícia',now())", s);
    await owner.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state,attempts,deadline) VALUES('job',$1,$2,'conversation','candidate','input',1,0,'version','working',1,now()+interval '10 minutes')", s);
    const url = `postgresql://${role}:synthetic-runtime@127.0.0.1:${port}/${name}`;
    first = connectDatabase(url, false); second = connectDatabase(url, false);
    const privileges = (await first.query<{rolsuper:boolean;rolbypassrls:boolean}>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(privileges, { rolsuper: false, rolbypassrls: false });
    assert.equal((await first.query('SELECT id FROM sdr.jobs')).rows.length, 0, 'RLS closes unscoped reads');
    await work({ owner, first, second, name });
  } finally {
    await first?.close(); await second?.close(); await owner?.end(); await control.end();
  }
}

test('PostgreSQL connections observe a human pause committed while the callback waits for scoped', async () => {
  await fixture(async ({ owner, first, second, name }) => {
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const writer = scoped(first, scope, async tx => {
      await tx.query("UPDATE sdr.conversations SET state='human',epoch=epoch+1 WHERE id='conversation'");
      locked(); await gate;
    });
    await Promise.race([acquired, writer]);
    let readCompleted = false;
    const reader = scoped(second, scope, async tx => {
      const result = await new CompletionSnapshot(tx, scope).execute({ jobId: 'job', contextVersion: 1 });
      readCompleted = true; return result;
    });
    try {
      // Observe actual advisory-lock contention, not an assumed fixed sleep.
      const deadline = performance.now() + 3000;
      let blocked = false;
      while (performance.now() < deadline) {
        const waits = await owner.query("SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND NOT l.granted", [name]);
        if (waits.rows[0].count > 0) { blocked = true; break; }
        await sleep(10);
      }
      assert.equal(blocked, true, 'second connection must wait on the first transaction');
      assert.equal(readCompleted, false);
    } finally { release(); }
    await writer;
    assert.deepEqual(await reader, { success: false, error: { code: 'STALE_RESULT' } });
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM sdr.messages')).rows[0].count, 1);
  });
});

test('job, conversation and candidate row locks survive the grouped read until the owning transaction commits', async () => {
  await fixture(async ({ owner, first }) => {
    let release!: () => void, loaded!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { loaded = resolve; });
    const transaction = scoped(first, scope, async tx => {
      const result = await new CompletionSnapshot(tx, scope).execute({ jobId: 'job', contextVersion: 1 });
      assert.ok(result.success);
      assert.equal(result.data.messages[0].text, 'Mensagem fictícia');
      assert.ok(result.data.job.deadline instanceof Date);
      loaded(); await gate;
    });
    await Promise.race([acquired, transaction]);
    try {
      for (const table of ['jobs', 'conversations', 'candidates']) {
        await owner.query('BEGIN');
        try {
          await assert.rejects(owner.query(`SELECT id FROM sdr.${table} FOR UPDATE NOWAIT`),
            (error: unknown) => (error as {code?: string}).code === '55P03', `${table} must be locked`);
        } finally { await owner.query('ROLLBACK'); }
      }
    } finally { release(); }
    await transaction;
    for (const table of ['jobs', 'conversations', 'candidates']) {
      await owner.query('BEGIN');
      try { assert.equal((await owner.query(`SELECT id FROM sdr.${table} FOR UPDATE NOWAIT`)).rows.length, 1); }
      finally { await owner.query('ROLLBACK'); }
    }
  });
});

test('a rolled-back concurrent pause does not leak state or locks into the later callback snapshot', async () => {
  await fixture(async ({ owner, first, second, name }) => {
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const writer = scoped(first, scope, async tx => {
      await tx.query("UPDATE sdr.conversations SET state='human',epoch=epoch+1 WHERE id='conversation'");
      await tx.query("UPDATE sdr.candidates SET lead_state='{\"marker\":\"UNCOMMITTED_CANARY\"}' WHERE id='candidate'");
      locked(); await gate; throw new Error('SYNTHETIC_ROLLBACK');
    });
    const writerOutcome = writer.then(() => 'unexpected-commit', error => (error as Error).message);
    await Promise.race([acquired, writer]);
    const reader = scoped(second, scope, tx => new CompletionSnapshot(tx, scope).execute({ jobId: 'job', contextVersion: 1 }));
    try {
      const deadline = performance.now() + 3000;
      let blocked = false;
      while (performance.now() < deadline) {
        const waits = await owner.query("SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND NOT l.granted", [name]);
        if (waits.rows[0].count > 0) { blocked = true; break; }
        await sleep(10);
      }
      assert.equal(blocked, true);
    } finally { release(); }
    assert.equal(await writerOutcome, 'SYNTHETIC_ROLLBACK');
    const result = await reader; assert.ok(result.success);
    assert.equal(result.data.conversation.state, 'automatic');
    assert.equal(result.data.conversation.epoch, 0);
    assert.deepEqual(result.data.candidate.lead_state, {});
    assert.doesNotMatch(JSON.stringify(result.data), /UNCOMMITTED_CANARY/);
  });
});

test('real PostgreSQL serializes two dispatch reservations and rechecks the committed ledger before authorizing the second', async () => {
  const pilot = { tenantId: 'cognita-homologacao', brandId: 'sapore' };
  await fixture(async ({ owner, first, second, name }) => {
    const snapshot = initialSnapshot(pilot);
    const labMigration = await readFile(new URL('../migrations/003_lab_sessions.sql', import.meta.url), 'utf8');
    const channelKindDdl = labMigration.split('\n')[0];
    assert.match(channelKindDdl, /^ALTER TABLE sdr\.channels ADD COLUMN kind /);
    await owner.query(channelKindDdl);
    await owner.query("UPDATE sdr.channels SET kind='laboratory'");
    await owner.query('UPDATE sdr.versions SET snapshot=$1,content_hash=$2,model=$3', [JSON.stringify(snapshot), snapshotHash(snapshot), snapshot.model]);
    await owner.query('UPDATE sdr.candidates SET lead_state=$1', [JSON.stringify(createLeadState(pilot.tenantId, pilot.brandId, 'candidate'))]);
    await owner.query("INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state,revision) SELECT 'candidate2',tenant_id,brand_id,'synthetic2','synthetic2','fixture2',$1,revision FROM sdr.candidates WHERE id='candidate'", [JSON.stringify(createLeadState(pilot.tenantId, pilot.brandId, 'candidate2'))]);
    await owner.query("INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) SELECT 'conversation2',tenant_id,brand_id,'candidate2',phone_number_id FROM sdr.conversations WHERE id='conversation'");
    await owner.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) SELECT 'input2',tenant_id,brand_id,'conversation2','candidate2',actor,type,text,provider_timestamp FROM sdr.messages WHERE id='input'");
    await owner.query("INSERT INTO sdr.jobs(id,tenant_id,brand_id,conversation_id,candidate_id,trigger_message_id,context_version,epoch,version_id,state,attempts,deadline) SELECT 'job2',tenant_id,brand_id,'conversation2','candidate2','input2',context_version,epoch,version_id,state,attempts,deadline FROM sdr.jobs WHERE id='job'");
    let release!: () => void, reserved!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { reserved = resolve; });
    let rankingQueries = 0;
    // pgvector is not installed in this disposable PostgreSQL image. Only ranking
    // is substituted with an empty lexical result; header/locks/context/ledger SQL
    // and both database transactions run on real, separate runtime connections.
    const prepared = (db: Database, hold: boolean): Database => ({ ...db,
      transaction: fn => db.transaction(tx => fn({ query: async <T>(sql: string, params?: unknown[]) => {
        if (sql.startsWith('WITH eligible AS MATERIALIZED')) { rankingQueries++; return { rows: [] as T[] }; }
        const result = await tx.query<T>(sql, params);
        if (hold && sql.startsWith('INSERT INTO sdr.events')) { reserved(); await gate; }
        return result;
      } })),
    });
    const channel = { ...pilot, phoneNumberId: 'channel', kind: 'laboratory' as const, enabled: false, responsibleUserId: null };
    const budgetConfig = { ...testConfig, LAB_BUDGET_LIMIT_MICRO_USD: 60_000 };
    const input = { jobId: 'job', attempt: 1, contextVersion: 1, epoch: 0, versionId: 'version' };
    const writer = new LaboratoryDispatch(prepared(first, true), channel, budgetConfig).execute(input);
    await Promise.race([acquired, writer.then(result => { assert.fail('First reservation did not reach commit barrier: ' + JSON.stringify(result)); })]);
    let finished = false;
    const contender = new LaboratoryDispatch(prepared(second, false), channel, budgetConfig).execute({ ...input, jobId: 'job2' }).then(result => { finished = true; return result; });
    try {
      const deadline = performance.now() + 3000;
      let blocked = false;
      while (performance.now() < deadline) {
        const waits = await owner.query("SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND NOT l.granted", [name]);
        if (waits.rows[0].count > 0) { blocked = true; break; }
        await sleep(10);
      }
      assert.equal(blocked, true); assert.equal(finished, false);
      assert.equal((await owner.query('SELECT id FROM sdr.events')).rows.length, 0, 'Uncommitted reservation is not visible to another connection');
    } finally { release(); }
    const accepted = await writer; assert.ok(accepted.success); assert.equal(accepted.data.kind, 'ready');
    assert.deepEqual(await contender, { success: true, data: { kind: 'paused', reason: 'LAB_BUDGET_EXHAUSTED' } });
    const ledger = (await owner.query('SELECT detail FROM sdr.events')).rows;
    assert.equal(ledger.length, 1); assert.equal(ledger[0].detail.jobId, 'job');
    assert.ok(ledger[0].detail.costMicroUsd <= 60_000 && ledger[0].detail.costMicroUsd > 30_000);
    assert.equal(rankingQueries, 2);
    const state = (await owner.query("SELECT state,error_code FROM sdr.jobs WHERE id='job2'")).rows[0];
    assert.deepEqual(state, { state: 'handoff', error_code: 'LAB_BUDGET_EXHAUSTED' });
  }, pilot);
});

const retryScope = { tenantId: 'cognita-homologacao', brandId: 'sapore' };
async function prepareRetryFixture(owner: pg.Client) {
  const snapshot = initialSnapshot(retryScope);
  const migration = await readFile(new URL('../migrations/003_lab_sessions.sql', import.meta.url), 'utf8');
  const channelKindDdl = migration.split('\n')[0];
  assert.match(channelKindDdl, /^ALTER TABLE sdr\.channels ADD COLUMN kind /);
  await owner.query(channelKindDdl);
  await owner.query("UPDATE sdr.channels SET kind='laboratory'");
  await owner.query('UPDATE sdr.versions SET snapshot=$1,content_hash=$2,model=$3',
    [JSON.stringify(snapshot), snapshotHash(snapshot), snapshot.model]);
  await owner.query('UPDATE sdr.candidates SET lead_state=$1',
    [JSON.stringify(createLeadState(retryScope.tenantId, retryScope.brandId, 'candidate'))]);
  await owner.query("UPDATE sdr.jobs SET id='channel:job',lease_until=now()-interval '1 second',available_at=now()-interval '1 minute'");
  return {
    channel: { ...retryScope, phoneNumberId: 'channel', kind: 'laboratory' as const, enabled: false, responsibleUserId: null },
    input: { jobId: 'channel:job', attempt: 1, contextVersion: 1, epoch: 0, versionId: 'version' },
  };
}

// As in the reservation test above, only pgvector ranking is replaced. The
// coordinator, claim, RLS, lock, context, reservation and COMMIT/ROLLBACK are real.
function retryDatabase(db: Database, afterQuery: (sql: string) => Promise<void> = async () => {}): Database {
  return { ...db, transaction: fn => db.transaction(tx => fn({ query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.startsWith('WITH eligible AS MATERIALIZED')) return { rows: [] as T[] };
    const result = await tx.query<T>(sql, params);
    await afterQuery(sql);
    return result;
  } })) };
}

async function assertAdvisoryWait(owner: pg.Client, name: string) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const waits = await owner.query("SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND NOT l.granted", [name]);
    if (waits.rows[0].count > 0) return;
    await sleep(10);
  }
  assert.fail('Expected real advisory-lock contention between runtime connections');
}

test('committing a reservation while reclaim waits keeps the original attempt and authorizes no second dispatch', async () => {
  await fixture(async ({ owner, first, second, name }) => {
    const { channel, input } = await prepareRetryFixture(owner);
    let release!: () => void, reserved!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { reserved = resolve; });
    const writer = new LaboratoryDispatch(retryDatabase(first, async sql => {
      if (sql.startsWith('INSERT INTO sdr.events')) { reserved(); await barrier; }
    }), channel, testConfig).execute(input);
    await Promise.race([acquired, writer.then(result => { assert.fail('Reservation barrier not reached: ' + JSON.stringify(result)); })]);
    let claimFinished = false;
    const contender = new Store(second).claim(channel).then(job => { claimFinished = true; return job; });
    try {
      await assertAdvisoryWait(owner, name);
      assert.equal(claimFinished, false);
      assert.equal((await owner.query('SELECT id FROM sdr.events')).rows.length, 0, 'Other connection cannot see the uncommitted reservation');
    } finally { release(); }
    const prepared = await writer; assert.ok(prepared.success); assert.equal(prepared.data.kind, 'ready');
    assert.equal(await contender, undefined, 'A committed reservation prohibits lease recovery, despite expired lease');
    assert.deepEqual((await owner.query('SELECT state,attempts FROM sdr.jobs')).rows, [{ state: 'working', attempts: 1 }]);
    const ledger = (await owner.query('SELECT detail FROM sdr.events')).rows;
    assert.equal(ledger.length, 1); assert.equal(ledger[0].detail.jobId, input.jobId);
    assert.equal(ledger[0].detail.attempt, 1); assert.equal(ledger[0].detail.settled, false);
    assert.equal(ledger[0].detail.costMicroUsd, ledger[0].detail.reservedMicroUsd);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM sdr.messages WHERE actor='agent'")).rows[0].count, 0);
  }, retryScope);
});

test('rolling back a reservation while reclaim waits recovers only the unreserved job and fences the old attempt', async () => {
  await fixture(async ({ owner, first, second, name }) => {
    const { channel, input } = await prepareRetryFixture(owner);
    const before = (await owner.query('SELECT context FROM sdr.jobs')).rows[0];
    let release!: () => void, reserved!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { reserved = resolve; });
    const writer = new LaboratoryDispatch(retryDatabase(first, async sql => {
      if (sql.startsWith('INSERT INTO sdr.events')) {
        reserved(); await barrier; throw new Error('SYNTHETIC_RESERVATION_ROLLBACK');
      }
    }), channel, testConfig).execute(input);
    await Promise.race([acquired, writer.then(result => { assert.fail('Reservation barrier not reached: ' + JSON.stringify(result)); })]);
    let claimFinished = false;
    const contender = new Store(second).claim(channel).then(job => { claimFinished = true; return job; });
    try {
      await assertAdvisoryWait(owner, name);
      assert.equal(claimFinished, false);
      assert.equal((await owner.query('SELECT id FROM sdr.events')).rows.length, 0);
    } finally { release(); }
    assert.deepEqual(await writer, { success: false, error: { code: 'DISPATCH_PREPARATION_FAILED' } });
    const recovered = await contender; assert.ok(recovered);
    assert.equal(recovered.id, input.jobId); assert.equal(recovered.attempts, 2); assert.equal(recovered.state, 'working');
    assert.deepEqual((await owner.query('SELECT context FROM sdr.jobs')).rows[0], before, 'Rolled-back context must not survive with the new attempt');
    assert.equal((await owner.query('SELECT id FROM sdr.events')).rows.length, 0);
    assert.deepEqual(await new LaboratoryDispatch(retryDatabase(first), channel, testConfig).execute(input),
      { success: true, data: { kind: 'ignored', reason: 'STALE_JOB' } }, 'Old worker cannot obtain a body after losing its lease');
    assert.equal((await owner.query('SELECT id FROM sdr.events')).rows.length, 0);
    const prepared = await new LaboratoryDispatch(retryDatabase(second), channel, testConfig).execute({ ...input, attempt: recovered.attempts });
    assert.ok(prepared.success); assert.equal(prepared.data.kind, 'ready');
    const ledger = (await owner.query('SELECT detail FROM sdr.events')).rows;
    assert.equal(ledger.length, 1); assert.equal(ledger[0].detail.attempt, 2); assert.equal(ledger[0].detail.jobId, input.jobId);
    assert.equal(ledger[0].detail.settled, false);
    assert.equal(ledger[0].detail.costMicroUsd, ledger[0].detail.reservedMicroUsd);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM sdr.messages WHERE actor='agent'")).rows[0].count, 0);
  }, retryScope);
});

test('reclaim committed while an old preparation waits makes that old attempt stale before any reservation', async () => {
  await fixture(async ({ owner, first, second, name }) => {
    const { channel, input } = await prepareRetryFixture(owner);
    const before = (await owner.query('SELECT context FROM sdr.jobs')).rows[0];
    let release!: () => void, claimed!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { claimed = resolve; });
    const claim = new Store(retryDatabase(first, async sql => {
      if (sql.startsWith("UPDATE sdr.jobs SET state='working'")) { claimed(); await barrier; }
    })).claim(channel);
    await Promise.race([acquired, claim.then(() => { assert.fail('Claim barrier not reached'); })]);
    let preparationFinished = false;
    const obsolete = new LaboratoryDispatch(retryDatabase(second), channel, testConfig).execute(input)
      .then(result => { preparationFinished = true; return result; });
    try {
      await assertAdvisoryWait(owner, name);
      assert.equal(preparationFinished, false);
      assert.equal((await owner.query('SELECT attempts FROM sdr.jobs')).rows[0].attempts, 1,
        'Another connection still sees the old attempt until reclaim commits');
    } finally { release(); }
    const recovered = await claim; assert.ok(recovered); assert.equal(recovered.attempts, 2);
    assert.deepEqual(await obsolete, { success: true, data: { kind: 'ignored', reason: 'STALE_JOB' } });
    assert.deepEqual((await owner.query('SELECT context FROM sdr.jobs')).rows[0], before);
    assert.equal((await owner.query('SELECT id FROM sdr.events')).rows.length, 0);
    const prepared = await new LaboratoryDispatch(retryDatabase(first), channel, testConfig).execute({ ...input, attempt: recovered.attempts });
    assert.ok(prepared.success); assert.equal(prepared.data.kind, 'ready');
    const ledger = (await owner.query('SELECT detail FROM sdr.events')).rows;
    assert.equal(ledger.length, 1); assert.equal(ledger[0].detail.attempt, 2); assert.equal(ledger[0].detail.jobId, input.jobId);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM sdr.messages WHERE actor='agent'")).rows[0].count, 0);
  }, retryScope);
});
