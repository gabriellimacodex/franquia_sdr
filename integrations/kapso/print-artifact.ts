import { readFile } from 'node:fs/promises';
import { buildKapsoFunctions, buildKapsoWorkflow, buildDisabledInboundTrigger } from './artifacts.js';

// Prints non-secret create payloads; never deploys, links a project, or activates a trigger.
const [kind, configPath] = process.argv.slice(2);
if (kind === 'functions') process.stdout.write(JSON.stringify(await buildKapsoFunctions(), null, 2));
else if (kind === 'disabled-trigger') process.stdout.write(JSON.stringify(buildDisabledInboundTrigger(), null, 2));
else if (kind === 'workflow' && configPath) {
  const ids = JSON.parse(await readFile(configPath, 'utf8'));
  process.stdout.write(JSON.stringify(buildKapsoWorkflow(ids), null, 2));
} else throw new Error('Usage: node --import tsx integrations/kapso/print-artifact.ts functions|disabled-trigger|workflow [verified-function-ids.json]');
