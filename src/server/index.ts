import {openDb} from './db/index.js';
import {runMigrations} from './db/migrate.js';
import {buildApp} from './app.js';
import {loadConfig} from './config.js';

const config = loadConfig();
const db = openDb(config.databasePath);

try {
  runMigrations(db);
} catch (err) {
  console.error('Failed to run database migrations:', err);
  process.exit(1);
}

const app = await buildApp({db});

await app.listen({host: '0.0.0.0', port: config.port});
