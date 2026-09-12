import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/**
 * Opens a better-sqlite3 handle at `path` (or `:memory:`), enables WAL journaling and
 * foreign-key enforcement, and wraps it in drizzle. Does not run migrations — callers
 * that need tables must call `runMigrations` (see `./migrate.js`) themselves.
 */
export function openDb(path: string) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), {recursive: true});
  }

  const sqlite = new SqliteDatabase(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return drizzle(sqlite, {schema});
}

export type Database = ReturnType<typeof openDb>;
