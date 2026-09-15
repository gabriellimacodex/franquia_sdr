import { connectDatabase, scoped } from '../src/database.js';
import { buildEmbedding, getKnowledgeIndexPlan, indexVersionKnowledge } from '../src/knowledge.js';

const [tenantId, brandId, versionId, option] = process.argv.slice(2);
if (!tenantId || !brandId || !versionId || (option !== undefined && option !== '--embed')) {
  throw new Error('Usage: node --import tsx scripts/index-knowledge.ts TENANT BRAND VERSION [--embed]');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = connectDatabase(process.env.DATABASE_URL, process.env.DATABASE_SSL !== 'false');
const scope = { tenantId, brandId };
try {
  const plan = await scoped(db, scope, tx => getKnowledgeIndexPlan(tx, scope, versionId));
  if (!plan.ok) throw new Error(plan.error);
  const embeddings: Record<string, number[]> = {};
  if (option === '--embed' && process.env.OPENAI_API_KEY) {
    // Only canonical approved chunks enter the embedding service; credentials stay on this server.
    for (const chunk of plan.chunks) {
      const result = await buildEmbedding(chunk.content, process.env.OPENAI_API_KEY);
      if (!result.ok) throw new Error(result.error);
      embeddings[chunk.id] = result.embedding;
    }
  }
  const result = await scoped(db, scope, tx => indexVersionKnowledge(tx, scope, versionId, embeddings));
  if (!result.ok) throw new Error(result.error);
  process.stdout.write(JSON.stringify({ indexed: result.indexed, mode: Object.keys(embeddings).length ? 'hybrid' : 'lexical', versionId }) + '\n');
} finally { await db.close(); }
