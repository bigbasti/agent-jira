/**
 * `npm run db:migrate` — applies every pending migration to the configured database and
 * exits.
 *
 * The server already migrates at boot (see `index.ts`), before the port opens, so this is
 * not part of the normal path: it is for applying a migration deliberately, ahead of a
 * deploy or against a database that is not currently being served. It reads the same
 * `DATABASE_PATH` the server does — via `loadConfig`, rather than a second copy of the
 * default — so the two can never disagree about which file they are migrating.
 */
import {openDb} from './index.js';
import {runMigrations} from './migrate.js';
import {loadConfig} from '../config.js';

const {databasePath} = loadConfig();
const db = openDb(databasePath);

try {
  runMigrations(db);
  console.log(`Migrations applied to ${databasePath}`);
} catch (err) {
  console.error('Failed to run database migrations:', err);
  process.exitCode = 1;
} finally {
  db.$client.close();
}
