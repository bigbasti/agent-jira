/**
 * The OAuth error shape (RFC 6749 §5.2 / §4.1.2.1), in the two flavours this server
 * needs: one it may only show the human, and one it may hand back to the client.
 */

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'access_denied'
  | 'server_error'
  // RFC 7591 (dynamic client registration).
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata';

export interface OAuthErrorBody {
  error: OAuthErrorCode;
  error_description: string;
}

/**
 * An error answered directly to whoever made the request — never forwarded to a
 * `redirect_uri`, because the client identity or the redirect target itself is what
 * failed to check out.
 */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly description: string;
  readonly status: number;

  constructor(code: OAuthErrorCode, description: string, status = 400) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
    this.code = code;
    this.description = description;
    this.status = status;
  }

  toBody(): OAuthErrorBody {
    return {error: this.code, error_description: this.description};
  }
}

/**
 * An error that belongs back at the client's `redirect_uri` — only ever thrown once the
 * client and its redirect uri have already been verified against the registration.
 */
export class OAuthRedirectError extends Error {
  readonly code: OAuthErrorCode;
  readonly description: string;
  readonly redirectUri: string;
  readonly state: string | undefined;

  constructor(redirectUri: string, state: string | undefined, code: OAuthErrorCode, description: string) {
    super(`${code}: ${description}`);
    this.name = 'OAuthRedirectError';
    this.redirectUri = redirectUri;
    this.state = state;
    this.code = code;
    this.description = description;
  }

  toLocation(): string {
    return buildRedirect(this.redirectUri, {error: this.code, error_description: this.description, state: this.state});
  }
}

/**
 * Appends OAuth response parameters to an already-validated redirect uri. Uses the URL
 * parser rather than string concatenation so a registered uri that already carries a
 * query string keeps it, and so nothing a client supplied can break out of a parameter.
 */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
