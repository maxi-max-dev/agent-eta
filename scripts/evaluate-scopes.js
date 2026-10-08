import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateScopeDatabase,
  scopeEvaluationMarkdown,
} from '../src/evaluation/scopes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let database = join(ROOT, 'data/agent-eta-demo.sqlite');
let outputDirectory = join(ROOT, 'outputs');
for (let index = 0; index < process.argv.slice(2).length; index += 1) {
  const argument = process.argv.slice(2)[index];
  if (argument === '--db') database = resolve(process.argv.slice(2)[++index]);
  else if (argument.startsWith('--db=')) database = resolve(argument.slice(5));
  else if (argument === '--output-dir') outputDirectory = resolve(process.argv.slice(2)[++index]);
  else if (argument.startsWith('--output-dir=')) outputDirectory = resolve(argument.slice(13));
  else throw new TypeError('SCOPE_EVALUATION_UNKNOWN_ARGUMENT');
}

const report = evaluateScopeDatabase(database);
const markdown = scopeEvaluationMarkdown(report);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'scope-evaluation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(outputDirectory, 'scope-evaluation-report.md'), `${markdown.trimEnd()}\n`);
console.log(markdown);
