import {useEffect, useState} from 'react';
import {useQueryClient, type QueryClient} from '@tanstack/react-query';
import {BOARD_KEY, storyUpdatesKey, upsertAgent, upsertStory} from './board-queries.js';
import type {BoardSnapshot, ServerEvent, StoryUpdate} from '../../shared/types.js';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15_000;

/** The `hello` frame `registerWsRoute` sends immediately on every fresh connection. */
interface HelloFrame {
  type: 'hello';
}

type ServerFrame = HelloFrame | ServerEvent;

/**
 * The slice of the DOM `WebSocket` interface this hook actually uses, narrowed so tests
 * can inject a fake without implementing the rest of the browser API (`send`, `readyState`,
 * binary framing, …none of which this hook touches). The listener parameter is loosely
 * typed (`any`, same as `EventListener` itself) so a real `WebSocket` structurally
 * satisfies this interface without a cast, and a fake only has to read `.data` off it.
 */
export interface LiveSocket {
  addEventListener(type: 'open' | 'message' | 'close', listener: (event: any) => void): void;
  removeEventListener(type: 'open' | 'message' | 'close', listener: (event: any) => void): void;
  close(): void;
}

export interface UseLiveBoardOptions {
  /** Defaults to opening a real `WebSocket` at `/ws`; tests inject a fake here. */
  socketFactory?: () => LiveSocket;
}

function defaultSocketFactory(): LiveSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/ws`);
}

/**
 * Applies one server event to the board cache (and, for `story.update`, a story's
 * timeline cache), patching only what the event names. This mirrors the discipline the
 * mutations in `board-queries.ts` already follow: a whole-snapshot write here would
 * clobber whatever a concurrent mutation — or a drag rollback — has since corrected.
 */
function applyServerEvent(client: QueryClient, event: ServerEvent): void {
  switch (event.type) {
    case 'story.created':
    case 'story.updated':
    case 'story.moved':
      upsertStory(client, event.story);
      return;

    case 'story.deleted':
      client.setQueryData<BoardSnapshot>(BOARD_KEY, board =>
        board ? {...board, stories: board.stories.filter(story => story.id !== event.id)} : board,
      );
      return;

    // Patched in place — only the two progress fields — so the progress bar animates
    // and the card it lives on does not remount.
    case 'story.progress':
      client.setQueryData<BoardSnapshot>(BOARD_KEY, board =>
        board
          ? {
              ...board,
              stories: board.stories.map(story =>
                story.id === event.id
                  ? {...story, progressPct: event.progressPct, progressLabel: event.progressLabel}
                  : story,
              ),
            }
          : board,
      );
      return;

    // Only appended when that story's timeline is already cached (i.e. its detail dialog
    // has been opened at least once) — an updater that returns `undefined` leaves the
    // cache untouched instead of creating a new, partial entry for a story nobody is
    // watching. See `QueryClient.setQueryData`.
    case 'story.update':
      client.setQueryData<StoryUpdate[]>(storyUpdatesKey(event.storyId), updates =>
        updates ? [...updates, event.update] : undefined,
      );
      return;

    case 'agent.updated':
      upsertAgent(client, event.agent);
      return;

    // A revoked agent — see `revokeAgent` in services/agents.ts. The story it may have
    // held arrives separately as its own `story.updated` event.
    case 'agent.deleted':
      client.setQueryData<BoardSnapshot>(BOARD_KEY, board =>
        board ? {...board, agents: board.agents.filter(agent => agent.id !== event.id)} : board,
      );
      return;

    // Projects live inside the board snapshot and have no cache key of their own, so
    // refetching the board is what "invalidate projects" means here.
    case 'project.changed':
      void client.invalidateQueries({queryKey: BOARD_KEY});
      return;
  }
}

/**
 * Keeps the `['board']` cache live over `/ws`: one connection per mounted instance,
 * reconnecting on drop with exponential backoff (1s, 2s, 4s, … capped at 15s) and
 * refetching the whole board on every reconnect so any event missed while disconnected
 * self-heals. Every other event patches the cache surgically — see `applyServerEvent`.
 */
export function useLiveBoard(options: UseLiveBoardOptions = {}): {connected: boolean} {
  const client = useQueryClient();
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let socket: LiveSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everConnected = false;

    function handleOpen() {
      if (cancelled) return;
      attempt = 0;
      setConnected(true);
      // The very first connect is covered by the board's own initial load; only a
      // reconnect — after the socket dropped — needs a refetch to self-heal.
      if (everConnected) void client.invalidateQueries({queryKey: BOARD_KEY});
      everConnected = true;
    }

    function handleMessage(event: {data: string}) {
      if (cancelled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      // The server only ever sends an object with a string `type`, but this is the one
      // boundary where that is someone else's promise, not this file's — a malformed or
      // unrecognised frame is ignored rather than trusted enough to read `.type` off it.
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as {type?: unknown}).type !== 'string') {
        return;
      }
      const frame = parsed as ServerFrame;
      if (frame.type === 'hello') return;
      applyServerEvent(client, frame);
    }

    function handleClose() {
      if (cancelled) return;
      if (socket) teardown(socket);
      socket = null;
      setConnected(false);
      scheduleReconnect();
    }

    function teardown(target: LiveSocket) {
      target.removeEventListener('open', handleOpen);
      target.removeEventListener('message', handleMessage);
      target.removeEventListener('close', handleClose);
    }

    function scheduleReconnect() {
      // Defensive: `handleClose` runs at most once per socket in normal operation (its own
      // teardown removes its `close` listener before this fires again), but a socket that
      // ever dispatched `close` twice would otherwise leave two reconnect timers pending —
      // the stale one from the first dispatch, plus this new one.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      if (cancelled) return;
      const next = socketFactory();
      socket = next;
      next.addEventListener('open', handleOpen);
      next.addEventListener('message', handleMessage);
      next.addEventListener('close', handleClose);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        teardown(socket);
        socket.close();
      }
    };
  }, [client, socketFactory]);

  return {connected};
}
