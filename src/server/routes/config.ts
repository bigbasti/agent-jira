import type {FastifyInstance} from 'fastify';
import type {AppConfig} from '../config.js';
import {requireUser} from '../services/auth.js';
import {RESOURCE_PATH, issuerFrom} from '../oauth/metadata.js';

export interface ConfigRouteOptions {
  config: AppConfig;
}

/**
 * Registers `GET /api/config` — the one place `PUBLIC_URL` reaches the browser. The
 * client must never hardcode the MCP url or guess it from `window.location`: behind a
 * reverse proxy those can disagree with what the server itself was configured to answer
 * to, which is exactly the url this endpoint derives `mcpUrl` from — the same
 * `issuerFrom`/`RESOURCE_PATH` the MCP route and its OAuth metadata already use, so the
 * three can never drift apart.
 */
export async function configRoutes(app: FastifyInstance, opts: ConfigRouteOptions): Promise<void> {
  const publicUrl = issuerFrom(opts.config.publicUrl);
  const mcpUrl = `${publicUrl}${RESOURCE_PATH}`;

  app.get('/api/config', {preHandler: requireUser}, async () => ({publicUrl, mcpUrl}));
}
