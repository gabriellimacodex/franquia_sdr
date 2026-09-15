import assert from 'node:assert/strict';
import test from 'node:test';
import { testDatabase } from './db-helper.js';
import { scoped, type Database, type Scope } from '../src/database.js';
import { retrieveKnowledge, buildEmbedding, indexVersionKnowledge } from '../src/knowledge.js';
import { evaluationSource } from '../evaluations/scenarios.js';
import type { KnowledgeSource } from '../src/domain.js';

const scope: Scope = { tenantId: 'knowledge-test', brandId: 'sapore' };
const source = (id: string, changes: Partial<KnowledgeSource> = {}): KnowledgeSource => ({ ...evaluationSource, ...scope, id, title: id, validFrom: '2020-01-01T00:00:00.000Z', validUntil: null, ...changes });
async function seedVersion(db: Database, target: Scope, id: string, sources: KnowledgeSource[]) {
  await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2) ON CONFLICT DO NOTHING', [target.tenantId, target.brandId]);
  await scoped(db, target, async tx => {
    await tx.query('INSERT INTO sdr.versions(tenant_id,brand_id,id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$3,$4,$3,$5)', [target.tenantId, target.brandId, id, JSON.stringify({ sources }), 'test-model']);
    for (const item of sources) await tx.query('INSERT INTO sdr.knowledge_chunks(tenant_id,brand_id,version_id,id,title,content,approved,active,valid_from,metadata) VALUES($1,$2,$3,$4,$4,$5,true,true,$6,$7)', [target.tenantId, target.brandId, id, item.id, item.content, '2020-01-01T00:00:00Z', JSON.stringify({ sourceId: item.id, source: item })]);
  });
}

test('knowledge retrieval scopes tenant, brand and version and rechecks canonical source approval', async () => {
  const db = await testDatabase();
  try {
    await seedVersion(db, scope, 'v1', [source('approved'), source('draft', { status: 'draft' }), source('expired', { validUntil: '2021-01-01T00:00:00.000Z' })]);
    await seedVersion(db, scope, 'v2', [source('new-version')]);
    await seedVersion(db, { ...scope, brandId: 'other' }, 'v1', [source('other-brand', { brandId: 'other' })]);
    const result = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, 'v1', 'investimento'));
    assert.deepEqual(result.sources.map(item => item.id), ['approved']);
    assert.equal(result.mode, 'lexical');
    assert.deepEqual(result.excludedSources.map(item => item.reason).sort(), ['expired', 'unapproved']);
  } finally { await db.close(); }
});

test('a Sapore session cannot retrieve Borelli knowledge even under a matching query',async()=>{
  const db=await testDatabase();
  try {
    await seedVersion(db,scope,'shared-version',[source('sapore-approved',{title:'Guia Sapore',content:'A referência aprovada da Sapore trata o investimento como informação a confirmar.'})]);
    const borelliScope={...scope,brandId:'borelli'};
    await seedVersion(db,borelliScope,'shared-version',[source('borelli-exclusive',{tenantId:borelliScope.tenantId,brandId:borelliScope.brandId,title:'Manual Borelli',content:'Conteúdo exclusivo Borelli que nunca pode aparecer na sessão Sapore.'})]);
    const result=await scoped(db,scope,tx=>retrieveKnowledge(tx,scope,'shared-version','conteúdo exclusivo Borelli'));
    assert.ok(result.sources.every(item=>item.brandId==='sapore'));
    assert.equal(JSON.stringify(result).includes('Conteúdo exclusivo Borelli'),false);
  }finally{await db.close();}
});

