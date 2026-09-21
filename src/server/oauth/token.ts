import {eq, lt} from 'drizzle-orm';
import type {Database} from '../db/index.js';
import {oauthCodes} from '../db/schema.js';
import {OAuthError} from './errors.js';
import {parseScope} from './metadata.js';
import {findClientByClientId} from './register.js';
import {verifyChallenge} from './pkce.js';
import {
  deleteDeadTokens,
  findByRefreshToken,
  hashSecret,
  issueTokens,
  refreshExpiresAt,
  revokeAgentTokens,
  revokeTokenRow,
  findByAccessToken,
} from './tokens.js';

/**
 * The token and revocation endpoints.
 *
 * Every rejection here answers `invalid_grant` with one identical description. A token
 * endpoint that distinguishes "no such code" from "wrong verifier" from "wrong client"
 * is an oracle: it tells an attacker holding a stolen code exactly which part of the
 * grant it still needs to forge. One answer, always.
 */

const INVALID_GRANT = 'The authorization grant is invalid, expired, or already used.';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function invalidGrant(): OAuthError {
  return new OAuthError('invalid_grant', INVALID_GRANT);
}

function required(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value === '') {
    throw new OAuthError('invalid_request', `The ${name} parameter is required.`);
  }
  return value;
}

function optional(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new OAuthError('invalid_request', `The ${name} parameter must be given exactly once.`);
  }
  return value;
}

/** Housekeeping: codes past their ten minutes can never be redeemed again. */
function deleteExpiredCodes(db: Database): void {
  db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, Date.now())).run();
}

/**
 * Redeems an authorization code.
 *
 * The code row is deleted before anything is checked. That is deliberate: it makes the
 * code single-use no matter which way the exchange goes, so a wrong `code_verifier`
 * cannot be retried against the same code, and a replay racing the legitimate exchange
 * finds nothing left. Under better-sqlite3 the delete and the checks run without any
 * interleaving, so there is no window between "found" and "burned".
 */
export function exchangeAuthorizationCode(db: Database, params: Record<string, unknown>): TokenResponse {
  const code = required(params, 'code');
  const clientId = required(params, 'client_id');
  const redirectUri = required(params, 'redirect_uri');
  const codeVerifier = optional(params, 'code_verifier');

  const row = db.select().from(oauthCodes).where(eq(oauthCodes.code, hashSecret(code))).get();
  if (!row) throw invalidGrant();

  db.delete(oauthCodes).where(eq(oauthCodes.code, row.code)).run();

  if (row.expiresAt <= Date.now()) throw invalidGrant();

  // The code is bound to the client that asked for it. A different client presenting it
  // is either a mix-up or a theft; both end the same way.
  const client = findClientByClientId(db, clientId);
  if (!client || client.id !== row.clientId) throw invalidGrant();

  // Exact string match against the redirect uri the code was issued for.
  if (redirectUri !== row.redirectUri) throw invalidGrant();

  if (codeVerifier === undefined || !verifyChallenge(codeVerifier, row.codeChallenge, 'S256')) {
    throw invalidGrant();
  }

  const issued = issueTokens(db, {clientId: row.clientId, userId: row.userId, agentId: row.agentId});
  return {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    scope: row.scope,
  };
}

/**
 * Exchanges a refresh token for a new pair, rotating the refresh token.
 *
 * Rotation is what makes a leaked refresh token detectable: the old one is marked
 * revoked rather than deleted, so presenting it again is unambiguous evidence that two
 * parties hold it. The response to that is to revoke every live token the agent has from
 * this client — the legitimate holder simply consents again, while the thief is locked
 * out along with them.
 */
export function refreshAccessToken(db: Database, params: Record<string, unknown>): TokenResponse {
  const refreshToken = required(params, 'refresh_token');
  const clientId = required(params, 'client_id');

  const row = findByRefreshToken(db, refreshToken);
  if (!row) throw invalidGrant();

  if (row.revokedAt !== null) {
    revokeAgentTokens(db, row.clientId, row.agentId);
    throw invalidGrant();
  }
  if (refreshExpiresAt(row) <= Date.now()) {
    revokeTokenRow(db, row.id);
    throw invalidGrant();
  }

  const client = findClientByClientId(db, clientId);
  if (!client || client.id !== row.clientId) throw invalidGrant();

  revokeTokenRow(db, row.id);
  deleteDeadTokens(db);

  const issued = issueTokens(db, {clientId: row.clientId, userId: row.userId, agentId: row.agentId});
  return {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    // This server grants exactly one scope profile, so a refreshed token can only ever
    // carry the same permissions as the original — a narrowing request is validated (an
    // unknown scope is still refused) but cannot widen anything.
    scope: parseScope(optional(params, 'scope')),
  };
}

/** Handles `POST /oauth/token` for both supported grants. */
export function handleTokenRequest(db: Database, params: Record<string, unknown>): TokenResponse {
  deleteExpiredCodes(db);

  const grantType = required(params, 'grant_type');
  if (grantType === 'authorization_code') return exchangeAuthorizationCode(db, params);
  if (grantType === 'refresh_token') return refreshAccessToken(db, params);

  throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
}

/**
 * Handles `POST /oauth/revoke` (RFC 7009).
 *
 * Succeeds silently whether or not the token existed — the RFC requires it, and it keeps
 * the endpoint from confirming that a guessed token is real. Revoking either half of a
 * pair kills the row, so the access and refresh tokens always die together.
 */
export function revokeToken(db: Database, params: Record<string, unknown>): void {
  const token = required(params, 'token');
  const clientId = optional(params, 'client_id');

  const row = findByAccessToken(db, token) ?? findByRefreshToken(db, token);
  if (!row) return;

  if (clientId !== undefined) {
    const client = findClientByClientId(db, clientId);
    // A client may only revoke what it holds. Still answered as a success.
    if (!client || client.id !== row.clientId) return;
  }

  revokeTokenRow(db, row.id);
}
