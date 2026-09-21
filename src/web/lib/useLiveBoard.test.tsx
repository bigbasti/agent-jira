import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {act, renderHook, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BOARD_KEY, storyUpdatesKey} from './board-queries.js';
import {useLiveBoard, type LiveSocket} from './useLiveBoard.js';
import {makeAgent, makeBoard, makeStory, makeUpdate} from '../testing/fixtures.js';
import {createTestQueryClient} from '../testing/render.js';
import type {BoardSnapshot, ServerEvent} from '../../shared/types.js';

/**
 * A fake `WebSocket`, narrowed to the events `useLiveBoard` listens for. Tests drive it
 * directly with `emitOpen`/`emitMessage`/`emitClose` — no real socket, no network.
 */
class FakeSocket implements LiveSocket {
  readonly close = vi.fn();
  private readonly listeners: Record<'open' | 'message' | 'close', Array<(event: unknown) => void>> = {
    open: [],
    message: [],
    close: [],
  };

  addEventListener(type: 'open' | 'message' | 'close', listener: (event: unknown) => void): void {
    this.listeners[type].push(listener);
  }

  removeEventListener(type: 'open' | 'message' | 'close', listener: (event: unknown) => void): void {
    this.listeners[type] = this.listeners[type].filter(candidate => candidate !== listener);
  }

  emitOpen(): void {
    this.listeners.open.forEach(listener => listener({}));
  }

  emitMessage(payload: {type: 'hello'} | ServerEvent): void {
    this.listeners.message.forEach(listener => listener({data: JSON.stringify(payload)}));
  }

  emitClose(): void {
    this.listeners.close.forEach(listener => listener({}));
  }
}

function renderLiveBoard(board: BoardSnapshot, client: QueryClient = createTestQueryClient()) {
  client.setQueryData(BOARD_KEY, board);
  const sockets: FakeSocket[] = [];
  const socketFactory = (): LiveSocket => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const wrapper = ({children}: {children: ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useLiveBoard({socketFactory}), {wrapper});
  return {...view, client, sockets};
}

/** `noUncheckedIndexedAccess` makes `sockets[i]` `FakeSocket | undefined` — this asserts. */
function socketAt(sockets: FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) throw new Error(`no socket at index ${index}`);
  return socket;
}

function board(client: QueryClient): BoardSnapshot {
  const data = client.getQueryData<BoardSnapshot>(BOARD_KEY);
  if (!data) throw new Error('board not seeded');
  return data;
}

function storyIn(client: QueryClient, id: string) {
  const story = board(client).stories.find(candidate => candidate.id === id);
  if (!story) throw new Error(`no story ${id} in the cache`);
  return story;
}

