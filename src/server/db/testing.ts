import SqliteDatabase from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';

/**
 * Placeholder test database: an in-memory better-sqlite3 handle wrapped in drizzle,
 * with no tables. Task 2 introduces the real schema and migrations and replaces this.
 */
export function createTestDb() {
  const sqlite = new SqliteDatabase(':memory:');
  return drizzle(sqlite);
}

export type Database = ReturnType<typeof createTestDb>;
