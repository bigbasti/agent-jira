import {QueryClientProvider, type QueryClient} from '@tanstack/react-query';
import {renderHook, waitFor} from '@testing-library/react';
import type {ReactNode} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {useAgents, useConfig, useRenameAgent, useRevokeAgent, useSetAutonomous} from './agent-queries.js';
import {BOARD_KEY} from './board-queries.js';
import {makeAgent, makeBoard} from '../testing/fixtures.js';
import {createTestQueryClient, jsonResponse, mockFetch} from '../testing/render.js';
import type {BoardSnapshot} from '../../shared/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWithClient<T>(useHook: () => T, client: QueryClient = createTestQueryClient()) {
  const wrapper = ({children}: {children: ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {...renderHook(useHook, {wrapper}), client};
}

describe('useAgents', () => {
  it("reads the board's agents — the same live-updated list the strip renders", () => {
    const client = createTestQueryClient();
    client.setQueryData(BOARD_KEY, makeBoard({agents: [makeAgent({id: 'a1', name: 'Night shift'})]}));

    const {result} = renderWithClient(() => useAgents(), client);

    expect(result.current.data?.map(a => a.id)).toEqual(['a1']);
  });

  it('is empty before the board has loaded', () => {
    const {result} = renderWithClient(() => useAgents());
    expect(result.current.data).toBeUndefined();
  });
});

describe('useSetAutonomous', () => {
  it("patches an agent's autonomous flag and updates it in the board cache", async () => {
    mockFetch().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === 'PATCH' && path === '/api/agents/a1') {
        expect(init.body).toBe(JSON.stringify({autonomous: true}));
        return jsonResponse(200, makeAgent({id: 'a1', autonomous: true}));
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const client = createTestQueryClient();
    client.setQueryData(BOARD_KEY, makeBoard({agents: [makeAgent({id: 'a1', autonomous: false})]}));

    const {result} = renderWithClient(() => useSetAutonomous(), client);
    result.current.mutate({agentId: 'a1', autonomous: true});

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const agents = client.getQueryData<BoardSnapshot>(BOARD_KEY)?.agents ?? [];
    expect(agents.find(a => a.id === 'a1')?.autonomous).toBe(true);
  });
});

describe('useRenameAgent', () => {
  it("patches an agent's name and updates it in the board cache", async () => {
    mockFetch().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === 'PATCH' && path === '/api/agents/a1') {
        expect(init.body).toBe(JSON.stringify({name: 'New name'}));
        return jsonResponse(200, makeAgent({id: 'a1', name: 'New name'}));
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const client = createTestQueryClient();
    client.setQueryData(BOARD_KEY, makeBoard({agents: [makeAgent({id: 'a1', name: 'Old name'})]}));

    const {result} = renderWithClient(() => useRenameAgent(), client);
    result.current.mutate({agentId: 'a1', name: 'New name'});

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const agents = client.getQueryData<BoardSnapshot>(BOARD_KEY)?.agents ?? [];
    expect(agents.find(a => a.id === 'a1')?.name).toBe('New name');
  });
});

describe('useConfig', () => {
  it('fetches the mcp url from the server, never hardcoding it', async () => {
    mockFetch().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/config') {
        return jsonResponse(200, {publicUrl: 'https://board.example', mcpUrl: 'https://board.example/mcp'});
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    const {result} = renderWithClient(() => useConfig());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({publicUrl: 'https://board.example', mcpUrl: 'https://board.example/mcp'});
  });
});

describe('useRevokeAgent', () => {
  it('deletes the agent and refetches the board', async () => {
    const board = makeBoard({agents: [makeAgent({id: 'a1'})]});
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === 'DELETE' && path === '/api/agents/a1') return jsonResponse(204);
      if (path === '/api/board') return jsonResponse(200, makeBoard({agents: []}));
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const client = createTestQueryClient();
    client.setQueryData(BOARD_KEY, board);

    const {result} = renderWithClient(() => useRevokeAgent(), client);
    result.current.mutate('a1');

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1', expect.objectContaining({method: 'DELETE'}));
  });
});
