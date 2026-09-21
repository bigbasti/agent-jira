import {createHash, randomBytes} from 'node:crypto';
import {and, eq, isNull, lt} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import type {Database} from '../db/index.js';
import {oauthTokens} from '../db/schema.js';

/**
 * Token minting, storage and bearer authentication.
 *
 * Two rules hold everywhere in this file:
 *  - a token is 32 bytes of CSPRNG output, so it cannot be guessed;
 *  - only its SHA-256 digest is ever written to the database, so a copy of the database
 *    (a backup, a stray `.db` in a screen share, a SQL injection somewhere else) cannot
 *    be replayed against the MCP server. The plaintext exists only in the response that
 *    hands it to the client.
 *
 * SHA-256 with no salt or stretching is the right choice here — unlike a password, a
 * token has 256 bits of entropy, so there is nothing to brute-force and a fast digest
 * keeps `authenticateBearer` cheap enough to run on every MCP call.
 */

export const TOKEN_PREFIX = 'aj_';
export const ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_MS / 1000;

const TOKEN_BYTES = 32;

/** `aj_` + 32 CSPRNG bytes as base64url (43 characters, no padding). */
export function mintToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/** The only representation of a token or code that is allowed into the database. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface IssueTokensInput {
  /** `oauth_clients.id` — the row's primary key, not the public `client_id` string. */
  clientId: string;
  userId: string;
  agentId: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds, for the `expires_in` field. */
  expiresIn: number;
}

/**
 * Mints an access/refresh pair for one agent and writes only their hashes. The returned
 * plaintext is the single copy that will ever exist — hand it straight to the client.
 */
export function issueTokens(db: Database, {clientId, userId, agentId}: IssueTokensInput): IssuedTokens {
  const accessToken = mintToken();
  const refreshToken = mintToken();

  db.insert(oauthTokens)
    .values({
      id: nanoid(),
      clientId,
      userId,
      agentId,
      accessTokenHash: hashSecret(accessToken),
      refreshTokenHash: hashSecret(refreshToken),
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      revokedAt: null,
    })
    .run();

  return {accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS};
}

/**
 * When a refresh token stops being usable.
 *
 * The row stores only the access token's expiry, so the refresh deadline is derived from
 * it: both are stamped at the same instant, so `issuedAt = expiresAt - ACCESS_TTL`. Each
 * rotation writes a new row and therefore restarts the 90 days — a sliding window, which
 * is what a long-lived agent session wants.
 *
 * INVARIANT: this arithmetic is only correct while `expires_at` means "issued at plus
 * exactly `ACCESS_TOKEN_TTL_MS`". Two things would silently shorten or extend every
 * refresh lifetime — changing `ACCESS_TOKEN_TTL_MS` (old rows were stamped under the old
 * value), and updating `expires_at` in place instead of issuing a new row. Do neither; if
 * either becomes necessary, give `oauth_tokens` its own refresh-expiry column first.
 */
export function refreshExpiresAt(row: {expiresAt: number}): number {
  return row.expiresAt - ACCESS_TOKEN_TTL_MS + REFRESH_TOKEN_TTL_MS;
}

export function findByAccessToken(db: Database, token: string) {
  return db.select().from(oauthTokens).where(eq(oauthTokens.accessTokenHash, hashSecret(token))).get();
}

export function findByRefreshToken(db: Database, token: string) {
  return db.select().from(oauthTokens).where(eq(oauthTokens.refreshTokenHash, hashSecret(token))).get();
}

/** Revokes one token row — both halves of the pair die together. */
export function revokeTokenRow(db: Database, id: string): void {
  db.update(oauthTokens)
    .set({revokedAt: Date.now()})
    .where(and(eq(oauthTokens.id, id), isNull(oauthTokens.revokedAt)))
    .run();
}

/**
 * Revokes every live token an agent holds from one client. Used as the breach response
 * when a rotated refresh token is replayed: the safe assumption is that one of the two
 * holders is an attacker, and we cannot tell which, so both lose access.
 */
export function revokeAgentTokens(db: Database, clientId: string, agentId: string): void {
  db.update(oauthTokens)
    .set({revokedAt: Date.now()})
    .where(and(eq(oauthTokens.clientId, clientId), eq(oauthTokens.agentId, agentId), isNull(oauthTokens.revokedAt)))
    .run();
}

/** Drops rows whose refresh window has closed; nothing can be done with them any more. */
export function deleteDeadTokens(db: Database): void {
  db.delete(oauthTokens)
    .where(lt(oauthTokens.expiresAt, Date.now() - REFRESH_TOKEN_TTL_MS + ACCESS_TOKEN_TTL_MS))
    .run();
}

/**
 * A single `Bearer <token68>` credential, per RFC 6750 §2.1. Deliberately strict: one
 * scheme, one space run, one token, nothing trailing. Anything else is `null` rather
 * than a best-effort guess, because a header this function half-understands is exactly
 * how a smuggled second credential gets in.
 */
const BEARER_PATTERN = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

/**
 * Resolves an `Authorization` header to the agent behind it, or `null`.
 *
 * Returns `null` — and never throws — for an absent, empty or malformed header, and for
 * a token that is unknown, expired or revoked. Deleting the `agents` row also revokes
 * access: the `oauth_tokens.agent_id` foreign key cascades, so the row disappears with
 * the agent.
 *
 * This is the gate in front of every MCP call, so it is deliberately a single indexed
 * lookup on a hash with no fallbacks.
 */
export function authenticateBearer(db: Database, header?: string): {userId: string; agentId: string} | null {
  if (typeof header !== 'string') return null;

  const match = BEARER_PATTERN.exec(header.trim());
  const token = match?.[1];
  if (!token) return null;

  const row = findByAccessToken(db, token);
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= Date.now()) return null;

  return {userId: row.userId, agentId: row.agentId};
}
