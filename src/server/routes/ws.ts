import type {FastifyInstance} from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import {isSameOrigin} from '../http/origin.js';

export interface WsRouteOptions {
  /**
   * Heartbeat ping interval in ms. A socket that misses two consecutive pongs is
   * terminated. Defaults to 30s in production; tests inject a short interval so they
   * don't have to wait 30 seconds for heartbeat behavior to be observable.
   */
  wsHeartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;

/**
 * Registers `@fastify/websocket` and the `GET /ws` route.
 *
 * Authenticates from the same session cookie the REST routes use (the session plugin's
 * `onRequest` hook runs before this handler, same as any other route) — an unauthenticated
 * connection is closed with code 4401 rather than served, and one opened from another
 * origin with 4403. An authenticated connection is
 * subscribed to `app.hub` for its user, sent `{type: 'hello'}` immediately, and kept alive
 * with a ping/pong heartbeat; both the hub subscription and the heartbeat timer are torn
 * down on close so neither leaks.
 */
export async function registerWsRoute(app: FastifyInstance, opts: WsRouteOptions = {}): Promise<void> {
  const heartbeatIntervalMs = opts.wsHeartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  await app.register(fastifyWebsocket);

  app.get('/ws', {websocket: true}, (socket, req) => {
    // Session presence alone is the auth check here (no `requireUser`-style lookup of the
    // user row) — that's only safe because `sessions.user_id` has an `onDelete: 'cascade'`
    // FK, so a session can never outlive its user. If that FK is ever relaxed, this check
    // must be upgraded to look the user up, like `requireUser` does.
    const userId = req.session.userId;
    if (!userId) {
      socket.close(4401, 'unauthorized');
      return;
    }

    // The session cookie is `SameSite=Lax`, which keeps it off a cross-site *fetch* — but
    // a WebSocket upgrade is not covered by that, so without this check any page the human
    // happens to visit could open a live, cookie-authenticated feed of their whole board.
    // Same rule as the OAuth consent decision (`http/origin.ts`).
    if (!isSameOrigin(req.headers.origin, req.headers.host)) {
      socket.close(4403, 'forbidden');
      return;
    }

    socket.send(JSON.stringify({type: 'hello'}));

    const unsubscribe = app.hub.subscribe(userId, event => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    let missedPongs = 0;
    socket.on('pong', () => {
      missedPongs = 0;
    });

    const heartbeat = setInterval(() => {
      if (missedPongs >= MAX_MISSED_PONGS) {
        socket.terminate();
        return;
      }
      missedPongs += 1;
      socket.ping();
    }, heartbeatIntervalMs);
    heartbeat.unref();

    socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
