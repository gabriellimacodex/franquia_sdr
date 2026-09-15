import { z } from 'zod';
import type { Queryable, Scope } from './database.js';
import { KnowledgeSourceSchema, type KnowledgeSource } from './domain.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const EmbeddingSchema = z.array(z.number().finite()).length(EMBEDDING_DIMENSIONS);
export type EmbeddingResult = { ok: true; embedding: number[]; model: typeof EMBEDDING_MODEL } | { ok: false; error: 'MISSING_API_KEY' | 'EMPTY_INPUT' | 'PROVIDER_UNAVAILABLE' | 'INVALID_RESPONSE' };
export async function buildEmbedding(query: string, apiKey: string | undefined, transport: typeof fetch = fetch): Promise<EmbeddingResult> {
  if (!apiKey?.trim()) return { ok: false, error: 'MISSING_API_KEY' };
  if (!query.trim()) return { ok: false, error: 'EMPTY_INPUT' };
  try {
    const response = await transport('https://api.openai.com/v1/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: query, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' }), signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { ok: false, error: 'PROVIDER_UNAVAILABLE' };
    const parsed = z.object({ model: z.literal(EMBEDDING_MODEL), data: z.array(z.object({ index: z.literal(0), embedding: EmbeddingSchema })).length(1) }).safeParse(await response.json());
    if (!parsed.success) return { ok: false, error: 'INVALID_RESPONSE' };
    return { ok: true, embedding: parsed.data.data[0].embedding, model: EMBEDDING_MODEL };
  } catch { return { ok: false, error: 'PROVIDER_UNAVAILABLE' }; }
}
export type KnowledgeRetrieval = { sources: KnowledgeSource[]; excludedSources: Array<{ id: string; title: string; reason: string }>; mode: 'hybrid' | 'lexical' | 'unavailable'; error?: 'RETRIEVAL_FAILED' | 'VERSION_NOT_FOUND' | 'INVALID_SNAPSHOT' };
export type IndexResult = { ok: true; indexed: number } | { ok: false; error: 'VERSION_NOT_FOUND' | 'INVALID_SNAPSHOT' | 'INVALID_EMBEDDING' | 'INDEX_FAILED' };
export interface KnowledgeChunk { id: string; sourceId: string; title: string; content: string; source: KnowledgeSource }
export type IndexPlan = { ok: true; chunks: KnowledgeChunk[] } | { ok: false; error: 'VERSION_NOT_FOUND' | 'INVALID_SNAPSHOT' | 'INDEX_FAILED' };
export async function getKnowledgeIndexPlan(db: Queryable, scope: Scope, versionId: string): Promise<IndexPlan> {
  try {
    const loaded = await canonicalSources(db, scope, versionId);
    if (!loaded.ok) return loaded;
    const chunks: KnowledgeChunk[] = [];
    for (const source of loaded.sources.filter(item => exclusion(item, Date.now()) === null)) {
      const pieces: string[] = [];
      for (let offset = 0; offset < source.content.length; offset += 1800) {
        pieces.push(source.content.slice(offset, offset + 2000));
        if (offset + 2000 >= source.content.length) break;
      }
      for (const [index, content] of pieces.entries()) chunks.push({ id: pieces.length === 1 ? source.id : `${source.id}:${index}`, sourceId: source.id, title: source.title, content, source });
    }
    return { ok: true, chunks };
  } catch { return { ok: false, error: 'INDEX_FAILED' }; }
}
/** Invoke inside a scoped database transaction. Only immutable snapshot content is indexed. */
export async function indexVersionKnowledge(db: Queryable, scope: Scope, versionId: string, embeddings: Record<string, number[]> = {}): Promise<IndexResult> {
  try {
    const plan = await getKnowledgeIndexPlan(db, scope, versionId);
    if (!plan.ok) return plan;
    const ids = new Set(plan.chunks.map(chunk => chunk.id));
    if (Object.entries(embeddings).some(([id, value]) => !ids.has(id) || !EmbeddingSchema.safeParse(value).success)) return { ok: false, error: 'INVALID_EMBEDDING' };
    let indexed = 0;
    for (const chunk of plan.chunks) {
      const result = await db.query<{ id: string }>(`INSERT INTO sdr.knowledge_chunks
        (tenant_id,brand_id,version_id,id,title,content,approved,active,valid_from,valid_until,metadata,embedding)
        VALUES($1,$2,$3,$4,$5,$6,true,true,$7,$8,$9,$10::vector)
        ON CONFLICT(tenant_id,brand_id,version_id,id) DO UPDATE SET embedding=coalesce(EXCLUDED.embedding,sdr.knowledge_chunks.embedding)
        WHERE sdr.knowledge_chunks.content=EXCLUDED.content AND coalesce(sdr.knowledge_chunks.metadata->>'sourceId',sdr.knowledge_chunks.id)=EXCLUDED.metadata->>'sourceId'
        RETURNING id`, [scope.tenantId, scope.brandId, versionId, chunk.id, chunk.title, chunk.content, chunk.source.validFrom, chunk.source.validUntil, JSON.stringify({ sourceId: chunk.sourceId }), embeddings[chunk.id] ? JSON.stringify(embeddings[chunk.id]) : null]);
      if (!result.rows.length) return { ok: false, error: 'INDEX_FAILED' };
      indexed += result.rows.length;
    }
    return { ok: true, indexed };
  } catch { return { ok: false, error: 'INDEX_FAILED' }; }
}
const SnapshotSourcesSchema = z.object({ sources: z.array(KnowledgeSourceSchema) });
function exclusion(source: KnowledgeSource, now: number): string | null {
  if (source.status !== 'approved') return 'unapproved';
  if (!source.active) return 'disabled';
  if (Date.parse(source.validFrom) > now) return 'not_yet_valid';
  if (source.validUntil !== null && Date.parse(source.validUntil) <= now) return 'expired';
  return null;
}
async function canonicalSources(db: Queryable, scope: Scope, versionId: string): Promise<{ ok: true; sources: KnowledgeSource[] } | { ok: false; error: 'VERSION_NOT_FOUND' | 'INVALID_SNAPSHOT' }> {
  const row = (await db.query<{ snapshot: unknown }>('SELECT snapshot FROM sdr.versions WHERE tenant_id=$1 AND brand_id=$2 AND id=$3', [scope.tenantId, scope.brandId, versionId])).rows[0];
  if (!row) return { ok: false, error: 'VERSION_NOT_FOUND' };
  const parsed = SnapshotSourcesSchema.safeParse(row.snapshot);
  if (!parsed.success || parsed.data.sources.some(source => source.tenantId !== scope.tenantId || source.brandId !== scope.brandId)) return { ok: false, error: 'INVALID_SNAPSHOT' };
  return { ok: true, sources: parsed.data.sources };
}
export async function retrieveKnowledge(db: Queryable, scope: Scope, versionId: string, query: string, embedding?: number[], validAt?: string): Promise<KnowledgeRetrieval> {
  try {
    // A fused transaction can outlive a source boundary. Its internal caller pins one
    // instant for both filters; omission retains the legacy SQL and clock behavior.
    // Date validates offsets and pins millisecond precision before either filter or I/O.
    const explicitTime = validAt === undefined ? undefined : new Date(z.string().datetime({ offset: true }).parse(validAt)).toISOString();
    const loaded = await canonicalSources(db, scope, versionId);
    if (!loaded.ok) return { sources: [], excludedSources: [], mode: 'unavailable', error: loaded.error };
    const now = explicitTime === undefined ? Date.now() : Date.parse(explicitTime);
    const allowed = loaded.sources.filter(source => exclusion(source, now) === null);
    const parsedEmbedding = EmbeddingSchema.safeParse(embedding);
    const vector = parsedEmbedding.success ? JSON.stringify(parsedEmbedding.data) : null;
    const timeSql = explicitTime === undefined ? 'now()' : '$8::timestamptz';
    const rows = (await db.query<{ source_id: string; content: string; semantic_used: boolean }>(`WITH eligible AS MATERIALIZED (
      SELECT k.id,coalesce(k.metadata->>'sourceId',k.id) AS source_id,k.content,k.embedding,
        ts_rank(k.search,plainto_tsquery('portuguese',$4)) AS text_score FROM sdr.knowledge_chunks k
      JOIN jsonb_to_recordset($7::jsonb) AS canonical(id text,content text)
        ON coalesce(k.metadata->>'sourceId',k.id)=canonical.id AND strpos(canonical.content,k.content)>0
      WHERE k.tenant_id=$1 AND k.brand_id=$2 AND k.version_id=$3 AND k.approved AND k.active
      AND k.valid_from<=${timeSql} AND (k.valid_until IS NULL OR k.valid_until>${timeSql})
      AND coalesce(k.metadata->>'sourceId',k.id)=ANY($5::text[]) AND btrim(k.content)<>''
    ), ranked AS (
      SELECT *, row_number() OVER (ORDER BY text_score DESC,source_id) AS lexical_rank,
        row_number() OVER (ORDER BY embedding <=> $6::vector NULLS LAST,source_id) AS semantic_rank
      FROM eligible
    ), scored AS (
      SELECT id,source_id,content,CASE WHEN $6::vector IS NULL THEN text_score ELSE
        CASE WHEN text_score>0 THEN 1.0/(60+lexical_rank) ELSE 0 END +
        CASE WHEN embedding IS NOT NULL THEN 1.0/(60+semantic_rank) ELSE 0 END END AS score
      FROM ranked
    ), deduplicated AS (
      SELECT *,row_number() OVER (PARTITION BY source_id ORDER BY score DESC,id) AS source_rank FROM scored
    ) SELECT source_id,content,score,
      ($6::vector IS NOT NULL AND EXISTS(SELECT 1 FROM eligible WHERE embedding IS NOT NULL)) AS semantic_used
      FROM deduplicated WHERE source_rank=1 ORDER BY score DESC,source_id LIMIT 5`, [scope.tenantId, scope.brandId, versionId, query, allowed.map(source => source.id), vector, JSON.stringify(allowed.map(source => ({ id: source.id, content: source.content }))), ...(explicitTime === undefined ? [] : [explicitTime])])).rows;
    const sources = rows.flatMap(row => { const source = allowed.find(item => item.id === row.source_id); return source && source.content.includes(row.content) ? [{ ...source, content: row.content.slice(0, 2000) }] : []; });
    const included = new Set(sources.map(source => source.id));
    return { sources, excludedSources: loaded.sources.filter(source => !included.has(source.id)).map(source => ({ id: source.id, title: source.title, reason: exclusion(source, now) ?? 'not_retrieved' })), mode: rows.some(row => row.semantic_used) ? 'hybrid' : 'lexical' };
  } catch { return { sources: [], excludedSources: [], mode: 'unavailable', error: 'RETRIEVAL_FAILED' }; }
}
