import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {migrate} from 'drizzle-orm/better-sqlite3/migrator';
import type {Database} from './index.js';

// Resolve `drizzle/` relative to this compiled file, not the process CWD: the production
// container runs `node dist/server/index.js` from `/app`, and `dist/server/db/migrate.js`
// is exactly as many directories deep under `/app` as `src/server/db/migrate.ts` is under
// the repo root in dev, so the same relative path resolves correctly in both.
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

export function runMigrations(db: Database): void {
  migrate(db, {migrationsFolder});
}
