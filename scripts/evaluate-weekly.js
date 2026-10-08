import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateWeeklyDatabase,
  weeklyEvaluationMarkdown,
} from '../src/evaluation/weekly.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseWeeklyEvaluationArgs(argv) {
  const options = {
    database: join(ROOT, 'data/agent-eta-demo.sqlite'),
    outputDirectory: join(ROOT, 'outputs'),
    generatedAt: new Date().toISOString(),
    completedWeeks: 4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--db=')) options.database = resolve(argument.slice('--db='.length));
    else if (argument === '--db') options.database = resolve(argv[++index]);
    else if (argument.startsWith('--output-dir=')) {
      options.outputDirectory = resolve(argument.slice('--output-dir='.length));
    } else if (argument === '--output-dir') options.outputDirectory = resolve(argv[++index]);
    else if (argument.startsWith('--as-of=')) options.generatedAt = argument.slice('--as-of='.length);
    else if (argument === '--as-of') options.generatedAt = argv[++index];
    else if (argument.startsWith('--weeks=')) {
      options.completedWeeks = Number.parseInt(argument.slice('--weeks='.length), 10);
    } else if (argument === '--weeks') {
      options.completedWeeks = Number.parseInt(argv[++index], 10);
    } else if (!argument.startsWith('-')) options.database = resolve(argument);
    else throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.completedWeeks) || options.completedWeeks < 1) {
    throw new TypeError('--weeks must be a positive integer');
  }
  return options;
}

export function writeWeeklyEvaluation(options) {
  const report = evaluateWeeklyDatabase(options.database, {
    generatedAt: options.generatedAt,
    completedWeeks: options.completedWeeks,
  });
  const markdown = weeklyEvaluationMarkdown(report);
  mkdirSync(options.outputDirectory, { recursive: true });
  writeFileSync(
    join(options.outputDirectory, 'weekly-shadow-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  writeFileSync(join(options.outputDirectory, 'weekly-shadow-report.md'), `${markdown}\n`);
  return { report, markdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = writeWeeklyEvaluation(parseWeeklyEvaluationArgs(process.argv.slice(2)));
  console.log(result.markdown);
}
