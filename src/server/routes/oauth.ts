import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type {AppConfig} from '../config.js';
import {isSameOrigin} from '../http/origin.js';
import {requireUser} from '../services/auth.js';
import {OAuthError, OAuthRedirectError} from '../oauth/errors.js';
import {authorizationServerMetadata, protectedResourceMetadata} from '../oauth/metadata.js';
import {registerClient} from '../oauth/register.js';
import {
  denyConsent,
  describeConsentRequest,
  grantConsent,
  validateAuthorizeRequest,
  type ValidatedAuthorizeRequest,
} from '../oauth/authorize.js';
import {handleTokenRequest, revokeToken} from '../oauth/token.js';

/**
 * The OAuth 2.1 authorization server's HTTP surface.
 *
 * Several defences live at this layer rather than in the services below it:
 *  - `/oauth/register` is open to the world, so it is rate limited per IP, and
 *    `/oauth/token` is rate limited too so a code or verifier cannot be ground down;
 *  - `/oauth/token` and `/oauth/revoke` accept form bodies (that is what OAuth clients
 *    send) inside a nested scope, so the form parser cannot reach `/oauth/authorize`;
 *  - `POST /oauth/authorize` — the consent decision — therefore accepts JSON only. A
 *    cross-origin HTML form can only produce urlencoded, multipart or text/plain bodies,
 *    and a cross-origin `fetch` with a JSON content type is stopped by the preflight this
 *    server never answers. With the SameSite=Lax session cookie and the `Origin` check
 *    below on top, a hostile page cannot press Allow on the user's behalf.
 */

export interface OAuthRouteOptions {
  config: AppConfig;
}

/** Registration is public; ten new clients an hour from one address is already generous. */
const REGISTER_RATE_LIMIT = {max: 10, timeWindow: '1 hour'};
/** Enough headroom for a real client's retries, low enough to make guessing pointless. */
const TOKEN_RATE_LIMIT = {max: 60, timeWindow: '1 minute'};

/** Static: the offending parameter name comes from the request and is never echoed. */
const DUPLICATE_PARAMETER_ERROR = 'Each request parameter must be given exactly once.';

/**
 * Refuses a request whose `Origin` names somewhere other than this server — the belt to
 * the JSON-only suspenders on the consent decision, so a forged submission is turned away
 * before it reaches the session. The rule itself lives in `http/origin.ts`, because the
 * `/ws` upgrade needs exactly the same one.
 */
async function requireSameOrigin(req: FastifyRequest, reply: FastifyReply) {
  if (isSameOrigin(req.headers.origin, req.headers.host)) return;
  return reply.code(403).send({error: 'invalid_request', error_description: 'Cross-origin request refused.'});
}

/** Tokens and codes must never be cached by anything in the path. */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

/**
 * Answers an OAuth failure. An `OAuthRedirectError` goes back to the client's registered
 * redirect uri; everything else is answered here, because there is no verified place to
 * send it.
 */
function sendOAuthError(reply: FastifyReply, err: unknown, redirect: boolean): FastifyReply | undefined {
  if (err instanceof OAuthRedirectError) {
    return redirect
      ? noStore(reply).redirect(err.toLocation(), 302)
      : noStore(reply).code(200).send({redirectTo: err.toLocation()});
  }
  if (err instanceof OAuthError) {
    return noStore(reply).code(err.status).send(err.toBody());
  }
  return undefined;
}

