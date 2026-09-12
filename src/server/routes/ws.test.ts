import type {AddressInfo} from 'node:net';
import {describe, it, expect, vi} from 'vitest';
import {WebSocket} from 'ws';
import {createHarness} from '../testing/harness.js';
import type {ServerEvent} from '../../shared/types.js';

/** Starts `app` listening on an ephemeral port and returns its `ws://.../ws` URL. */
async function listen(app: Awaited<ReturnType<typeof createHarness>>['app']): Promise<string> {
  await app.listen({port: 0});
  const {port} = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/ws`;
}

/** Collects every JSON message received on `socket` into an array, in order. */
function collectMessages(socket: WebSocket): ServerEvent[] {
  const messages: ServerEvent[] = [];
  socket.on('message', data => {
    messages.push(JSON.parse(data.toString()) as ServerEvent);
  });
  return messages;
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function onceClose(socket: WebSocket): Promise<{code: number}> {
  return new Promise(resolve => {
    socket.once('close', code => resolve({code}));
  });
}

describe('GET /ws', () => {
  it('sends hello immediately, then delivers events published on the hub for that user', async () => {
    const h = await createHarness();
    const {cookie, user} = await h.register();
    const url = await listen(h.app);

    const socket = new WebSocket(url, {headers: {cookie}});
    const messages = collectMessages(socket);
    await onceOpen(socket);

    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]).toEqual({type: 'hello'});

    h.app.hub.publish(user.id, {type: 'story.deleted', id: 's1'});

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]).toEqual({type: 'story.deleted', id: 's1'});

    socket.close();
  });

  it('closes an unauthenticated connection with code 4401 instead of serving it', async () => {
    const h = await createHarness();
    const url = await listen(h.app);

    const socket = new WebSocket(url);
    const closed = onceClose(socket);
    // The handshake itself succeeds (the upgrade already happened); the server then
    // rejects because there is no session — it must not silently stay open.
    await onceOpen(socket);

    const {code} = await closed;
    expect(code).toBe(4401);
  });

  it('never delivers events for one user to another user’s socket', async () => {
    const h = await createHarness();
    const {cookie: cookieA, user: userA} = await h.register('a@example.com');
    const {cookie: cookieB} = await h.register('b@example.com');
    const url = await listen(h.app);

    const socketA = new WebSocket(url, {headers: {cookie: cookieA}});
    const socketB = new WebSocket(url, {headers: {cookie: cookieB}});
    const messagesA = collectMessages(socketA);
    const messagesB = collectMessages(socketB);
    await Promise.all([onceOpen(socketA), onceOpen(socketB)]);

    // Wait for both `hello`s so we know both subscriptions are established before publishing.
    await vi.waitFor(() => expect(messagesA).toHaveLength(1));
    await vi.waitFor(() => expect(messagesB).toHaveLength(1));

    h.app.hub.publish(userA.id, {type: 'story.deleted', id: 'only-for-a'});

    await vi.waitFor(() => expect(messagesA).toHaveLength(2));
    // Give a stray delivery to B a chance to arrive before asserting it didn't.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(messagesB).toHaveLength(1);

    socketA.close();
    socketB.close();
  });

  it('unsubscribes from the hub when the socket closes', async () => {
    const h = await createHarness();
    const {cookie, user} = await h.register();
    const url = await listen(h.app);

    const socket = new WebSocket(url, {headers: {cookie}});
    await onceOpen(socket);
    await vi.waitFor(() => expect(h.app.hub.subscriberCount(user.id)).toBe(1));

    socket.close();
    await onceClose(socket);

    await vi.waitFor(() => expect(h.app.hub.subscriberCount(user.id)).toBe(0));
  });

  it('terminates a socket that misses two consecutive heartbeat pongs', async () => {
    const h = await createHarness({wsHeartbeatIntervalMs: 20});
    const {cookie} = await h.register();
    const url = await listen(h.app);

    // autoPong: false so this client never answers the server's pings.
    const socket = new WebSocket(url, {headers: {cookie}, autoPong: false});
    await onceOpen(socket);

    const {code} = await onceClose(socket);
    // socket.terminate() ends the connection abruptly (no close handshake), which a
    // client observes as an abnormal closure.
    expect(code).toBe(1006);
  }, 2000);

  it('keeps a responsive socket alive across several heartbeat intervals', async () => {
    const h = await createHarness({wsHeartbeatIntervalMs: 20});
    const {cookie} = await h.register();
    const url = await listen(h.app);

    // Default `ws` client behavior auto-responds to pings with pongs.
    const socket = new WebSocket(url, {headers: {cookie}});
    await onceOpen(socket);

    await new Promise(resolve => setTimeout(resolve, 100)); // several heartbeat intervals
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.close();
  });
});
