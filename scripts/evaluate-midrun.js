import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateMidrunDatabase,
  midrunEvaluationMarkdown,
} from '../src/evaluation/midrun.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    database: join(ROOT, 'data/agent-eta-demo.sqlite'),
    outputDirectory: join(ROOT, 'outputs'),
    bootstrapSamples: 2_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--db=')) options.database = resolve(argument.slice(5));
    else if (argument === '--db') options.database = resolve(argv[++index]);
    else if (argument.startsWith('--output-dir=')) options.outputDirectory = resolve(argument.slice(13));
    else if (argument === '--output-dir') options.outputDirectory = resolve(argv[++index]);
    else if (argument.startsWith('--bootstrap=')) options.bootstrapSamples = Number.parseInt(argument.slice(12), 10);
    else if (!argument.startsWith('-')) options.database = resolve(argument);
    else throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.bootstrapSamples) || options.bootstrapSamples < 0) {
    throw new TypeError('--bootstrap must be a non-negative integer');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const report = evaluateMidrunDatabase(options.database, {
  bootstrapSamples: options.bootstrapSamples,
});
const markdown = midrunEvaluationMarkdown(report);
mkdirSync(options.outputDirectory, { recursive: true });
writeFileSync(join(options.outputDirectory, 'midrun-evaluation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(options.outputDirectory, 'midrun-evaluation-report.md'), `${markdown.trimEnd()}\n`);
console.log(markdown);
