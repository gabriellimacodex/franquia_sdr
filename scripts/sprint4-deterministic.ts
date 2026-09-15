/** Offline evidence generation only. Does not register validation, publish or use credentials. */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function manifest() {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json',
    'scripts/sprint4-deterministic.ts', 'tests/db-helper.ts', 'tests/config.ts',
    'docs/sprints/SPRINT-04-META-PLANO-AVALIACAO.md'];
  for (const folder of ['src', 'evaluations', 'migrations']) {
    for (const entry of await readdir(new URL(folder + '/', root), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|sql)$/.test(entry.name)) {
        paths.push(relative(fileURLToPath(root), join(entry.parentPath, entry.name)));
      }
    }
  }
  const entries = [];
  for (const path of [...new Set(paths)].sort()) entries.push({ path, sha256: hash(await readFile(new URL(path, root))) });
  return entries;
}

const savedFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('NETWORK_FORBIDDEN_IN_OFFLINE_SUITE'); };
try {
  const before = await manifest();
  const [{ DeterministicSuite }, { financeCases }, { memoryCases }, { controlCases }] = await Promise.all([
    import('../evaluations/sprint4-deterministic.js'), import('../evaluations/sprint4-deterministic-finance.js'),
    import('../evaluations/sprint4-deterministic-memory.js'), import('../evaluations/sprint4-deterministic-controls.js'),
  ]);
  const result = await new DeterministicSuite([...financeCases, ...memoryCases, ...controlCases]).execute({ repetitions: 2 });
  if (!result.ok) throw new Error(result.error);
  const after = await manifest();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('SOURCE_CHANGED_DURING_MEASUREMENT');
  if (networkAttempts !== 0) throw new Error('OFFLINE_NETWORK_ATTEMPT');
  const artifact = {
    ...result.report,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    command: 'node --import tsx scripts/sprint4-deterministic.ts',
    sourceManifest: before, sourceManifestHash: hash(JSON.stringify(before)), sourceStableDuringRun: true,
    networkAttempts, paidCostMicroUsd: 0,
    limits: [
      'Local worktree artifact, not proof of deployed image content.',
      'Fictional inputs and constructed model callbacks; no model quality or latency evidence.',
      'PGlite is not remote PostgreSQL concurrency, Supabase authorization or browser QA.',
      'D10 includes explicitly identified legacy-v1 compatibility fixtures.',
      'D11-D14 intentionally alter copies of source data to test rejection; the base candidate remains pinned.',
      'No validation recorded, snapshot published, human score or approval inferred.',
      'Worker retry behavior after lost ACK is outside D29 callback replay coverage.',
    ],
  };
  const name = 'SPRINT-04-META-DETERMINISTICA-' + result.report.startedAt.replace(/[-:.]/g, '') + '.json';
  const target = new URL('docs/sprints/' + name, root);
  const bytes = JSON.stringify(artifact, null, 2) + '\n';
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ artifact: fileURLToPath(target), sha256: hash(bytes), sourceManifestHash: artifact.sourceManifestHash,
    scenarioCount: 30, repetitions: 2, passed: result.report.results.filter(row => row.status === 'passed').length,
    criticalViolations: result.report.criticalViolations, startedAt: result.report.startedAt, finishedAt: result.report.finishedAt,
    modelCalls: 0, paidCostMicroUsd: 0 }));
  if (result.report.criticalViolations.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'EVIDENCE_GENERATION_FAILED'); process.exitCode = 1;
} finally { globalThis.fetch = savedFetch; }
