import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { scoped, type Queryable } from '../src/database.js';
import { CompletionSnapshot } from '../src/completion-snapshot.js';
import { testDatabase } from './db-helper.js';
import { seedPilot } from '../src/seed.js';
import { Store } from '../src/store.js';
import { LabSessions } from '../src/lab-sessions.js';

async function fixture() {
  const db = await testDatabase();
  await seedPilot(db, { testers: [{ contactId: '5511999999999', label: 'Offline' }] });
  const user = { tenantId: 'cognita-homologacao', brandId: 'sapore', userId: 'offline-tester', role: 'tester' };
  const sessions = new LabSessions(db), store = new Store(db);
  const session = await sessions.create(user, { requestId: randomUUID(), label: 'Snapshot fictício', scenario: 'free' });
  assert.ok(session.ok);
  const sent = await sessions.send(user, session.value.id, { requestId: randomUUID(), text: 'Quero avaliar uma loja em Vila Aurora.' });
  assert.ok(sent.ok); assert.ok(sent.value.jobId);
  const channel = await store.scopeForJob(sent.value.jobId), job = await store.claim(channel); assert.ok(job);
  return { db, user, job, session: session.value, input: { jobId: job.id, contextVersion: job.context_version } };
}

// The callback's current five reads, intentionally separate from the prototype SQL.
async function reference(tx: Queryable, f: Awaited<ReturnType<typeof fixture>>) {
  const s = [f.user.tenantId, f.user.brandId];
  const job = (await tx.query<Record<string, unknown>>('SELECT * FROM sdr.jobs WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE', [...s, f.job.id])).rows[0];
  const conversation = (await tx.query('SELECT * FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE', [...s, job.conversation_id])).rows[0];
  const candidate = (await tx.query('SELECT * FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 FOR UPDATE', [...s, job.candidate_id])).rows[0];
  const version = (await tx.query('SELECT snapshot FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3', [...s, job.version_id])).rows[0];
  const messages = (await tx.query('SELECT id,text,actor,conversation_id,provider_timestamp FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2 AND candidate_id=$3', [...s, job.candidate_id])).rows;
  return { job, conversation, candidate, version, messages };
}

test('one scoped command preserves the five-read callback snapshot and native Date values', async () => {
  const f = await fixture();
  try {
    await scoped(f.db, f.user, async tx => {
      const commands: { sql: string; params?: unknown[] }[] = [];
      const counted: Queryable = { query: async <T>(sql: string, params?: unknown[]) => { commands.push({ sql, params }); return tx.query<T>(sql, params); } };
      const expected = await reference(counted, f); assert.equal(commands.length, 5); commands.length = 0;
      const result = await new CompletionSnapshot(counted, f.user).execute(f.input);
      assert.ok(result.success);
      assert.equal(commands.length, 1);
      assert.deepEqual(result.data, expected);
      assert.ok(result.data.job.deadline instanceof Date);
      assert.ok(result.data.messages[0].provider_timestamp instanceof Date);
      assert.deepEqual(commands[0].params, [f.user.tenantId, f.user.brandId, f.job.id]);
      assert.equal(commands[0].sql.includes(f.job.id), false, 'identifiers remain parameters, never SQL interpolation');
    });
  } finally { await f.db.close(); }
});

test('an absent job returns JOB_NOT_FOUND without exposing another snapshot', async () => {
  const f = await fixture();
  try {
    const result = await scoped(f.db, f.user, tx => new CompletionSnapshot(tx, f.user).execute({ ...f.input, jobId: "missing' OR true--" }));
    assert.deepEqual(result, { success: false, error: { code: 'JOB_NOT_FOUND' } });
  } finally { await f.db.close(); }
});

test('the port rejects an absent or different transaction scope even for a privileged connection', async () => {
  const f = await fixture();
  try {
    const outside = await f.db.transaction(tx => new CompletionSnapshot(tx, f.user).execute(f.input));
    assert.deepEqual(outside, { success: false, error: { code: 'SCOPE_MISMATCH' } });
    for (const wrong of [{ ...f.user, tenantId: 'other-tenant' }, { ...f.user, brandId: 'other-brand' }]) {
      const result = await scoped(f.db, f.user, tx => new CompletionSnapshot(tx, wrong).execute(f.input));
      assert.deepEqual(result, outside);
    }
  } finally { await f.db.close(); }
});

