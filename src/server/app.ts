import Fastify, {type FastifyInstance} from 'fastify';
import type {Database} from './db/index.js';
import {loadConfig, type AppConfig} from './config.js';
import {registerSessionPlugin} from './plugins/session.js';
import {authRoutes} from './routes/auth.js';
import {projectRoutes} from './routes/projects.js';
import {storyRoutes} from './routes/stories.js';
import {boardRoutes} from './routes/board.js';
import {oauthRoutes} from './routes/oauth.js';
import {mcpRoutes} from './routes/mcp.js';
import {registerWsRoute, type WsRouteOptions} from './routes/ws.js';
import {EventHub} from './events/hub.js';
import {warmDummyHash} from './services/auth.js';

const VERSION = '0.1.0';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    hub: EventHub;
  }
}

export interface BuildAppOptions extends WsRouteOptions {
  db: Database;
  config?: AppConfig;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const config = opts.config ?? loadConfig();

  app.decorate('db', opts.db);

  const hub = new EventHub();
  app.decorate('hub', hub);

  // Warm the dummy-hash cache in the background (not awaited) so app startup isn't
  // delayed, but the first unknown-email login still avoids paying the one-time argon2
  // cost inline — see services/auth.ts. Catch defensively: an unlikely rejection here
  // must not become an unhandled rejection at startup.
  warmDummyHash().catch(() => {});

  await registerSessionPlugin(app, config);
  await app.register(authRoutes);
  await app.register(projectRoutes);
  await app.register(storyRoutes);
  await app.register(boardRoutes);
  await app.register(oauthRoutes, {config});
  await app.register(mcpRoutes, {config});
  await registerWsRoute(app, {wsHeartbeatIntervalMs: opts.wsHeartbeatIntervalMs});

  app.get('/api/health', async () => {
    return {status: 'ok', version: VERSION};
  });

  // Registered last so it runs first on close (onClose hooks run in reverse-registration
  // order): resolve any in-flight `waitFor` calls before the database handle underneath
  // them disappears.
  app.addHook('onClose', () => {
    hub.close();
    opts.db.$client.close();
  });

  return app;
}
