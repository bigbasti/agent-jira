import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {renderHook, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BOARD_KEY, upsertAgent, useBoard, useMoveStory, usePlayStory, useStopStory} from './board-queries.js';
import {makeAgent, makeBoard, makeStory} from '../testing/fixtures.js';
import {createTestQueryClient, deferred, jsonResponse, mockFetch} from '../testing/render.js';
import type {BoardSnapshot, Story} from '../../shared/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BOARD = makeBoard({
  stories: [
    makeStory({id: 'd1', status: 'draft', rank: 'A', title: 'Sketch it'}),
    makeStory({id: 't1', status: 'todo', rank: 'A'}),
    makeStory({id: 't2', status: 'todo', rank: 'B'}),
  ],
});

/** Routes the two endpoints the board uses; `move` decides what the POST resolves to. */
function routeFetch(move: () => Promise<Response>, board: BoardSnapshot = BOARD) {
  const fetchMock = mockFetch();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/board') return jsonResponse(200, board);
    if (init?.method === 'POST' && path.endsWith('/move')) return move();
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
  });
  return fetchMock;
}

function renderBoardHooks(client: QueryClient = createTestQueryClient()) {
  const wrapper = ({children}: {children: ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => ({board: useBoard(), move: useMoveStory()}), {wrapper});
  return {...view, client};
}

function cached(client: QueryClient): Story[] {
  return client.getQueryData<BoardSnapshot>(BOARD_KEY)?.stories ?? [];
}

function storyIn(client: QueryClient, id: string): Story {
  const story = cached(client).find(candidate => candidate.id === id);
  if (!story) throw new Error(`no story ${id} in the cache`);
  return story;
}

describe('useBoard', () => {
  it('loads the whole board in one request', async () => {
    const fetchMock = routeFetch(() => Promise.reject(new Error('no move expected')));
    const {result} = renderBoardHooks();

    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    expect(result.current.board.data?.stories).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith('/api/board', expect.objectContaining({method: 'GET'}));
  });

  it('surfaces a failed load as a readable error', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(401, {error: 'unauthorized'}));
    const {result} = renderBoardHooks();

    await waitFor(() => expect(result.current.board.isError).toBe(true));

    expect(result.current.board.error?.message).toBe('Your session has ended. Sign in again.');
  });
});