test('stale context is rejected before decoding snapshot, lead memory or message contents', async () => {
  const f = await fixture();
  try {
    const result = await scoped(f.db, f.user, tx => {
      const poisoned: Queryable = { query: async <T>(sql: string, params?: unknown[]) => {
        const loaded = await tx.query<Record<string, unknown>>(sql, params);
        return { rows: loaded.rows.map(row => ({ ...row, version: null, messages: 'invalid',
          candidate: { ...(row.candidate as object), lead_state: null } })) as T[] };
      } };
      return new CompletionSnapshot(poisoned, f.user).execute({ ...f.input, contextVersion: f.input.contextVersion + 1 });
    });
    assert.deepEqual(result, { success: false, error: { code: 'STALE_RESULT' } });
  } finally { await f.db.close(); }
});

test('job state, candidate revision, conversation epoch/ownership and deadline preserve the callback eligibility predicate', async () => {
  const f = await fixture();
  try {
    await scoped(f.db, f.user, async tx => {
      const cases = [
        "UPDATE sdr.jobs SET state='completed'",
        'UPDATE sdr.candidates SET revision=revision+1',
        'UPDATE sdr.conversations SET epoch=epoch+1',
        "UPDATE sdr.conversations SET state='human'",
        "UPDATE sdr.conversations SET state='stopped'",
        "UPDATE sdr.jobs SET deadline=to_timestamp(0)",
      ];
      for (const sql of cases) {
        await tx.query('SAVEPOINT fixture_change');
        await tx.query(sql); // Ephemeral fixture only, never a production database.
        assert.deepEqual(await new CompletionSnapshot(tx, f.user).execute(f.input),
          { success: false, error: { code: 'STALE_RESULT' } }, sql);
        await tx.query('ROLLBACK TO SAVEPOINT fixture_change');
      }
    });
  } finally { await f.db.close(); }
});

test('the actual SQL plan materializes dependent row locks in job, conversation, candidate order after scoped', async () => {
  const f = await fixture();
  try {
    await scoped(f.db, f.user, async tx => {
      let statement = '', values: unknown[] | undefined;
      const observed: Queryable = { query: async <T>(sql: string, params?: unknown[]) => { statement = sql; values = params; return tx.query<T>(sql, params); } };
      assert.ok((await new CompletionSnapshot(observed, f.user).execute(f.input)).success);
      const explain = (await tx.query<Record<string, unknown>>('EXPLAIN (FORMAT JSON) ' + statement, values)).rows[0]['QUERY PLAN'];
      const nodes: Record<string, unknown>[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node && typeof node === 'object') { nodes.push(node as Record<string, unknown>); Object.values(node).forEach(walk); }
      };
      walk(explain);
      const locks = nodes.filter(node => node['Node Type'] === 'LockRows');
      assert.deepEqual(locks.map(node => node['Subplan Name']), ['CTE locked_job', 'CTE locked_conversation', 'CTE locked_candidate']);
      assert.match(JSON.stringify(locks[1]), /"CTE Name":"locked_job"/);
      assert.match(JSON.stringify(locks[2]), /"CTE Name":"locked_conversation"/);
      assert.equal(statement.includes('pg_advisory'), false, 'scope lock must stay in the preceding statement, not share this MVCC snapshot');
      assert.deepEqual((await tx.query("SELECT current_setting('sdr.tenant_id') AS tenant,current_setting('sdr.brand_id') AS brand")).rows,
        [{ tenant: f.user.tenantId, brand: f.user.brandId }]);
    });
  } finally { await f.db.close(); }
});

