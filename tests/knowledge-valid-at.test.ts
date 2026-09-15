import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './db-helper.js';
import { retrieveKnowledge } from '../src/knowledge.js';
import { scoped } from '../src/database.js';
import type { Queryable } from '../src/database.js';
import type { KnowledgeSource } from '../src/domain.js';

const scope = { tenantId: 'clock-fixture', brandId: 'sapore' };
const source: KnowledgeSource = { ...scope, id: 'time-bound', title: 'Fonte fictícia', content: 'Investimento fictício para avaliação.',
  status: 'approved', active: true, validFrom: '2030-01-01T00:00:00.000Z', validUntil: '2030-01-02T00:00:00.000Z', tags: [], claims: [] };
async function fixture() {
  const db = await testDatabase();
  await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2)', [scope.tenantId, scope.brandId]);
  await scoped(db, scope, async tx => {
    await tx.query("INSERT INTO sdr.versions(id,tenant_id,brand_id,label,snapshot,content_hash,model) VALUES('clock-version',$1,$2,'Clock',$3,'clock-hash','test-model')",
      [scope.tenantId, scope.brandId, JSON.stringify({ sources: [source] })]);
    await tx.query("INSERT INTO sdr.knowledge_chunks(tenant_id,brand_id,version_id,id,title,content,approved,active,valid_from,valid_until,metadata) VALUES($1,$2,'clock-version',$3,$4,$5,true,true,$6,$7,$8)",
      [scope.tenantId, scope.brandId, source.id, source.title, source.content, source.validFrom, source.validUntil, JSON.stringify({ sourceId: source.id })]);
  });
  return db;
}

test('explicit validAt includes validFrom equality in both canonical and indexed source filters', async () => {
  const db = await fixture();
  try {
    const result = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, 'clock-version', 'Investimento', undefined, source.validFrom));
    assert.equal(result.mode, 'lexical');
    assert.deepEqual(result.sources.map(item => item.id), [source.id]);
  } finally { await db.close(); }
});

test('explicit validAt excludes validUntil equality and includes the preceding millisecond', async () => {
  const db = await fixture();
  try {
    const before = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, 'clock-version', 'Investimento', undefined, '2030-01-01T23:59:59.999Z'));
    assert.deepEqual(before.sources.map(item => item.id), [source.id]);
    const boundary = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, 'clock-version', 'Investimento', undefined, source.validUntil!));
    assert.deepEqual(boundary.sources, []);
    assert.deepEqual(boundary.excludedSources, [{ id: source.id, title: source.title, reason: 'expired' }]);
  } finally { await db.close(); }
});

test('invalid explicit clock fails closed before any query', async () => {
  let queries = 0;
  const db: Queryable = { async query() { queries++; throw new Error('must not query'); } };
  for (const time of ['not-a-date', '2030-01-01', '2030-02-30T00:00:00.000Z', '2030-01-01T00:00:00', '']) {
    assert.deepEqual(await retrieveKnowledge(db, scope, 'clock-version', 'Investimento', undefined, time),
      { sources: [], excludedSources: [], mode: 'unavailable', error: 'RETRIEVAL_FAILED' });
  }
  assert.equal(queries, 0);
});

test('omitting validAt preserves the legacy two SQL statements and seven ranking parameters', async () => {
  const commands: { sql: string; params?: unknown[] }[] = [];
  const db: Queryable = { async query<T>(sql: string, params?: unknown[]) {
    commands.push({ sql, params });
    return { rows: (sql.startsWith('SELECT snapshot') ? [{ snapshot: { sources: [source] } }] : []) as T[] };
  } };
  const omitted = await retrieveKnowledge(db, scope, 'clock-version', 'Investimento');
  const baseline = structuredClone(commands); commands.length = 0;
  const explicitUndefined = await retrieveKnowledge(db, scope, 'clock-version', 'Investimento', undefined, undefined);
  assert.deepEqual(explicitUndefined, omitted);
  assert.deepEqual(commands, baseline);
  assert.equal(commands.length, 2);
  assert.equal(commands[1].params?.length, 7);
  assert.match(commands[1].sql, /k\.valid_from<=now\(\) AND \(k\.valid_until IS NULL OR k\.valid_until>now\(\)\)/);
  assert.equal(commands[1].sql.includes('$8'), false);
});

test('explicit time is finite before I/O and normalizes offset/submillisecond precision to the same JS/SQL instant', async () => {
  const commands: { sql: string; params?: unknown[] }[] = [];
  const db: Queryable = { async query<T>(sql: string, params?: unknown[]) {
    commands.push({ sql, params });
    return { rows: (sql.startsWith('SELECT snapshot') ? [{ snapshot: { sources: [source] } }]
      : [{ source_id: source.id, content: source.content, semantic_used: false }]) as T[] };
  } };
  assert.deepEqual(await retrieveKnowledge(db, scope, 'clock-version', 'Investimento', undefined, '2030-01-01T00:00:00+99:99'),
    { sources: [], excludedSources: [], mode: 'unavailable', error: 'RETRIEVAL_FAILED' });
  assert.equal(commands.length, 0);
  const result = await retrieveKnowledge(db, scope, 'clock-version', 'Investimento', undefined, '2030-01-01T03:00:00.0009+03:00');
  assert.deepEqual(result.sources.map(item => item.id), [source.id]);
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].params?.[4], [source.id], 'canonical JS filter includes validFrom equality');
  assert.equal(commands[1].params?.[7], source.validFrom, 'SQL receives the same millisecond instant, not the unnormalized input');
});
