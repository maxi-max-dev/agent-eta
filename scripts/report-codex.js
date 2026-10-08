import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CODEX_REPORTER_ERRORS,
  reportCurrentCodexRun,
} from '../src/reporter/codex-wrapper.js';

const MAX_BYTES = 64 * 1024;

function optionsFrom(argv) {
  const result = {
    file: null,
    stdin: false,
    root: process.env.CODEX_SESSION_ROOT ?? join(homedir(), '.codex', 'sessions'),
    baseUrl: process.env.AGENT_ETA_URL ?? 'http://127.0.0.1:4318',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--file') result.file = argv[++index] ?? null;
    else if (value === '--stdin') result.stdin = true;
    else if (value === '--root') result.root = argv[++index] ?? '';
    else if (value === '--url') result.baseUrl = argv[++index] ?? '';
    else throw new Error('CODEX_REPORTER_UNKNOWN_ARGUMENT');
  }
  if ((result.file === null) === !result.stdin) throw new Error('CODEX_REPORTER_INPUT_REQUIRED');
  return result;
}

async function stdinText() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('CODEX_REPORTER_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  let input;
  try {
    input = options.stdin ? await stdinText() : await readFile(options.file, 'utf8');
  } catch (error) {
    if (error?.message === 'CODEX_REPORTER_INPUT_TOO_LARGE') throw error;
    throw new Error(CODEX_REPORTER_ERRORS.scopeReadFailed);
  }
  if (Buffer.byteLength(input) > MAX_BYTES) throw new Error('CODEX_REPORTER_INPUT_TOO_LARGE');
  let observation;
  try {
    observation = JSON.parse(input);
  } catch {
    throw new Error('CODEX_REPORTER_INVALID_JSON');
  }
  const result = await reportCurrentCodexRun({
    root: options.root,
    threadId: process.env.CODEX_THREAD_ID,
    observation,
    baseUrl: options.baseUrl,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? error?.message ?? 'CODEX_REPORTER_FAILED'}\n`);
  process.exitCode = 1;
});