describe('useMoveStory', () => {
  it('posts the move the drag computed', async () => {
    const fetchMock = routeFetch(async () => jsonResponse(200, makeStory({id: 'd1', status: 'todo'})));
    const {result} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    result.current.move.mutate({storyId: 'd1', status: 'todo', beforeId: 't1', afterId: 't2'});

    await waitFor(() => expect(result.current.move.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/stories/d1/move',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({status: 'todo', beforeId: 't1', afterId: 't2'}),
      }),
    );
  });

  it('patches the board cache before the server answers', async () => {
    const answer = deferred<Response>();
    routeFetch(() => answer.promise);
    const {result, client} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    result.current.move.mutate({storyId: 'd1', status: 'todo', beforeId: 't1', afterId: 't2'});

    await waitFor(() => expect(storyIn(client, 'd1').status).toBe('todo'));
    answer.resolve(jsonResponse(200, makeStory({id: 'd1', status: 'todo'})));
    await waitFor(() => expect(result.current.move.isSuccess).toBe(true));
  });

  it('ranks the moved story between the neighbours it was dropped between', async () => {
    const answer = deferred<Response>();
    routeFetch(() => answer.promise);
    const {result, client} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    result.current.move.mutate({storyId: 'd1', status: 'todo', beforeId: 't1', afterId: 't2'});

    await waitFor(() => expect(storyIn(client, 'd1').status).toBe('todo'));
    const rank = storyIn(client, 'd1').rank;
    expect(rank > 'A').toBe(true);
    expect(rank < 'B').toBe(true);
    answer.resolve(jsonResponse(200, makeStory({id: 'd1', status: 'todo'})));
    await waitFor(() => expect(result.current.move.isSuccess).toBe(true));
  });

  it('ranks a story dropped at the end of a column after everything in it', async () => {
    const answer = deferred<Response>();
    routeFetch(() => answer.promise);
    const {result, client} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    result.current.move.mutate({storyId: 'd1', status: 'todo', beforeId: 't2', afterId: null});

    await waitFor(() => expect(storyIn(client, 'd1').rank > 'B').toBe(true));
    expect(storyIn(client, 'd1').status).toBe('todo');
    answer.resolve(jsonResponse(200, makeStory({id: 'd1', status: 'todo'})));
    await waitFor(() => expect(result.current.move.isSuccess).toBe(true));
  });

  it('rolls the board back and reports the server reason when a move is refused', async () => {
    routeFetch(async () =>
      jsonResponse(409, {
        error: 'transition_refused',
        message: 'Agents cannot accept stories — only a human can.',
      }),
    );
    const {result, client} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    result.current.move.mutate({storyId: 'd1', status: 'accepted', beforeId: null, afterId: null});

    await waitFor(() => expect(result.current.move.isError).toBe(true));
    expect(result.current.move.error?.message).toBe('Agents cannot accept stories — only a human can.');
    expect(storyIn(client, 'd1').status).toBe('draft');
    expect(storyIn(client, 'd1').rank).toBe('A');
  });

  it('reverts the rank, not just the status, when a rank-changing move is refused', async () => {
    // Unlike the empty-column case above, dropping between two named neighbours gives
    // `optimisticRank` a real range to pick a midpoint from — this is the case a rollback
    // that only reset `status` would miss. The move response is held open (as the other
    // rank-asserting tests above do) so the optimistic value is there to observe before it
    // resolves.
    const answer = deferred<Response>();
    routeFetch(() => answer.promise);
    const {result, client} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    result.current.move.mutate({storyId: 'd1', status: 'todo', beforeId: 't1', afterId: 't2'});

    await waitFor(() => expect(storyIn(client, 'd1').status).toBe('todo'));
    const optimisticRank = storyIn(client, 'd1').rank;
    expect(optimisticRank > 'A').toBe(true);
    expect(optimisticRank < 'B').toBe(true);

    answer.resolve(jsonResponse(409, {error: 'transition_refused', message: 'Not allowed.'}));
    await waitFor(() => expect(result.current.move.isError).toBe(true));
    expect(storyIn(client, 'd1').status).toBe('draft');
    expect(storyIn(client, 'd1').rank).toBe('A');
  });

  it("does not let one refused move roll back a second, still-optimistic move's position", async () => {
    // Two overlapping drags land on different stories. The first (d1 into todo) is
    // refused; the second (t1 reordering within todo) is still in flight. A rollback that
    // restores the whole snapshot — rather than just the story it moved — would stomp t1's
    // optimistic rank with a copy of the board that predates it.
    const firstAnswer = deferred<Response>();
    const secondAnswer = deferred<Response>();
    // Every board GET after the first is a settle-triggered refetch. Held open here, so
    // the assertions below observe the rollback itself rather than a refetch racing ahead
    // of it — in production that refetch reads the server's authoritative state, but this
    // test's server-double would otherwise just echo back the original, pre-move `BOARD`.
    const boardRefetches: Array<(response: Response) => void> = [];
    let boardCalls = 0;
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/board') {
        boardCalls += 1;
        if (boardCalls === 1) return jsonResponse(200, BOARD);
        const refetch = deferred<Response>();
        boardRefetches.push(refetch.resolve);
        return refetch.promise;
      }
      if (path === '/api/stories/d1/move') return firstAnswer.promise;
      if (path === '/api/stories/t1/move') return secondAnswer.promise;
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const {result, client} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));

    result.current.move.mutate({storyId: 'd1', status: 'todo', beforeId: 't1', afterId: 't2'});
    await waitFor(() => expect(storyIn(client, 'd1').status).toBe('todo'));

    result.current.move.mutate({storyId: 't1', status: 'todo', beforeId: 't2', afterId: null});
    await waitFor(() => expect(storyIn(client, 't1').rank > 'B').toBe(true));
    const t1OptimisticRank = storyIn(client, 't1').rank;

    firstAnswer.resolve(jsonResponse(409, {error: 'transition_refused', message: 'Not allowed.'}));
    await waitFor(() => expect(storyIn(client, 'd1').status).toBe('draft'));
    expect(storyIn(client, 'd1').rank).toBe('A');

    // t1's optimistic move survived d1's rollback untouched.
    expect(storyIn(client, 't1').status).toBe('todo');
    expect(storyIn(client, 't1').rank).toBe(t1OptimisticRank);

    // Let everything settle so nothing is left dangling.
    boardRefetches.forEach(resolve => resolve(jsonResponse(200, BOARD)));
    secondAnswer.resolve(jsonResponse(200, makeStory({id: 't1', status: 'todo'})));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/stories/t1/move', expect.anything()));
  });

  it('refetches the board once the move settles, so other cards pick up the change', async () => {
    const fetchMock = routeFetch(async () => jsonResponse(200, makeStory({id: 'd1', status: 'todo'})));
    const {result} = renderBoardHooks();
    await waitFor(() => expect(result.current.board.isSuccess).toBe(true));
    const loadsBefore = fetchMock.mock.calls.filter(call => call[0] === '/api/board').length;

    result.current.move.mutate({storyId: 'd1', status: 'todo', beforeId: null, afterId: 't1'});

    await waitFor(() => {
      const loadsAfter = fetchMock.mock.calls.filter(call => call[0] === '/api/board').length;
      expect(loadsAfter).toBe(loadsBefore + 1);
    });
  });
});