export async function oauthRoutes(app: FastifyInstance, opts: OAuthRouteOptions): Promise<void> {
  const {config} = opts;

  await app.register(rateLimit, {global: false});

  // A net under every route in this scope, including the body parser below: an OAuth
  // failure must always leave as an OAuth error body, never as Fastify's generic
  // `{statusCode, error: 'Bad Request', message}`, which no client knows how to read.
  app.setErrorHandler((err, _req, reply) => {
    return sendOAuthError(reply, err, false) ?? reply.send(err);
  });

  const asMetadata = authorizationServerMetadata(config.publicUrl);
  const prMetadata = protectedResourceMetadata(config.publicUrl);

  app.get('/.well-known/oauth-authorization-server', async () => asMetadata);

  // RFC 9728 lets a client look for the metadata either at the root or under the
  // resource's own path, and MCP clients try the path form first. Both answer the same
  // document, describing the `/mcp` resource task 13 mounts.
  app.get('/.well-known/oauth-protected-resource', async () => prMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', async () => prMetadata);

  app.post('/oauth/register', {config: {rateLimit: REGISTER_RATE_LIMIT}}, async (req, reply) => {
    try {
      return noStore(reply).code(201).send(registerClient(app.db, req.body));
    } catch (err) {
      return sendOAuthError(reply, err, false) ?? Promise.reject(err);
    }
  });

  /**
   * The start of the flow. Without a session the browser is sent to the SPA's sign-in
   * screen with the whole authorize request kept in `next`, as a path — never an absolute
   * URL, so this cannot become an open redirect.
   */
  app.get('/oauth/authorize', async (req, reply) => {
    let request: ValidatedAuthorizeRequest;
    try {
      request = validateAuthorizeRequest(app.db, (req.query ?? {}) as Record<string, unknown>);
    } catch (err) {
      return sendOAuthError(reply, err, true) ?? Promise.reject(err);
    }

    if (!req.session.userId) {
      return noStore(reply).redirect(`/?next=${encodeURIComponent(req.url)}`, 302);
    }

    const params = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      response_type: 'code',
      scope: request.scope,
    });
    if (request.state !== undefined) params.set('state', request.state);

    return noStore(reply).redirect(`/consent?${params.toString()}`, 302);
  });

  /**
   * What the consent screen renders. Everything shown to the human is resolved here from
   * the registration, so the query string can choose *which* client is described but
   * never *how* it is described.
   */
  app.get('/api/oauth/consent', {preHandler: requireUser}, async (req, reply) => {
    try {
      const request = validateAuthorizeRequest(app.db, (req.query ?? {}) as Record<string, unknown>);
      return noStore(reply).send(describeConsentRequest(request));
    } catch (err) {
      if (err instanceof OAuthRedirectError) {
        return noStore(reply).code(400).send({error: err.code, error_description: err.description});
      }
      return sendOAuthError(reply, err, false) ?? Promise.reject(err);
    }
  });

  /**
   * The consent decision. Answers `{redirectTo}` rather than a 302: the browser has to be
   * the one that navigates to the client's loopback callback, and a `fetch` cannot read a
   * redirect it was told to follow.
   */
  app.post('/oauth/authorize', {preHandler: [requireSameOrigin, requireUser]}, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    let request: ValidatedAuthorizeRequest;
    try {
      request = validateAuthorizeRequest(app.db, body);
    } catch (err) {
      return sendOAuthError(reply, err, false) ?? Promise.reject(err);
    }

    if (body.decision !== 'allow') {
      return noStore(reply).send({redirectTo: denyConsent(request)});
    }

    const grant = grantConsent(app.db, request, req.user!.id, body.agent_name);
    return noStore(reply).send({redirectTo: grant.redirectTo});
  });

  // A nested scope so the urlencoded parser below belongs to the token endpoints alone.
  await app.register(async formScope => {
    formScope.addContentTypeParser<string>(
      'application/x-www-form-urlencoded',
      {parseAs: 'string'},
      (_req: FastifyRequest, body: string, done) => {
        const params = new URLSearchParams(body);
        const parsed: Record<string, string> = {};
        for (const key of new Set(params.keys())) {
          const values = params.getAll(key);
          // A repeated parameter is refused, not reduced: OAuth forbids it, and reducing
          // it is how a second `code_verifier` slips past a validator.
          if (values.length !== 1) {
            // The key is attacker-supplied and unbounded, so it is counted, not quoted.
            done(new OAuthError('invalid_request', DUPLICATE_PARAMETER_ERROR), undefined);
            return;
          }
          parsed[key] = values[0]!;
        }
        done(null, parsed);
      },
    );

    formScope.post('/oauth/token', {config: {rateLimit: TOKEN_RATE_LIMIT}}, async (req, reply) => {
      try {
        return noStore(reply).send(handleTokenRequest(app.db, (req.body ?? {}) as Record<string, unknown>));
      } catch (err) {
        return sendOAuthError(reply, err, false) ?? Promise.reject(err);
      }
    });

    formScope.post('/oauth/revoke', {config: {rateLimit: TOKEN_RATE_LIMIT}}, async (req, reply) => {
      try {
        revokeToken(app.db, (req.body ?? {}) as Record<string, unknown>);
      } catch (err) {
        return sendOAuthError(reply, err, false) ?? Promise.reject(err);
      }
      // RFC 7009: success whether or not the token was real.
      return noStore(reply).code(200).send({});
    });
  });
}
