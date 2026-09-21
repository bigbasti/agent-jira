/**
 * Thin fetch wrapper for the JSON API.
 *
 * The session is an HttpOnly cookie, so every request goes out with
 * `credentials: 'include'` and nothing else. Failures always arrive as an `ApiError`
 * carrying a sentence a person can read — the server's `{error: '<code>'}` bodies are
 * translated here so no screen ever has to render a raw code.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again.',
  invalid_credentials: "That email and password don't match an account.",
  conflict: 'That email is already registered. Sign in instead.',
  invalid_request: 'Some of those details are not valid. Check the form and try again.',
  not_found: 'That is no longer there — it may have been deleted.',
  transition_refused: 'That move is not allowed right now.',
  network: "Can't reach the server. Check your connection and try again.",
};

const FALLBACK_MESSAGE = 'Something went wrong. Try again.';

interface ErrorBody {
  error?: unknown;
  message?: unknown;
  reason?: unknown;
  /** OAuth's human-readable half (RFC 6749 §5.2) — written by this server, for a person. */
  error_description?: unknown;
}

/**
 * Codes whose `message`/`reason` is a sentence written for a person — a refused
 * transition names the rule that stopped it. Every other code's detail is machine text
 * (`invalid_request` carries raw validator output), so those use the table below.
 */
const CODES_WITH_HUMAN_REASON = new Set(['transition_refused']);

function firstSentence(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

function toApiError(status: number, payload: unknown): ApiError {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as ErrorBody;
  const code = typeof body.error === 'string' ? body.error : 'unknown';
  // An `error_description` only ever comes from this app's OAuth endpoints, where it is
  // the sentence written for the person reading the consent screen — always preferred
  // over the generic line the table would supply for the same code.
  const serverReason =
    firstSentence(body.error_description) ??
    (CODES_WITH_HUMAN_REASON.has(code) ? firstSentence(body.message, body.reason) : undefined);
  const message = serverReason ?? MESSAGES[code] ?? FALLBACK_MESSAGE;
  return new ApiError(status, code, message);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      ...(body === undefined
        ? {}
        : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
    });
  } catch {
    throw new ApiError(0, 'network', MESSAGES.network ?? FALLBACK_MESSAGE);
  }

  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);

  if (!response.ok) throw toApiError(response.status, payload);

  return payload as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  del: <T = void>(path: string): Promise<T> => request<T>('DELETE', path),
};
