import { readFile } from 'node:fs/promises';
import { buildN8nWorkflow } from './artifacts.js';

// The input contains a backend origin and credential references (ids/names), NEVER credential values.
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node --import tsx integrations/n8n/print-artifact.ts verified-n8n-references.json');
const input = JSON.parse(await readFile(configPath, 'utf8'));
process.stdout.write(JSON.stringify(await buildN8nWorkflow(input), null, 2));
