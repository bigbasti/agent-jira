import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import SqliteDatabase from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {migrate} from 'drizzle-orm/better-sqlite3/migrator';
import {buildApp} from './app.js';
import {loadConfig} from './config.js';

const config = loadConfig();

if (config.databasePath !== ':memory:') {
  mkdirSync(dirname(config.databasePath), {recursive: true});
}

const sqlite = new SqliteDatabase(config.databasePath);
const db = drizzle(sqlite);

try {
  migrate(db, {migrationsFolder: './drizzle'});
} catch (err) {
  // No migrations directory yet — the real schema and migrations land in Task 2.
  const isMissingFolder = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
  if (!isMissingFolder) {
    throw err;
  }
}

const app = await buildApp({db});

await app.listen({host: '0.0.0.0', port: config.port});
