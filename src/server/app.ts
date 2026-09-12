import Fastify, {type FastifyInstance} from 'fastify';
import type {Database} from './db/index.js';

const VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export interface BuildAppOptions {
  db: Database;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify();

  app.decorate('db', opts.db);

  app.get('/api/health', async () => {
    return {status: 'ok', version: VERSION};
  });

  return app;
}