/** Renders one hook against a client already seeded with `BOARD`, mocking `fetch`. */
function renderWithSeededBoard<T>(useHook: () => T, routeMock: (fetchMock: ReturnType<typeof mockFetch>) => void) {
  const fetchMock = mockFetch();
  routeMock(fetchMock);
  const client = createTestQueryClient();
  client.setQueryData(BOARD_KEY, BOARD);
  const wrapper = ({children}: {children: ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {...renderHook(useHook, {wrapper}), client, fetchMock};
}

describe('usePlayStory', () => {
  it('posts to the play endpoint and patches the returned story into the board cache', async () => {
    const {result, client, fetchMock} = renderWithSeededBoard(() => usePlayStory(), fetchMock => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (init?.method === 'POST' && path === '/api/stories/t1/play') {
          return jsonResponse(200, makeStory({id: 't1', status: 'todo', playRequestedAt: 1234}));
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
      });
    });

    result.current.mutate('t1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith('/api/stories/t1/play', expect.objectContaining({method: 'POST'}));
    expect(storyIn(client, 't1').playRequestedAt).toBe(1234);
  });

  it('surfaces a refusal (e.g. the story is blocked) as a readable error', async () => {
    const {result} = renderWithSeededBoard(() => usePlayStory(), fetchMock => {
      fetchMock.mockResolvedValue(
        jsonResponse(409, {error: 'transition_refused', message: 'That story is blocked and cannot be claimed yet.'}),
      );
    });

    result.current.mutate('t1');

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('That story is blocked and cannot be claimed yet.');
  });
});

describe('useStopStory', () => {
  it('posts to the stop endpoint and patches the returned story into the board cache', async () => {
    const {result, client, fetchMock} = renderWithSeededBoard(() => useStopStory(), fetchMock => {
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (init?.method === 'POST' && path === '/api/stories/t1/stop') {
          return jsonResponse(200, makeStory({id: 't1', status: 'in_progress', stopRequested: true}));
        }
        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
      });
    });

    result.current.mutate('t1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith('/api/stories/t1/stop', expect.objectContaining({method: 'POST'}));
    expect(storyIn(client, 't1').stopRequested).toBe(true);
  });
});

describe('upsertAgent', () => {
  it('replaces an existing agent in the board cache by id', () => {
    const client = createTestQueryClient();
    client.setQueryData(BOARD_KEY, makeBoard({agents: [makeAgent({id: 'a1', status: 'idle'})]}));

    upsertAgent(client, makeAgent({id: 'a1', status: 'working'}));

    const agents = client.getQueryData<BoardSnapshot>(BOARD_KEY)?.agents ?? [];
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('working');
  });

  it('appends an agent that is not already in the cache', () => {
    const client = createTestQueryClient();
    client.setQueryData(BOARD_KEY, makeBoard({agents: []}));

    upsertAgent(client, makeAgent({id: 'a1'}));

    expect(client.getQueryData<BoardSnapshot>(BOARD_KEY)?.agents.map(a => a.id)).toEqual(['a1']);
  });
});
