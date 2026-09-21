import {fileURLToPath} from 'node:url';
import path from 'node:path';
import Fastify, {type FastifyInstance} from 'fastify';
import fastifyStatic from '@fastify/static';
import type {Database} from './db/index.js';
import {loadConfig, type AppConfig} from './config.js';
import {registerSessionPlugin} from './plugins/session.js';
import {authRoutes} from './routes/auth.js';
import {projectRoutes} from './routes/projects.js';
import {storyRoutes} from './routes/stories.js';
import {boardRoutes} from './routes/board.js';
import {agentRoutes} from './routes/agents.js';
import {configRoutes} from './routes/config.js';
import {oauthRoutes} from './routes/oauth.js';
import {mcpRoutes} from './routes/mcp.js';
import {registerWsRoute, type WsRouteOptions} from './routes/ws.js';
import {EventHub} from './events/hub.js';
import {warmDummyHash} from './services/auth.js';
import {markStaleAgentsOffline} from './services/agents.js';

const VERSION = '0.1.0';

/**
 * Where the built SPA lives relative to this file once compiled: `dist/server/app.js`
 * sits next to `dist/web` (see `tsconfig.server.json`'s `outDir`/vite's `build.outDir`).
 * `webDir` on `BuildAppOptions` overrides this — production callers never need to, but
 * tests point it at a small fixture directory instead of requiring a real `npm run build`.
 */
const DEFAULT_WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web');

/** Path prefixes/exact paths the SPA fallback must never answer, even for a GET. */
const RESERVED_PREFIXES = ['/api/', '/.well-known/', '/ws/', '/mcp/'];
const RESERVED_EXACT = new Set(['/api', '/ws', '/mcp']);

/**
 * Matched case-insensitively, and a single trailing slash is ignored — `GET /WS/` or
 * `GET /mcp/` must be refused exactly like `GET /ws`/`GET /mcp` are, not fall through to
 * `looksLikeStaticAsset` (which a slash-terminated path never satisfies) and come back as
 * a 200 of `index.html`. An MCP or WS client that appends a trailing slash should see a
 * protocol-level 404, not a confusing page of HTML.
 */
function isReservedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (RESERVED_PREFIXES.some(prefix => lower.startsWith(prefix))) return true;
  const withoutTrailingSlash = lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
  return RESERVED_EXACT.has(withoutTrailingSlash);
}

/**
 * A trailing segment with a `.` in it (`app.js`, `favicon.ico`, ...) reads as a request for
 * a specific static file. If `@fastify/static` didn't find one, that's a real 404 — falling
 * back to `index.html` would make a missing script silently "succeed" with a page of HTML.
 */
function looksLikeStaticAsset(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return lastSegment.includes('.');
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    hub: EventHub;
  }
}

export interface BuildAppOptions extends WsRouteOptions {
  db: Database;
  config?: AppConfig;
  /**
   * Overrides where the built SPA is served from in production. Defaults to `dist/web`
   * next to this file; tests point it at a fixture directory so they don't depend on a
   * real `npm run build` having run first.
   */
  webDir?: string;
  /**
   * How often the agent-presence sweep runs, in ms. Defaults to a minute; tests inject a
   * short interval rather than waiting one out.
   */
  agentSweepIntervalMs?: number;
}

/** How often stale agents are swept to `offline` — see `markStaleAgentsOffline`. */
const DEFAULT_AGENT_SWEEP_INTERVAL_MS = 60_000;

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  // Behind a reverse proxy (the deployment this app is built for), the socket that
  // reaches this process belongs to the proxy, not the client — only trust the
  // `X-Forwarded-*` headers it sets when a deployer has confirmed one is actually there
  // (see `config.ts`'s `trustProxy`). Otherwise every rate limit keyed on `req.ip` (the
  // OAuth client-registration limiter in particular) would key on the proxy's one address.
  const app = Fastify({trustProxy: config.trustProxy});

  // Every response, including errors and static assets: a browser must not second-guess a
  // content type it was given, and nothing here is meant to be framed — least of all the
  // OAuth consent screen, where a click hands an agent access to the whole board. Added
  // before any route plugin so it covers all of them.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "frame-ancestors 'none'");
  });

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
  await app.register(agentRoutes);
  await app.register(configRoutes, {config});
  await app.register(oauthRoutes, {config});
  await app.register(mcpRoutes, {config});
  await registerWsRoute(app, {wsHeartbeatIntervalMs: opts.wsHeartbeatIntervalMs});

  app.get('/api/health', async () => {
    return {status: 'ok', version: VERSION};
  });

  // The dev server never reaches this: `vite`'s dev proxy (see `vite.config.ts`) serves
  // the SPA itself and forwards everything else here. In production there is no such
  // proxy — this process is the whole app, so it has to serve the built SPA too, or the
  // OAuth consent screen (a redirect to `/consent`, a path in this SPA) 404s.
  if (config.nodeEnv === 'production') {
    const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
    await app.register(fastifyStatic, {root: webDir});

    // `@fastify/static` calls `reply.callNotFound()` for any GET under its root it can't
    // match to a real file, which lands here — so this handler also covers every other
    // unmatched route in the app (a typo'd `/api/...` path, say). Only a *reserved* prefix
    // is refused outright; anything else that isn't asset-shaped is a client-side route
    // the SPA's own router will resolve once `index.html` is loaded.
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split('?')[0] ?? req.url;
      if (req.method !== 'GET' || isReservedPath(pathname) || looksLikeStaticAsset(pathname)) {
        return reply.code(404).send({error: 'not_found'});
      }
      return reply.sendFile('index.html', webDir);
    });
  }

  // Nothing tells the board an agent has crashed — an MCP request is the only contact it
  // has, and a dead agent simply stops making them. This is what turns that silence into
  // `offline` instead of a pill that pulses "working" forever. Unref'd, so it never holds
  // the process open on its own.
  const agentSweep = setInterval(
    () => markStaleAgentsOffline(app.db, hub),
    opts.agentSweepIntervalMs ?? DEFAULT_AGENT_SWEEP_INTERVAL_MS,
  );
  agentSweep.unref();

  // Registered last so it runs first on close (onClose hooks run in reverse-registration
  // order): resolve any in-flight `waitFor` calls before the database handle underneath
  // them disappears.
  app.addHook('onClose', () => {
    clearInterval(agentSweep);
    hub.close();
    opts.db.$client.close();
  });

  return app;
}
