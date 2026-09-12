import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {renderHook, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BOARD_KEY, useBoard, useMoveStory} from './board-queries.js';
import {makeBoard, makeStory} from '../testing/fixtures.js';
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