describe('useLiveBoard — connects and reflects connection state', () => {
  it('opens one socket on mount and reports connected once it opens', async () => {
    const {result, sockets} = renderLiveBoard(makeBoard());

    expect(sockets).toHaveLength(1);
    expect(result.current.connected).toBe(false);

    socketAt(sockets, 0).emitOpen();

    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  it('ignores the initial hello frame', () => {
    const seed = makeBoard({stories: [makeStory({id: 's1', title: 'Unchanged'})]});
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({type: 'hello'});

    // Nothing throws, nothing in the cache moves.
    expect(storyIn(client, 's1').title).toBe('Unchanged');
  });
});

describe('useLiveBoard — cache patches', () => {
  it('patches a story in the cache on story.updated', () => {
    const seed = makeBoard({
      stories: [
        makeStory({id: 's1', title: 'Old title', status: 'todo'}),
        makeStory({id: 's2', title: 'Untouched'}),
      ],
    });
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();
    const untouched = storyIn(client, 's2');

    socketAt(sockets, 0).emitMessage({
      type: 'story.updated',
      story: makeStory({id: 's1', title: 'New title', status: 'todo'}),
    });

    expect(storyIn(client, 's1').title).toBe('New title');
    // The story nobody touched is the exact same object — a true patch, not a snapshot swap.
    expect(storyIn(client, 's2')).toBe(untouched);
  });

  it('inserts a new story on story.created', () => {
    const seed = makeBoard({stories: [makeStory({id: 's1'})]});
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({type: 'story.created', story: makeStory({id: 's2', title: 'Brand new'})});

    expect(board(client).stories.map(s => s.id)).toEqual(['s1', 's2']);
  });

  it('moves a story between columns on story.moved', () => {
    const seed = makeBoard({stories: [makeStory({id: 's1', status: 'todo', rank: 'A'})]});
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({
      type: 'story.moved',
      story: makeStory({id: 's1', status: 'in_progress', rank: 'M'}),
    });

    const moved = storyIn(client, 's1');
    expect(moved.status).toBe('in_progress');
    expect(moved.rank).toBe('M');
  });

  it('updates only the progress fields on story.progress, leaving everything else untouched', () => {
    const seed = makeBoard({
      stories: [
        makeStory({id: 's1', title: 'Ship it', status: 'in_progress', progressPct: 10, progressLabel: 'Reading'}),
      ],
    });
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({
      type: 'story.progress',
      id: 's1',
      progressPct: 42,
      progressLabel: 'Writing tests',
    });

    const story = storyIn(client, 's1');
    expect(story.progressPct).toBe(42);
    expect(story.progressLabel).toBe('Writing tests');
    expect(story.title).toBe('Ship it');
    expect(story.status).toBe('in_progress');
  });

  it('removes a story on story.deleted', () => {
    const seed = makeBoard({stories: [makeStory({id: 's1'}), makeStory({id: 's2'})]});
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({type: 'story.deleted', id: 's1'});

    expect(board(client).stories.map(s => s.id)).toEqual(['s2']);
  });

  it('appends to the update timeline cache on story.update when that story is being watched', () => {
    const seed = makeBoard({stories: [makeStory({id: 's1'})]});
    const {client, sockets} = renderLiveBoard(seed);
    client.setQueryData(storyUpdatesKey('s1'), [makeUpdate({id: 'u1', storyId: 's1', body: 'first'})]);
    socketAt(sockets, 0).emitOpen();

    const update = makeUpdate({id: 'u2', storyId: 's1', body: 'second'});
    socketAt(sockets, 0).emitMessage({type: 'story.update', storyId: 's1', update});

    expect(client.getQueryData(storyUpdatesKey('s1'))).toEqual([
      makeUpdate({id: 'u1', storyId: 's1', body: 'first'}),
      update,
    ]);
  });

  it('does not create a timeline cache entry for a story nobody is watching', () => {
    const seed = makeBoard({stories: [makeStory({id: 's1'})]});
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({
      type: 'story.update',
      storyId: 's1',
      update: makeUpdate({id: 'u1', storyId: 's1'}),
    });

    expect(client.getQueryData(storyUpdatesKey('s1'))).toBeUndefined();
  });

  it('patches an agent on agent.updated, inserting it if new', () => {
    const seed = makeBoard({agents: [makeAgent({id: 'a1', status: 'idle'})]});
    const {client, sockets} = renderLiveBoard(seed);
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({type: 'agent.updated', agent: makeAgent({id: 'a1', status: 'working'})});
    socketAt(sockets, 0).emitMessage({type: 'agent.updated', agent: makeAgent({id: 'a2', status: 'idle'})});

    const agents = board(client).agents;
    expect(agents.find(a => a.id === 'a1')?.status).toBe('working');
    expect(agents.map(a => a.id)).toContain('a2');
  });

  it('invalidates the board on project.changed so projects are refetched', () => {
    const seed = makeBoard();
    const {client, sockets} = renderLiveBoard(seed);
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    socketAt(sockets, 0).emitOpen();

    socketAt(sockets, 0).emitMessage({type: 'project.changed'});

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({queryKey: BOARD_KEY}));
  });
});

describe('useLiveBoard — reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches the board after a reconnect, so any missed event self-heals', async () => {
    const {client, sockets} = renderLiveBoard(makeBoard());
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    socketAt(sockets, 0).emitOpen();
    expect(invalidateSpy).not.toHaveBeenCalled();

    socketAt(sockets, 0).emitClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);

    socketAt(sockets, 1).emitOpen();

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({queryKey: BOARD_KEY}));
  });

  it('reports disconnected while waiting to reconnect', () => {
    const {result, sockets} = renderLiveBoard(makeBoard());
    act(() => socketAt(sockets, 0).emitOpen());
    expect(result.current.connected).toBe(true);

    act(() => socketAt(sockets, 0).emitClose());

    expect(result.current.connected).toBe(false);
  });

  it('backs off exponentially between reconnect attempts, capped at 15s', async () => {
    const {sockets} = renderLiveBoard(makeBoard());
    expect(sockets).toHaveLength(1);

    // The socket never opens — every attempt fails immediately.
    socketAt(sockets, 0).emitClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2); // 1s

    socketAt(sockets, 1).emitClose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3); // 2s

    socketAt(sockets, 2).emitClose();
    await vi.advanceTimersByTimeAsync(3999);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(4); // 4s

    socketAt(sockets, 3).emitClose();
    await vi.advanceTimersByTimeAsync(7999);
    expect(sockets).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(5); // 8s

    socketAt(sockets, 4).emitClose();
    // Next would be 16s uncapped; the cap holds it at 15s instead.
    await vi.advanceTimersByTimeAsync(14999);
    expect(sockets).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(6); // capped at 15s
  });

  it('resets the backoff after a successful reconnect', async () => {
    const {sockets} = renderLiveBoard(makeBoard());
    socketAt(sockets, 0).emitClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2); // 1s

    socketAt(sockets, 1).emitOpen();
    socketAt(sockets, 1).emitClose();

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3); // back to 1s, not 2s
  });
});

describe('useLiveBoard — cleanup', () => {
  it('closes the socket and cancels any pending reconnect timer on unmount', async () => {
    vi.useFakeTimers();
    try {
      const {unmount, sockets} = renderLiveBoard(makeBoard());
      socketAt(sockets, 0).emitClose();

      unmount();

      expect(socketAt(sockets, 0).close).toHaveBeenCalledTimes(1);

      // No reconnect timer should fire after unmount — a leaked timer would create a
      // second socket here.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens only one socket for the lifetime of the hook instance', () => {
    const {sockets, rerender} = renderLiveBoard(makeBoard());
    rerender();
    rerender();

    expect(sockets).toHaveLength(1);
  });
});
