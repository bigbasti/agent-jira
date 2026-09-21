import {nanoid} from 'nanoid';
import type {Database} from '../db/index.js';
import {agents, oauthCodes} from '../db/schema.js';
import {OAuthError, OAuthRedirectError, buildRedirect} from './errors.js';
import {SCOPES, parseScope, type ScopeDescriptor} from './metadata.js';
import {findClientByClientId, registeredRedirectUris, sanitiseDisplayName, type OAuthClientRow} from './register.js';
import {hashSecret, mintToken} from './tokens.js';

/**
 * The authorization endpoint: validating an incoming request, and turning a human's
 * consent into an authorization code.
 *
 * Validation runs in two tiers, and the split matters:
 *  1. client_id and redirect_uri. Until both check out there is no trustworthy place to
 *     send an error, so these failures are answered to whoever asked, never redirected.
 *     Both failures produce the *same* message, so the endpoint cannot be used to ask
 *     "does this client_id exist?".
 *  2. everything else. The redirect target is now known-good, so the error goes back to
 *     the client the way RFC 6749 §4.1.2.1 says it should.
 */

export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_AGENT_NAME = 'Claude Code';
export const MAX_AGENT_NAME_LENGTH = 60;
const MAX_STATE_LENGTH = 1024;

/** One message for every "this request does not belong to a client I know" outcome. */
const OPAQUE_REQUEST_ERROR = 'The authorization request is invalid.';

export interface AuthorizeParams {
  [key: string]: unknown;
}

export interface ValidatedAuthorizeRequest {
  client: OAuthClientRow;
  /** The public `client_id` string, as presented. */
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  scope: string;
}

/** A base64url SHA-256 digest: the only shape an S256 challenge can take. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Reads one query/body parameter. A repeated parameter arrives as an array, and is
 * refused rather than silently reduced — parameter pollution is how a second
 * `redirect_uri` or `code_verifier` gets smuggled past a validator that only looked at
 * the first one.
 */
function singleParam(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  throw new OAuthError('invalid_request', `The ${name} parameter must be given exactly once.`);
}

function opaqueError(): OAuthError {
  return new OAuthError('invalid_request', OPAQUE_REQUEST_ERROR);
}

/**
 * Validates an authorization request against the client registration.
 *
 * Throws `OAuthError` when the client or redirect uri cannot be trusted, and
 * `OAuthRedirectError` for every later failure.
 */
export function validateAuthorizeRequest(db: Database, params: AuthorizeParams): ValidatedAuthorizeRequest {
  // Shape first, so a repeated parameter can never reach a comparison.
  const clientId = singleParam(params.client_id, 'client_id');
  const redirectUri = singleParam(params.redirect_uri, 'redirect_uri');
  const responseType = singleParam(params.response_type, 'response_type');
  const codeChallenge = singleParam(params.code_challenge, 'code_challenge');
  const codeChallengeMethod = singleParam(params.code_challenge_method, 'code_challenge_method');
  const state = singleParam(params.state, 'state');
  const scopeParam = singleParam(params.scope, 'scope');

  if (!clientId || !redirectUri) throw opaqueError();

  const client = findClientByClientId(db, clientId);
  // Exact string comparison against the registered set. No prefix match, no path
  // normalisation, no "same origin is close enough" — the registered string or nothing.
  if (!client || !registeredRedirectUris(client).includes(redirectUri)) {
    throw opaqueError();
  }

  // Past this point the redirect target is trustworthy, so errors go back to the client.
  if (state !== undefined && state.length > MAX_STATE_LENGTH) {
    // Nothing to echo: a state we refuse is a state we will not hand back either.
    throw new OAuthRedirectError(redirectUri, undefined, 'invalid_request', 'The state parameter is too long.');
  }
  if (responseType !== 'code') {
    throw new OAuthRedirectError(
      redirectUri,
      state,
      'unsupported_response_type',
      'Only the authorization code response type is supported.',
    );
  }
  if (codeChallengeMethod !== 'S256') {
    // `plain` is not a supported downgrade, it is a rejection.
    throw new OAuthRedirectError(redirectUri, state, 'invalid_request', 'code_challenge_method must be S256.');
  }
  if (codeChallenge === undefined || !CHALLENGE_PATTERN.test(codeChallenge)) {
    throw new OAuthRedirectError(redirectUri, state, 'invalid_request', 'A valid S256 code_challenge is required.');
  }

  let scope: string;
  try {
    scope = parseScope(scopeParam);
  } catch (err) {
    if (err instanceof OAuthError) {
      throw new OAuthRedirectError(redirectUri, state, err.code, err.description);
    }
    throw err;
  }

  return {client, clientId, redirectUri, codeChallenge, state, scope};
}

/** Trims and caps the name the human typed on the consent screen. */
export function sanitiseAgentName(raw: unknown): string {
  return sanitiseDisplayName(raw, MAX_AGENT_NAME_LENGTH, DEFAULT_AGENT_NAME);
}

export interface ConsentGrant {
  /** The plaintext code — only ever returned, never stored. */
  code: string;
  agentId: string;
  redirectTo: string;
}

/**
 * Records a granted consent: one new agent, one single-use authorization code.
 *
 * The code is bound to the client, the redirect uri and the code challenge, and lives
 * ten minutes. Only its SHA-256 digest is stored, so a stolen copy of the database
 * cannot be redeemed at the token endpoint. Agent and code are written in one
 * transaction — a code pointing at an agent that does not exist would be unusable, and
 * an agent with no code would be a phantom worker on the board.
 */
export function grantConsent(
  db: Database,
  request: ValidatedAuthorizeRequest,
  userId: string,
  agentNameRaw: unknown,
): ConsentGrant {
  const code = mintToken();
  const agentId = nanoid();
  const now = Date.now();

  db.transaction(tx => {
    tx.insert(agents)
      .values({
        id: agentId,
        userId,
        name: sanitiseAgentName(agentNameRaw),
        autonomous: false,
        status: 'offline',
        currentStoryId: null,
        lastSeenAt: null,
        createdAt: now,
      })
      .run();

    tx.insert(oauthCodes)
      .values({
        code: hashSecret(code),
        clientId: request.client.id,
        userId,
        agentId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scope: request.scope,
        expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      })
      .run();
  });

  return {code, agentId, redirectTo: buildRedirect(request.redirectUri, {code, state: request.state})};
}

/** The redirect for a refused consent. No agent, no code — nothing is recorded. */
export function denyConsent(request: ValidatedAuthorizeRequest): string {
  return buildRedirect(request.redirectUri, {
    error: 'access_denied',
    error_description: 'The user refused this authorization request.',
    state: request.state,
  });
}

export interface ConsentDescription {
  clientId: string;
  /** Always the *registered* name — never anything the URL carried. */
  clientName: string;
  redirectUri: string;
  permissions: ScopeDescriptor[];
  defaultAgentName: string;
  maxAgentNameLength: number;
}

/**
 * What the consent screen is allowed to show.
 *
 * The name and the redirect uri come from the validated registration, not from the query
 * string, so a crafted `/consent?...` link cannot make one client wear another's name —
 * the only thing a link can choose is which registered client is being described.
 */
export function describeConsentRequest(request: ValidatedAuthorizeRequest): ConsentDescription {
  const granted = new Set(request.scope.split(' '));
  return {
    clientId: request.clientId,
    clientName: request.client.name,
    redirectUri: request.redirectUri,
    permissions: SCOPES.filter(scope => granted.has(scope.id)),
    defaultAgentName: DEFAULT_AGENT_NAME,
    maxAgentNameLength: MAX_AGENT_NAME_LENGTH,
  };
}
