import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  ingestWorksetCascade,
  ingestWorksetEvent,
  safeWorksetIngestCode,
} from '../src/scopes/ingest.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_DB = resolve(ROOT, 'data/agent-eta-demo.sqlite');
const MAX_BYTES = 64 * 1024;

function argumentsFrom(argv) {
  const result = { file: null, stdin: false, database: process.env.AGENT_ETA_DB ?? DEFAULT_DB };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--stdin') result.stdin = true;
    else if (value === '--file') result.file = argv[++index] ?? null;
    else if (value === '--db') result.database = argv[++index] ?? '';
    else throw new Error('WORKSET_UNKNOWN_ARGUMENT');
  }
  if ((result.file === null) === !result.stdin) throw new Error('WORKSET_INPUT_REQUIRED');
  if (!result.database) throw new Error('WORKSET_DATABASE_REQUIRED');
  return result;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('WORKSET_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const text = options.stdin ? await readStdin() : await readFile(options.file, 'utf8');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('WORKSET_INPUT_TOO_LARGE');
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('WORKSET_INVALID_JSON');
  }
  const database = new AgentEtaDatabase(options.database);
  try {
    const result = Array.isArray(input)
      ? ingestWorksetCascade(database, input)
      : ingestWorksetEvent(database, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  const direct = typeof error?.message === 'string' && /^WORKSET_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : safeWorksetIngestCode(error);
  process.stderr.write(`${direct}\n`);
  process.exitCode = 1;
});
