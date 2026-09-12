import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {App} from './App.js';
import {jsonResponse, mockFetch, renderWithClient} from './testing/render.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = {id: 'u1', email: 'dev@example.com', createdAt: 1};

/** Routes the app's requests to canned responses, keyed by path. */
function routeFetch(routes: Record<string, () => Response>) {
  const fetchMock = mockFetch();
  fetchMock.mockImplementation(async (path: string) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected request: ${path}`);
    return route();
  });
  return fetchMock;
}

describe('App', () => {
  it('shows the auth screen when there is no session', async () => {
    routeFetch({'/api/me': () => jsonResponse(401, {error: 'unauthorized'})});
    renderWithClient(<App />);

    expect(await screen.findByRole('tab', {name: 'Sign in'})).toBeInTheDocument();
  });

  it('shows the board for a signed-in user', async () => {
    routeFetch({'/api/me': () => jsonResponse(200, USER)});
    renderWithClient(<App />);

    expect(await screen.findByText('dev@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('tab', {name: 'Sign in'})).toBeNull();
  });

  it('returns to the auth screen after logging out', async () => {
    const user = userEvent.setup();
    let session: 'active' | 'ended' = 'active';
    const fetchMock = routeFetch({
      '/api/me': () => (session === 'active' ? jsonResponse(200, USER) : jsonResponse(401, {error: 'unauthorized'})),
      '/api/auth/logout': () => {
        session = 'ended';
        return jsonResponse(204);
      },
    });
    renderWithClient(<App />);

    await user.click(await screen.findByRole('button', {name: 'Log out'}));

    expect(await screen.findByRole('tab', {name: 'Sign in'})).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.anything()));
  });
});
