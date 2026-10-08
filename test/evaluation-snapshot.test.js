import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { withReadSnapshot } from '../src/evaluation/database.js';

test('evaluation reads stay on one SQLite snapshot during concurrent watcher commits', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eta-eval-snapshot-'));
  const filename = join(directory, 'snapshot.sqlite');
  const writer = new DatabaseSync(filename);
  try {
    writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE sample(value INTEGER NOT NULL); INSERT INTO sample VALUES (1);');
    const observed = withReadSnapshot(filename, (reader) => {
      const before = Number(reader.prepare('SELECT value FROM sample').get().value);
      writer.prepare('UPDATE sample SET value = 2').run();
      const after = Number(reader.prepare('SELECT value FROM sample').get().value);
      return { before, after };
    });
    assert.deepEqual(observed, { before: 1, after: 1 });
    assert.equal(Number(writer.prepare('SELECT value FROM sample').get().value), 2);
  } finally {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
