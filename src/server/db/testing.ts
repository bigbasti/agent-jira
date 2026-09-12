import {openDb, type Database} from './index.js';
import {runMigrations} from './migrate.js';

/** An in-memory, fully migrated database, ready to use in tests. */
export function createTestDb(): Database {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}
