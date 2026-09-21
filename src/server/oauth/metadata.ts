import {OAuthError} from './errors.js';

/**
 * The discovery documents (RFC 8414 and RFC 9728) and the scope vocabulary they
 * advertise. Every URL is derived from `config.publicUrl`, so the same build works
 * behind a reverse proxy without a rebuild — nothing here may hardcode a host.
 */

export interface ScopeDescriptor {
  id: string;
  /** The plain-language line the consent screen shows. No jargon, no marketing. */
  label: string;
}

export const SCOPES: readonly ScopeDescriptor[] = [
  {id: 'board:read', label: 'Read your board'},
  {id: 'board:write', label: 'Create and move stories'},
  {id: 'updates:write', label: 'Post progress updates'},
];

export const SCOPE_IDS: readonly string[] = SCOPES.map(scope => scope.id);

/** The one scope profile this server grants — an agent needs all three to do any work. */
export const GRANTED_SCOPE = SCOPE_IDS.join(' ');

/** The path the MCP server (task 13) is mounted at, relative to the public url. */
export const RESOURCE_PATH = '/mcp';

/** Trims any trailing slash so `${issuer}/oauth/token` never doubles up. */
export function issuerFrom(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, '');
}

/**
 * Validates a requested `scope` parameter and returns the scope actually granted.
 *
 * A request for an unknown scope is refused outright (`invalid_scope`) rather than
 * quietly trimmed. A request for a subset is answered with the full profile: the token
 * genuinely carries all three permissions, and RFC 6749 §5.1 exists precisely so a
 * server can say "here is what you actually got" — the consent screen shows the same
 * three lines, so the human is never told less than the token can do.
 */
export function parseScope(requested: string | undefined): string {
  if (requested === undefined) return GRANTED_SCOPE;

  const wanted = requested.split(/\s+/).filter(part => part !== '');
  if (wanted.length === 0) return GRANTED_SCOPE;

  for (const scope of wanted) {
    if (!SCOPE_IDS.includes(scope)) {
      throw new OAuthError('invalid_scope', 'The requested scope is not supported.');
    }
  }
  return GRANTED_SCOPE;
}

export function authorizationServerMetadata(publicUrl: string) {
  const issuer = issuerFrom(publicUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only, and advertised as such: a client that sees this list can never decide
    // `plain` is on the table.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPE_IDS,
  };
}

export function protectedResourceMetadata(publicUrl: string) {
  const issuer = issuerFrom(publicUrl);
  return {
    resource: `${issuer}${RESOURCE_PATH}`,
    authorization_servers: [issuer],
    scopes_supported: SCOPE_IDS,
    bearer_methods_supported: ['header'],
  };
}
