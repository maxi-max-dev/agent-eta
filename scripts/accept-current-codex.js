import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { acceptCurrentCodexProject } from '../src/scopes/codex-acceptance.js';
import { safeWorksetIngestCode } from '../src/scopes/ingest.js';
import { AgentEtaDatabase } from '../src/storage/database.js';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_DB = resolve(ROOT, 'data/agent-eta-demo.sqlite');

function optionsFrom(argv) {
  const result = {
    action: 'declare',
    status: null,
    occurredAt: null,
    database: process.env.AGENT_ETA_DB ?? DEFAULT_DB,
    root: process.env.CODEX_SESSION_ROOT ?? join(homedir(), '.codex', 'sessions'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--action') result.action = argv[++index] ?? '';
    else if (value === '--status') result.status = argv[++index] ?? '';
    else if (value === '--at') result.occurredAt = argv[++index] ?? '';
    else if (value === '--db') result.database = argv[++index] ?? '';
    else if (value === '--root') result.root = argv[++index] ?? '';
    else throw new Error('CODEX_ACCEPTANCE_UNKNOWN_ARGUMENT');
  }
  if (!result.database) throw new Error('CODEX_ACCEPTANCE_DATABASE_REQUIRED');
  return result;
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const now = new Date().toISOString();
  const database = new AgentEtaDatabase(options.database);
  try {
    const result = await acceptCurrentCodexProject({
      database,
      root: options.root,
      threadId: process.env.CODEX_THREAD_ID,
      action: options.action,
      status: options.status,
      occurredAt: options.occurredAt ?? now,
      receivedAt: now,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  const direct = typeof error?.message === 'string'
    && /^(?:CODEX_ACCEPTANCE|CODEX_REPORTER|WORKSET)_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : safeWorksetIngestCode(error);
  process.stderr.write(`${direct}\n`);
  process.exitCode = 1;
});
