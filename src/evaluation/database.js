import { DatabaseSync } from 'node:sqlite';

/**
 * Run every evaluation query against one WAL read snapshot. A concurrent
 * watcher may keep importing, but a report cannot mix rows from before and
 * after that commit boundary.
 */
export function withReadSnapshot(filename, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const database = new DatabaseSync(filename, { readOnly: true });
  let transactionOpen = false;
  try {
    database.exec('BEGIN');
    transactionOpen = true;
    const result = callback(database);
    database.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original evaluation error.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}