test('candidate-wide history is retained while colliding foreign-tenant IDs never enter the snapshot', async () => {
  const f = await fixture();
  try {
    await seedPilot(f.db, { tenantId: 'foreign-tenant', testers: [{ contactId: '5511888888888', label: 'Foreign fixture' }] });
    const s = [f.user.tenantId, f.user.brandId, 'foreign-tenant'];
    await f.db.query(`INSERT INTO sdr.candidates(id,tenant_id,brand_id,contact_id,authorized_contact_id,label,lead_state,revision)
      SELECT id,$3,brand_id,contact_id,authorized_contact_id,'FOREIGN_CANARY',jsonb_set(lead_state,'{tenantId}',to_jsonb($3::text)),revision
      FROM sdr.candidates WHERE tenant_id=$1 AND brand_id=$2`, s);
    await f.db.query(`INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id)
      SELECT id,$3,brand_id,candidate_id,'lab-'||md5($3||':'||brand_id) FROM sdr.conversations WHERE tenant_id=$1 AND brand_id=$2`, s);
    await f.db.query(`INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp)
      SELECT id,$3,brand_id,conversation_id,candidate_id,actor,type,'FOREIGN_CANARY',provider_timestamp
      FROM sdr.messages WHERE tenant_id=$1 AND brand_id=$2`, s);
    const historyId = randomUUID();
    await f.db.query('INSERT INTO sdr.conversations(id,tenant_id,brand_id,candidate_id,phone_number_id) VALUES($3,$1,$2,$4,$5)',
      [f.user.tenantId, f.user.brandId, historyId, f.job.candidate_id, f.job.id.split(':')[0]]);
    await f.db.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'human','text','Histórico legítimo da mesma candidata',$6)",
      [f.user.tenantId, f.user.brandId, 'own-history', historyId, f.job.candidate_id, '2026-09-11T19:00:00.123456-03:00']);
    await scoped(f.db, f.user, async tx => {
      const expected = await reference(tx, f), result = await new CompletionSnapshot(tx, f.user).execute(f.input); assert.ok(result.success);
      const sort = (messages: typeof result.data.messages) => [...messages].sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(sort(result.data.messages), sort(expected.messages as typeof result.data.messages));
      assert.deepEqual(new Set(result.data.messages.map(message => message.id)), new Set([f.job.trigger_message_id, 'own-history']));
      assert.equal(result.data.messages.find(message => message.id === 'own-history')?.provider_timestamp.toISOString(), '2026-09-11T22:00:00.123Z');
      assert.doesNotMatch(JSON.stringify(result.data), /FOREIGN_CANARY/);
    });
    const foreign = { tenantId: 'foreign-tenant', brandId: f.user.brandId };
    assert.deepEqual(await scoped(f.db, foreign, tx => new CompletionSnapshot(tx, foreign).execute(f.input)),
      { success: false, error: { code: 'JOB_NOT_FOUND' } });
  } finally { await f.db.close(); }
});

test('deadline equality is eligible and the application clock is read after the locked command returns', async () => {
  const f = await fixture();
  try {
    await scoped(f.db, f.user, async tx => {
      await tx.query("UPDATE sdr.jobs SET state='running' WHERE id=$1", [f.job.id]);
      let clockValue = new Date(f.job.deadline);
      assert.ok((await new CompletionSnapshot(tx, f.user, () => clockValue).execute(f.input)).success);
      const delayed: Queryable = { query: async <T>(sql: string, params?: unknown[]) => {
        const result = await tx.query<T>(sql, params);
        clockValue = new Date(f.job.deadline.getTime() + 1);
        return result;
      } };
      assert.deepEqual(await new CompletionSnapshot(delayed, f.user, () => clockValue).execute(f.input),
        { success: false, error: { code: 'STALE_RESULT' } });
    });
  } finally { await f.db.close(); }
});

test('invalid commands are rejected before I/O and adapter failures never disclose their details', async () => {
  let queries = 0;
  const tx: Queryable = { query: async () => { queries++; throw new Error('synthetic-private-connection-details'); } };
  const port = new CompletionSnapshot(tx, { tenantId: 'tenant', brandId: 'brand' });
  for (const invalid of [null, { jobId: '', contextVersion: 1 }, { jobId: 'job', contextVersion: 1.5 },
    { jobId: 'job', contextVersion: 1, tenantId: 'foreign' }]) {
    assert.deepEqual(await port.execute(invalid), { success: false, error: { code: 'INVALID_INPUT' } });
  }
  assert.equal(queries, 0);
  assert.deepEqual(await port.execute({ jobId: 'job', contextVersion: 1 }), { success: false, error: { code: 'READ_FAILED' } });
  assert.equal(queries, 1);
});
