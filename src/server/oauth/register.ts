import {eq} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import type {Database} from '../db/index.js';
import {oauthClients} from '../db/schema.js';
import {OAuthError} from './errors.js';

/**
 * Dynamic client registration (RFC 7591).
 *
 * This endpoint is open to anyone who can reach the server — that is the point, it is
 * how `claude mcp add` gets a client_id without a human copying one around — so
 * everything it accepts is treated as hostile input:
 *  - the redirect uri set is the entire security boundary of the authorization code
 *    flow, so only loopback http and https are allowed in;
 *  - the client name is rendered on the consent screen, so it is stripped of everything
 *    that could be used to dress a request up as something else.
 * The route also rate limits by IP (see `routes/oauth.ts`) so the table cannot be filled
 * by a script.
 */

export const MAX_CLIENT_NAME_LENGTH = 100;
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;
const DEFAULT_CLIENT_NAME = 'Unnamed client';

/** C0/C1 controls — newlines and tabs included, since they can fake layout. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width and bidirectional-override characters: pure text-spoofing machinery. */
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Every character the URL parser strips or refuses to carry, plus the plain space. */
const URI_WHITESPACE = /[\u0000-\u0020\u007f]/;

/**
 * Makes an untrusted name safe to show a human.
 *
 * The consent screen renders names as text (React escapes, so markup is inert), but text
 * alone can still lie: a right-to-left override reverses what is read, a newline fakes a
 * second UI line, and 500 characters push the real buttons off the screen. Controls and
 * invisibles are removed, whitespace is collapsed to single spaces, and the result is
 * capped — so whatever arrives ends up as one short line of visible text.
 *
 * Lives here because the client name is the hostile case that motivates it; the agent
 * name the human types on the consent screen goes through the same door.
 */
export function sanitiseDisplayName(raw: unknown, maxLength: number, fallback: string): string {
  if (typeof raw !== 'string') return fallback;

  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return fallback;

  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

export function sanitiseClientName(raw: unknown): string {
  return sanitiseDisplayName(raw, MAX_CLIENT_NAME_LENGTH, DEFAULT_CLIENT_NAME);
}

/**
 * The redirect uri allowlist: https anywhere, or plain http on loopback only.
 *
 * The loopback exception is a whole-host equality check, never a prefix one —
 * `http://localhost.evil.example.com` is not localhost. Fragments and embedded
 * credentials are refused outright: OAuth forbids a fragment on a redirect uri, and
 * `https://real.example.com@evil.example.com` is a classic way to make a hostile host
 * read as a friendly one.
 *
 * The other half of the job is that the *string* must be the destination. A redirect uri
 * is stored raw, matched raw, and shown raw to the human on the consent screen, while the
 * code is sent to whatever `new URL()` resolves it to — so any divergence between the two
 * is a lie told to the person making the decision. `new URL()` silently strips tabs and
 * newlines, which makes `https://good.example.com\t.evil.example.com/cb` read on screen as
 * `https://good.example.com .evil.example.com/cb` (HTML collapses the tab) while resolving
 * to the attacker's host. Rather than enumerate the parser's rewrites, the uri must
 * survive a round trip unchanged: what is displayed is then exactly what is sent.
 */
export function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (raw === '' || raw.length > MAX_REDIRECT_URI_LENGTH) return false;
  // Named explicitly because it is the spoofing case, and because a uri with whitespace in
  // it is never legitimate regardless of what the parser makes of it.
  if (URI_WHITESPACE.test(raw)) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // The invariant: stored === matched === displayed === where the code goes.
  if (url.toString() !== raw) return false;

  if (url.hash !== '' || raw.includes('#')) return false;
  if (url.username !== '' || url.password !== '') return false;

  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return false;
}

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
}

/**
 * Registers a public client and returns the RFC 7591 response.
 *
 * No client secret is issued: an MCP client runs on the user's own machine and could not
 * keep one, so the flow relies on PKCE plus the exact-match redirect uri instead. A
 * secret that cannot be kept is worse than no secret, because it invites treating the
 * client as confidential.
 *
 * Throws `OAuthError` with `invalid_redirect_uri` or `invalid_client_metadata`.
 */
export function registerClient(db: Database, body: unknown): RegisteredClient {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const redirectUris = input.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array of redirect URIs.');
  }
  for (const uri of redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        'Redirect URIs must be https, or http on localhost or 127.0.0.1, with no fragment, no whitespace, and already in resolved form.',
      );
    }
  }

  const authMethod = input.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported.');
  }

  const name = sanitiseClientName(input.client_name);
  const clientId = nanoid(24);

  db.insert(oauthClients)
    .values({
      id: nanoid(),
      // Registration happens before anyone logs in, so a client belongs to no user. What
      // ties a token to a person is the consent decision, not the registration.
      userId: null,
      clientId,
      clientSecretHash: null,
      redirectUris: JSON.stringify(redirectUris),
      name,
      createdAt: Date.now(),
    })
    .run();

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris as string[],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export type OAuthClientRow = typeof oauthClients.$inferSelect;

export function findClientByClientId(db: Database, clientId: string): OAuthClientRow | undefined {
  return db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get();
}

/** The registered redirect uris of a client, as stored — never normalised on the way out. */
export function registeredRedirectUris(client: OAuthClientRow): string[] {
  try {
    const parsed: unknown = JSON.parse(client.redirectUris);
    return Array.isArray(parsed) ? parsed.filter((uri): uri is string => typeof uri === 'string') : [];
  } catch {
    return [];
  }
}
