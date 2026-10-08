import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluatePilotDatabase,
  pilotEvaluationMarkdown,
} from '../src/evaluation/pilot.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let database = join(ROOT, 'data/agent-eta-demo.sqlite');
let outputDirectory = join(ROOT, 'outputs');
let bootstrapSamples = 2_000;
let seed = 0x0e7a2026;
let volatilityThresholdMinutes = null;
let minimumVolatilityScopes = 30;
const argumentsList = process.argv.slice(2);
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === '--db') database = resolve(argumentsList[++index]);
  else if (argument.startsWith('--db=')) database = resolve(argument.slice(5));
  else if (argument === '--output-dir') outputDirectory = resolve(argumentsList[++index]);
  else if (argument.startsWith('--output-dir=')) outputDirectory = resolve(argument.slice(13));
  else if (argument === '--bootstrap') bootstrapSamples = Number.parseInt(argumentsList[++index], 10);
  else if (argument.startsWith('--bootstrap=')) {
    bootstrapSamples = Number.parseInt(argument.slice('--bootstrap='.length), 10);
  } else if (argument === '--seed') seed = Number.parseInt(argumentsList[++index], 10);
  else if (argument.startsWith('--seed=')) seed = Number.parseInt(argument.slice('--seed='.length), 10);
  else if (argument === '--volatility-threshold') {
    volatilityThresholdMinutes = Number(argumentsList[++index]);
  } else if (argument.startsWith('--volatility-threshold=')) {
    volatilityThresholdMinutes = Number(argument.slice('--volatility-threshold='.length));
  } else if (argument === '--minimum-volatility-scopes') {
    minimumVolatilityScopes = Number.parseInt(argumentsList[++index], 10);
  } else if (argument.startsWith('--minimum-volatility-scopes=')) {
    minimumVolatilityScopes = Number.parseInt(
      argument.slice('--minimum-volatility-scopes='.length),
      10,
    );
  } else throw new TypeError('PILOT_EVALUATION_UNKNOWN_ARGUMENT');
}
if (!Number.isInteger(bootstrapSamples) || bootstrapSamples < 0) {
  throw new TypeError('--bootstrap must be a non-negative integer');
}
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
  throw new TypeError('--seed must be an unsigned 32-bit integer');
}
if (volatilityThresholdMinutes !== null
    && (!Number.isFinite(volatilityThresholdMinutes) || volatilityThresholdMinutes < 0)) {
  throw new TypeError('--volatility-threshold must be a non-negative number');
}
if (!Number.isInteger(minimumVolatilityScopes) || minimumVolatilityScopes < 1) {
  throw new TypeError('--minimum-volatility-scopes must be a positive integer');
}

const report = evaluatePilotDatabase(database, {
  bootstrapSamples,
  seed,
  volatilityThresholdMinutes,
  minimumVolatilityScopes,
});
const markdown = pilotEvaluationMarkdown(report);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'pilot-evaluation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outputDirectory, 'pilot-evaluation-report.md'), `${markdown.trimEnd()}\n`);
console.log(markdown);
