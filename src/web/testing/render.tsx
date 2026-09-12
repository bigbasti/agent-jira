import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {render} from '@testing-library/react';
import type {ReactElement, ReactNode} from 'react';
import {vi} from 'vitest';

/**
 * A client with retries off so a rejected request surfaces immediately in tests. `gcTime`
 * is left at its default: at 0 an entry written by a mutation's `onSuccess` would be
 * collected before the assertion runs, because no component is observing it yet.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {retry: false},
      mutations: {retry: false},
    },
  });
}

export function renderWithClient(ui: ReactElement, client = createTestQueryClient()) {
  const wrapper = ({children}: {children: ReactNode}) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {client, ...render(ui, {wrapper})};
}

/** Minimal stand-in for the parts of `Response` the api client touches. */
export function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  } as Response;
}

/** Installs a `fetch` spy on globalThis and returns it. */
export function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A promise with its settle functions exposed, for asserting in-flight states. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}
