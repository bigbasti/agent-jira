import {afterEach, describe, expect, it, vi} from 'vitest';
import {ApiError, api} from './api.js';
import {jsonResponse, mockFetch} from '../testing/render.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('sends JSON with the session cookie attached', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(200, {id: 'u1'}));

    const result = await api.post<{id: string}>('/api/auth/login', {email: 'a@b.co'});

    expect(result).toEqual({id: 'u1'});
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBe(JSON.stringify({email: 'a@b.co'}));
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('turns an error code into a sentence a person can read', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(401, {error: 'invalid_credentials'}));

    const err = await api.post('/api/auth/login', {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiError = err as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe('invalid_credentials');
    expect(apiError.message).toBe("That email and password don't match an account.");
  });

  it('prefers the reason the server gives for a refused move', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(
      jsonResponse(409, {error: 'transition_refused', message: 'Cannot move a story from draft to accepted.'}),
    );

    const err = (await api.patch('/api/stories/s1', {status: 'accepted'}).catch((e: unknown) => e)) as ApiError;

    expect(err.message).toBe('Cannot move a story from draft to accepted.');
  });

  it('falls back to a readable message for an unrecognised code', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(500, {error: 'kaboom_internal'}));

    const err = (await api.get('/api/board').catch((e: unknown) => e)) as ApiError;

    expect(err.message).not.toContain('kaboom_internal');
    expect(err.message).toMatch(/went wrong/i);
  });

  it('resolves with nothing for an empty 204', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(204));

    await expect(api.post<void>('/api/auth/logout')).resolves.toBeUndefined();
  });

  it('reports an unreachable server instead of the raw fetch failure', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const err = (await api.get('/api/me').catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/reach the server/i);
  });

  it('deletes with the DELETE verb and no body', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(204));

    await api.del('/api/stories/s1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});
