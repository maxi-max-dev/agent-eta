import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateLiveDatabase, liveEvaluationMarkdown } from '../src/evaluation/live.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    database: join(ROOT, 'data/agent-eta-demo.sqlite'),
    outputDirectory: join(ROOT, 'outputs'),
    bootstrapSamples: 2_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--db=')) options.database = resolve(argument.slice('--db='.length));
    else if (argument === '--db') options.database = resolve(argv[++index]);
    else if (argument.startsWith('--output-dir=')) {
      options.outputDirectory = resolve(argument.slice('--output-dir='.length));
    } else if (argument === '--output-dir') options.outputDirectory = resolve(argv[++index]);
    else if (argument.startsWith('--bootstrap=')) {
      options.bootstrapSamples = Number.parseInt(argument.slice('--bootstrap='.length), 10);
    } else if (!argument.startsWith('-')) options.database = resolve(argument);
    else throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.bootstrapSamples) || options.bootstrapSamples < 0) {
    throw new TypeError('--bootstrap must be a non-negative integer');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const report = evaluateLiveDatabase(options.database, {
  bootstrapSamples: options.bootstrapSamples,
});
const markdown = liveEvaluationMarkdown(report);
mkdirSync(options.outputDirectory, { recursive: true });
writeFileSync(
  join(options.outputDirectory, 'live-evaluation-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
writeFileSync(join(options.outputDirectory, 'live-evaluation-report.md'), `${markdown}\n`);
console.log(markdown);
