import Fastify, {type FastifyInstance} from 'fastify';
import type {Database} from './db/index.js';
import {loadConfig, type AppConfig} from './config.js';
import {registerSessionPlugin} from './plugins/session.js';
import {authRoutes} from './routes/auth.js';

const VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export interface BuildAppOptions {
  db: Database;
  config?: AppConfig;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const config = opts.config ?? loadConfig();

  app.decorate('db', opts.db);

  await registerSessionPlugin(app, config);
  await app.register(authRoutes);

  app.get('/api/health', async () => {
    return {status: 'ok', version: VERSION};
  });

  return app;
}
