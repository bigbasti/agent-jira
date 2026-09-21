import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {AppConfig} from '../config.js';
import {buildMcpServer} from '../mcp/server.js';
import {RESOURCE_PATH, issuerFrom} from '../oauth/metadata.js';
import {authenticateBearer} from '../oauth/tokens.js';

export interface McpRouteOptions {
  config: AppConfig;
}

/** JSON-RPC error codes used for the failures that happen outside the MCP server itself. */
const INTERNAL_ERROR = -32603;
const CONNECTION_CLOSED = -32000;

/**
 * The MCP endpoint: `POST /mcp`.
 *
 * Every request is authenticated from its bearer token and then served by a server built
 * for exactly that agent, over a stateless Streamable HTTP transport. Nothing is kept
 * between requests — no session, no per-connection state — so a client may reconnect,
 * retry or run several calls in parallel without the server holding anything that could
 * drift out of step with the database.
 *
 * An unauthenticated request is answered with a 401 carrying an RFC 9728
 * `WWW-Authenticate: Bearer resource_metadata=...` challenge. That header is what turns
 * `claude mcp add` into an OAuth flow rather than an error: it tells the client exactly
 * where to find the protected-resource metadata, and from there the authorization server.
 */
export async function mcpRoutes(app: FastifyInstance, opts: McpRouteOptions): Promise<void> {
  const issuer = issuerFrom(opts.config.publicUrl);
  const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource${RESOURCE_PATH}`;
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl}"`;

  function unauthorized(reply: FastifyReply): FastifyReply {
    return reply
      .code(401)
      .header('WWW-Authenticate', challenge)
      .header('cache-control', 'no-store')
      .send({error: 'invalid_token', error_description: 'A valid bearer token is required.'});
  }

  function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const identity = authenticateBearer(app.db, req.headers.authorization);
    if (!identity) {
      unauthorized(reply);
      return undefined;
    }
    return identity;
  }

  app.post(RESOURCE_PATH, async (req, reply) => {
    const identity = authenticate(req, reply);
    if (!identity) return reply;

    const server = buildMcpServer({db: app.db, hub: app.hub, ...identity});
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session id is issued, and none is expected back.
      sessionIdGenerator: undefined,
      // One JSON response per request rather than an SSE stream. Every tool here answers
      // exactly once (`wait_for_work` just answers late), so a stream would buy nothing
      // and would make the endpoint harder to drive with an ordinary HTTP client.
      enableJsonResponse: true,
    });

    // Fastify must not also try to answer: the transport writes the response itself.
    reply.hijack();

    // The server and transport live for one request. Closing them when the response ends
    // releases the hub subscription a parked `wait_for_work` holds, on every exit path
    // including a client that hung up mid-wait.
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      app.log.error({err}, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, {'content-type': 'application/json'});
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end(
          JSON.stringify({jsonrpc: '2.0', error: {code: INTERNAL_ERROR, message: 'Internal server error'}, id: null}),
        );
      }
    }
    return reply;
  });

  // The Streamable HTTP spec lets a server decline the optional server-to-client stream
  // and the session teardown; 405 is the answer clients are written to expect, and is
  // quieter than a 404 they have to interpret. Still behind the token, so neither one
  // tells an anonymous caller anything.
  for (const route of [app.get.bind(app), app.delete.bind(app)]) {
    route(RESOURCE_PATH, async (req: FastifyRequest, reply: FastifyReply) => {
      const identity = authenticate(req, reply);
      if (!identity) return reply;
      return reply
        .code(405)
        .header('allow', 'POST')
        .send({jsonrpc: '2.0', error: {code: CONNECTION_CLOSED, message: 'Method not allowed.'}, id: null});
    });
  }
}