test('hybrid retrieval uses pgvector cosine ranking and returns at most five distinct sources', async () => {
  const db = await testDatabase();
  try {
    const sources = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'nearest'].map(id => source(id, { content: 'Texto sem termo comum.' }));
    await seedVersion(db, scope, 'vectors', sources);
    const near = Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
    const far = Array.from({ length: 1536 }, (_, index) => index === 1 ? 1 : 0);
    await scoped(db, scope, async tx => {
      await tx.query('UPDATE sdr.knowledge_chunks SET embedding=$4::vector WHERE tenant_id=$1 AND brand_id=$2 AND version_id=$3', [scope.tenantId, scope.brandId, 'vectors', JSON.stringify(far)]);
      await tx.query("UPDATE sdr.knowledge_chunks SET embedding=$4::vector WHERE tenant_id=$1 AND brand_id=$2 AND version_id=$3 AND id='nearest'", [scope.tenantId, scope.brandId, 'vectors', JSON.stringify(near)]);
    });
    const result = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, 'vectors', 'investimento', near));
    assert.equal(result.mode, 'hybrid');
    assert.equal(result.sources[0]?.id, 'nearest');
    assert.equal(result.sources.length, 5);
  } finally { await db.close(); }
});

test('embedding adapter validates the exact model and dimension using a mocked server response', async () => {
  let calls = 0;
  const vector = Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
  const mock = (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fictional-test-key');
    assert.deepEqual(JSON.parse(String(init?.body)), { input: 'capital de giro', model: 'text-embedding-3-small', dimensions: 1536, encoding_format: 'float' });
    return new Response(JSON.stringify({ model: 'text-embedding-3-small', data: [{ index: 0, embedding: vector }] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await buildEmbedding('capital de giro', undefined, mock), { ok: false, error: 'MISSING_API_KEY' });
  assert.equal(calls, 0);
  const result = await buildEmbedding('capital de giro', 'fictional-test-key', mock);
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  if (result.ok) assert.deepEqual(result.embedding, vector);
  const invalid = (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await buildEmbedding('x', 'fictional-test-key', invalid), { ok: false, error: 'INVALID_RESPONSE' });
});

test('indexing chunks only approved immutable snapshot content and is idempotent', async () => {
  const db = await testDatabase();
  try {
    const sources = [source('long', { content: 'Informação comercial aprovada. '.repeat(100) }), source('draft', { status: 'draft' })];
    await db.query('INSERT INTO sdr.brands(tenant_id,id,name) VALUES($1,$2,$2)', [scope.tenantId, scope.brandId]);
    await scoped(db, scope, async tx => {
      await tx.query('INSERT INTO sdr.versions(tenant_id,brand_id,id,label,snapshot,content_hash,model) VALUES($1,$2,$3,$3,$4,$3,$5)', [scope.tenantId, scope.brandId, 'index', JSON.stringify({ sources }), 'test-model']);
      const first = await indexVersionKnowledge(tx, scope, 'index');
      assert.equal(first.ok, true);
      const rows = (await tx.query<{ id: string; content: string }>('SELECT id,content FROM sdr.knowledge_chunks WHERE tenant_id=$1 AND brand_id=$2 AND version_id=$3', [scope.tenantId, scope.brandId, 'index'])).rows;
      assert.ok(rows.length >= 2);
      assert.ok(rows.every(row => row.id.startsWith('long') && row.content.length <= 2000));
      assert.equal((await indexVersionKnowledge(tx, scope, 'index')).ok, true);
      const count = (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM sdr.knowledge_chunks')).rows[0].count;
      assert.equal(count, rows.length);
    });
  } finally { await db.close(); }
});

test('retrieval emits bounded excerpts and discards indexed content absent from the approved snapshot', async () => {
  const db = await testDatabase();
  try {
    await seedVersion(db, scope, 'bounded', [source('long', { content: 'Conteúdo aprovado. '.repeat(250) })]);
    const first = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, 'bounded', 'conteúdo'));
    assert.equal(first.sources.length, 1);
    assert.ok(first.sources[0].content.length <= 2000);
    await scoped(db, scope, tx => tx.query('UPDATE sdr.knowledge_chunks SET content=$4 WHERE tenant_id=$1 AND brand_id=$2 AND version_id=$3', [scope.tenantId, scope.brandId, 'bounded', 'Texto adulterado de outra empresa.']));
    const second = await scoped(db, scope, tx => retrieveKnowledge(tx, scope, 'bounded', 'empresa'));
    assert.deepEqual(second.sources, []);
  } finally { await db.close(); }
});
