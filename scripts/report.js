import { readFile } from 'node:fs/promises';

import { submitReporterReport } from '../src/reporter/client.js';

const MAX_BYTES = 64 * 1024;

function argumentsFrom(argv) {
  const result = { file: null, stdin: false, baseUrl: process.env.AGENT_ETA_URL ?? 'http://127.0.0.1:4318' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--stdin') result.stdin = true;
    else if (value === '--file') result.file = argv[++index] ?? null;
    else if (value === '--url') result.baseUrl = argv[++index] ?? '';
    else throw new Error('REPORTER_UNKNOWN_ARGUMENT');
  }
  if ((result.file === null) === !result.stdin) {
    throw new Error('REPORTER_INPUT_REQUIRED');
  }
  return result;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('REPORTER_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const text = options.stdin ? await readStdin() : await readFile(options.file, 'utf8');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('REPORTER_INPUT_TOO_LARGE');
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error('REPORTER_INVALID_JSON');
  }
  const result = await submitReporterReport(report, { baseUrl: options.baseUrl });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? error?.message ?? 'REPORTER_FAILED'}\n`);
  process.exitCode = 1;
});
