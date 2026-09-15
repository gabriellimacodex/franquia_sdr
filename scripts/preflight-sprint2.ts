import { sprint2Preflight } from '../src/preflight.js';

process.stdout.write(JSON.stringify(sprint2Preflight(process.env),null,2)+'\n');
