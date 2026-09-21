import {describe, it, expect, beforeEach} from 'vitest';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createHarness} from '../testing/harness.js';
import {agents, oauthClients, oauthCodes, oauthTokens} from '../db/schema.js';
import type {AppConfig} from '../config.js';
import {authenticateBearer, issueTokens} from './tokens.js';

// RFC 7636 appendix B's worked example, reused as this suite's PKCE pair.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'http://127.0.0.1:41234/callback';
const FORM = {'content-type': 'application/x-www-form-urlencoded'};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    databasePath: ':memory:',
    sessionSecret: 'test-session-secret-at-least-32-chars-long',
    publicUrl: 'http://localhost:3000',
    nodeEnv: 'test',
    trustProxy: false,
    ...overrides,
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function registerClient(h: Harness, body: Record<string, unknown> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: {redirect_uris: [REDIRECT], client_name: 'Claude Code', ...body},
  });
}

function authorizeQuery(clientId: string, overrides: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz-state',
    ...overrides,
  };
  // An override of '' means "send this parameter empty" is not what we want — it means
  // "leave it out entirely", which is the more interesting missing-parameter case.
  for (const [key, value] of Object.entries(params)) {
    if (value === '') delete params[key];
  }
  return new URLSearchParams(params).toString();
}

/** Posts a consent decision as the SPA does: JSON, with the session cookie. */
function decide(
  h: Harness,
  cookie: string,
  clientId: string,
  decision: 'allow' | 'deny',
  extra: Record<string, unknown> = {},
) {
  return h.app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: {cookie},
    payload: {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'xyz-state',
      decision,
      ...extra,
    },
  });
}

async function grantCode(h: Harness, cookie: string, clientId: string, extra: Record<string, unknown> = {}) {
  const res = await decide(h, cookie, clientId, 'allow', extra);
  expect(res.statusCode).toBe(200);
  const url = new URL((res.json() as {redirectTo: string}).redirectTo);
  const code = url.searchParams.get('code');
  expect(code).toBeTruthy();
  return {code: code!, url};
}

function exchange(h: Harness, params: Record<string, string>) {
  return h.app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: FORM,
    payload: new URLSearchParams(params).toString(),
  });
}

/** Registers a client, signs a user in, and consents — the happy path, in one call. */
async function fullGrant(h: Harness) {
  const {cookie, user} = await h.register();
  const client = (await registerClient(h)).json() as {client_id: string};
  const {code} = await grantCode(h, cookie, client.client_id);
  return {cookie, user, clientId: client.client_id, code};
}

describe('oauth metadata', () => {
  it('advertises metadata with the public url', async () => {
    const h = await createHarness({config: config({publicUrl: 'https://board.example.com'})});

    const res = await h.app.inject({method: 'GET', url: '/.well-known/oauth-authorization-server'});
    expect(res.statusCode).toBe(200);
    const meta = res.json();

    expect(meta.issuer).toBe('https://board.example.com');
    expect(meta.authorization_endpoint).toBe('https://board.example.com/oauth/authorize');
    expect(meta.token_endpoint).toBe('https://board.example.com/oauth/token');
    expect(meta.registration_endpoint).toBe('https://board.example.com/oauth/register');
    expect(meta.revocation_endpoint).toBe('https://board.example.com/oauth/revoke');
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.response_types_supported).toEqual(['code']);
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    // Nothing hardcoded leaks through when the app sits behind a proxy.
    expect(JSON.stringify(meta)).not.toContain('localhost');
  });

  it('never advertises the plain code challenge method', async () => {
    const h = await createHarness({config: config()});
    const meta = (await h.app.inject({method: 'GET', url: '/.well-known/oauth-authorization-server'})).json();
    expect(meta.code_challenge_methods_supported).not.toContain('plain');
  });

  it('advertises the protected resource with the public url', async () => {
    const h = await createHarness({config: config({publicUrl: 'https://board.example.com'})});

    const res = await h.app.inject({method: 'GET', url: '/.well-known/oauth-protected-resource'});
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.resource).toBe('https://board.example.com/mcp');
    expect(meta.authorization_servers).toEqual(['https://board.example.com']);
  });
});

describe('oauth client registration', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({config: config()});
  });

  it('registers a client dynamically', async () => {
    const res = await registerClient(h, {redirect_uris: [REDIRECT, 'https://app.example.com/cb']});
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.client_id).toMatch(/^\S+$/);
    expect(body.redirect_uris).toEqual([REDIRECT, 'https://app.example.com/cb']);
    expect(body.client_name).toBe('Claude Code');
    expect(body.token_endpoint_auth_method).toBe('none');
    // A public client: no secret is issued, so none can leak.
    expect(body.client_secret).toBeUndefined();

    const row = h.db.select().from(oauthClients).where(eq(oauthClients.clientId, body.client_id)).get();
    expect(row).toBeDefined();
    expect(row!.clientSecretHash).toBeNull();
  });

  it('accepts http on localhost and 127.0.0.1, and https anywhere', async () => {
    for (const uri of [
      'http://localhost:8080/callback',
      'http://127.0.0.1:41234/callback',
      'https://app.example.com/cb',
    ]) {
      const res = await registerClient(h, {redirect_uris: [uri]});
      expect(res.statusCode, uri).toBe(201);
    }
  });

  it('rejects registration with a non-http(s) redirect uri', async () => {
    for (const uri of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vscode://callback',
      'not-a-url',
      '/relative/callback',
      '',
    ]) {
      const res = await registerClient(h, {redirect_uris: [uri]});
      expect(res.statusCode, uri).toBe(400);
      expect(res.json().error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects plain http on any host that is not loopback', async () => {
    for (const uri of [
      'http://evil.example.com/cb',
      // The loopback allowance is a host check, never a prefix check.
      'http://localhost.evil.example.com/cb',
      'http://127.0.0.1.evil.example.com/cb',
      'http://evil.com/?x=http://localhost/cb',
    ]) {
      const res = await registerClient(h, {redirect_uris: [uri]});
      expect(res.statusCode, uri).toBe(400);
    }
  });

  it('rejects a redirect uri whose raw text differs from where it actually resolves', async () => {
    // `new URL()` silently strips tab/CR/LF, so the string a human reads on the consent
    // screen is not the host the code is sent to: rendered as HTML the tab below collapses
    // to a space and `good.example.com` reads as the destination, while the request
    // resolves to `good.example.com.evil.example.com`.
    for (const uri of [
      'https://good.example.com\t.evil.example.com/cb',
      'https://good.example.com\r.evil.example.com/cb',
      'https://good.example.com\n.evil.example.com/cb',
      'https://good.example.com .evil.example.com/cb',
      'http://127.0.0.1\t.evil.example.com/cb',
      '\thttps://app.example.com/cb',
      'https://app.example.com/cb\n',
    ]) {
      const res = await registerClient(h, {redirect_uris: [uri]});
      expect(res.statusCode, JSON.stringify(uri)).toBe(400);
      expect(res.json().error).toBe('invalid_redirect_uri');
    }
  });

  it('rejects a redirect uri that is not already in its resolved form', async () => {
    // Anything the URL parser would rewrite is refused, so the string stored, matched on
    // and displayed is always byte-for-byte the one `buildRedirect` sends the code to.
    for (const uri of ['https://app.example.com:443/cb', 'https://APP.example.com/cb', 'https://app.example.com/a/../cb']) {
      const res = await registerClient(h, {redirect_uris: [uri]});
      expect(res.statusCode, uri).toBe(400);
    }
  });

  it('still accepts a legitimate redirect uri with a port and a query string', async () => {
    for (const uri of [
      'http://127.0.0.1:41234/callback',
      'http://localhost:8080/oauth/callback?source=cli',
      'https://app.example.com:8443/cb?tenant=acme&v=2',
    ]) {
      const res = await registerClient(h, {redirect_uris: [uri]});
      expect(res.statusCode, uri).toBe(201);
      expect(res.json().redirect_uris).toEqual([uri]);
    }
  });

  it('rejects a redirect uri carrying a fragment or embedded credentials', async () => {
    for (const uri of ['https://app.example.com/cb#frag', 'https://user:pw@app.example.com/cb']) {
      const res = await registerClient(h, {redirect_uris: [uri]});
      expect(res.statusCode, uri).toBe(400);
    }
  });

  it('rejects a missing or malformed redirect_uris list', async () => {
    for (const body of [{redirect_uris: []}, {redirect_uris: 'https://a.example.com/cb'}, {redirect_uris: undefined}]) {
      const res = await registerClient(h, body);
      expect(res.statusCode).toBe(400);
    }
  });

  it('neutralises a client name that tries to spoof the consent screen', async () => {
    const res = await registerClient(h, {
      // Control characters, a bidi override and a huge length are all UI-spoofing tools.
      client_name: `Claude\u202E Code\n\nApproved by agent-jira ${'x'.repeat(500)}`,
    });
    expect(res.statusCode).toBe(201);

    const name: string = res.json().client_name;
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(name).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  });

  it('rate limits registration to 10 per hour per ip', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await registerClient(h)).statusCode);
    }
    expect(codes.slice(0, 10)).toEqual(Array.from({length: 10}, () => 201));
    expect(codes[10]).toBe(429);
    expect(codes[11]).toBe(429);
  });
});

describe('oauth authorize', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({config: config()});
  });

  it('redirects an unauthenticated authorize to login and back', async () => {
    const client = (await registerClient(h)).json();
    const url = `/oauth/authorize?${authorizeQuery(client.client_id)}`;

    const res = await h.app.inject({method: 'GET', url});
    expect(res.statusCode).toBe(302);

    const location = res.headers.location as string;
    expect(location.startsWith('/?next=')).toBe(true);
    expect(decodeURIComponent(location.slice('/?next='.length))).toBe(url);
  });

  it('sends an authenticated authorize to the consent screen', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await h.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${authorizeQuery(client.client_id)}`,
      headers: {cookie},
    });
    expect(res.statusCode).toBe(302);

    const location = res.headers.location as string;
    expect(location.startsWith('/consent?')).toBe(true);
    const params = new URL(location, 'http://localhost:3000').searchParams;
    expect(params.get('client_id')).toBe(client.client_id);
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(params.get('code_challenge')).toBe(CHALLENGE);
    expect(params.get('state')).toBe('xyz-state');
  });

  it('gives an unknown client and an unregistered redirect uri the same error', async () => {
    const client = (await registerClient(h)).json();

    const unknown = await h.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${authorizeQuery('no-such-client')}`,
    });
    const badRedirect = await h.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${authorizeQuery(client.client_id, {redirect_uri: 'https://elsewhere.example.com/cb'})}`,
    });

    expect(unknown.statusCode).toBe(400);
    expect(badRedirect.statusCode).toBe(400);
    // Identical bodies: the response cannot be used to probe which client ids exist.
    expect(unknown.body).toBe(badRedirect.body);
    expect(unknown.json().error).toBeTruthy();
    expect(unknown.body).not.toContain('no-such-client');
  });

  it('matches the redirect uri by exact string, never by prefix or path', async () => {
    const client = (await registerClient(h, {redirect_uris: ['https://app.example.com/cb']})).json();
    for (const uri of [
      'https://app.example.com/cb/evil',
      'https://app.example.com/cb?x=1',
      'https://app.example.com/CB',
      'https://app.example.com/./cb',
      'https://app.example.com:443/cb',
      'https://app.example.com/cb/',
      'https://evil.com/?u=https://app.example.com/cb',
    ]) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/oauth/authorize?${authorizeQuery(client.client_id, {redirect_uri: uri})}`,
      });
      expect(res.statusCode, uri).toBe(400);
    }
  });

  it('refuses the plain code challenge method and a missing challenge', async () => {
    const client = (await registerClient(h)).json();

    const cases: Record<string, string>[] = [
      {code_challenge_method: 'plain'},
      {code_challenge_method: 'S128'},
      {code_challenge_method: ''},
      {code_challenge: ''},
    ];
    for (const overrides of cases) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/oauth/authorize?${authorizeQuery(client.client_id, overrides)}`,
      });
      // Client and redirect uri are both valid here, so the error goes to the client.
      expect(res.statusCode, JSON.stringify(overrides)).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('state')).toBe('xyz-state');
      expect(location.searchParams.get('code')).toBeNull();
    }
  });

  it('refuses a response type other than code', async () => {
    const client = (await registerClient(h)).json();
    const res = await h.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${authorizeQuery(client.client_id, {response_type: 'token'})}`,
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('unsupported_response_type');
  });

  it('refuses a repeated parameter rather than picking one', async () => {
    const client = (await registerClient(h)).json();

    // Parameter pollution: a validator that reads the first value and a consumer that
    // reads the last can be made to disagree about where the code is going.
    const polluted = `${authorizeQuery(client.client_id)}&redirect_uri=${encodeURIComponent('https://evil.example.com/cb')}`;
    const res = await h.app.inject({method: 'GET', url: `/oauth/authorize?${polluted}`});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('refuses a scope it does not support', async () => {
    const client = (await registerClient(h)).json();
    const res = await h.app.inject({
      method: 'GET',
      url: `/oauth/authorize?${authorizeQuery(client.client_id, {scope: 'board:read admin:everything'})}`,
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('invalid_scope');
  });
});

describe('oauth consent', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({config: config()});
  });

  it('describes the consent request using the registered client name', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h, {client_name: 'Claude Code'})).json();

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/oauth/consent?${authorizeQuery(client.client_id)}`,
      headers: {cookie},
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.clientName).toBe('Claude Code');
    expect(body.redirectUri).toBe(REDIRECT);
    expect(body.defaultAgentName).toBe('Claude Code');
    expect(body.permissions.map((p: {label: string}) => p.label)).toEqual([
      'Read your board',
      'Create and move stories',
      'Post progress updates',
    ]);
  });

  it('takes the client name from the registration, not from the url', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h, {client_name: 'Sketchy Tool'})).json();

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/oauth/consent?${authorizeQuery(client.client_id)}&client_name=agent-jira%20official`,
      headers: {cookie},
    });
    expect(res.json().clientName).toBe('Sketchy Tool');
  });

  it('refuses the consent lookup without a session', async () => {
    const client = (await registerClient(h)).json();
    const res = await h.app.inject({method: 'GET', url: `/api/oauth/consent?${authorizeQuery(client.client_id)}`});
    expect(res.statusCode).toBe(401);
  });

  it('creates an agent and a code when consent is granted', async () => {
    const {cookie, user} = await h.register();
    const client = (await registerClient(h)).json();

    const {url} = await grantCode(h, cookie, client.client_id, {agent_name: '  Night shift  '});

    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('xyz-state');
    expect(url.searchParams.get('error')).toBeNull();

    const agentRows = h.db.select().from(agents).where(eq(agents.userId, user.id)).all();
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]!.name).toBe('Night shift');

    const codeRows = h.db.select().from(oauthCodes).all();
    expect(codeRows).toHaveLength(1);
    expect(codeRows[0]!.userId).toBe(user.id);
    expect(codeRows[0]!.agentId).toBe(agentRows[0]!.id);
    expect(codeRows[0]!.redirectUri).toBe(REDIRECT);
    expect(codeRows[0]!.codeChallenge).toBe(CHALLENGE);
    expect(codeRows[0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(codeRows[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
  });

  it('defaults the agent name to Claude Code', async () => {
    const {cookie, user} = await h.register();
    const client = (await registerClient(h)).json();
    await grantCode(h, cookie, client.client_id, {agent_name: '   '});

    expect(h.db.select().from(agents).where(eq(agents.userId, user.id)).get()!.name).toBe('Claude Code');
  });

  it('stores the code as a hash, never in plaintext', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();
    const {code} = await grantCode(h, cookie, client.client_id);

    const row = h.db.select().from(oauthCodes).get()!;
    expect(row.code).not.toBe(code);
    expect(row.code).toBe(createHash('sha256').update(code).digest('hex'));
  });

  it('redirects with error=access_denied when consent is refused', async () => {
    const {cookie, user} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await decide(h, cookie, client.client_id, 'deny');
    expect(res.statusCode).toBe(200);

    const url = new URL((res.json() as {redirectTo: string}).redirectTo);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz-state');
    expect(url.searchParams.get('code')).toBeNull();

    expect(h.db.select().from(agents).where(eq(agents.userId, user.id)).all()).toHaveLength(0);
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });

  it('refuses a consent decision without a session', async () => {
    const client = (await registerClient(h)).json();
    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      payload: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        decision: 'allow',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });

  it('refuses a cross-site form post of the consent decision', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: {...FORM, cookie},
      payload: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        decision: 'allow',
      }).toString(),
    });
    // A cross-origin HTML form can only send urlencoded/multipart/text-plain bodies, so
    // accepting nothing but JSON keeps a forged form off the consent endpoint.
    expect(res.statusCode).toBe(415);
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });

  it('refuses a consent decision that arrives from another origin', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: {cookie, origin: 'https://evil.example.com', host: 'localhost:3000'},
      payload: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        decision: 'allow',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
    expect(h.db.select().from(agents).all()).toHaveLength(0);
  });

  it('refuses a consent decision whose origin is the opaque null', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      // What a sandboxed iframe sends. It is not this origin, so it is not trusted.
      headers: {cookie, origin: 'null', host: 'localhost:3000'},
      payload: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        decision: 'allow',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });

  it('accepts a consent decision that names this origin', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: {cookie, origin: 'http://localhost:3000', host: 'localhost:3000'},
      payload: {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
        decision: 'allow',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('re-validates the redirect uri on the consent decision', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await decide(h, cookie, client.client_id, 'allow', {redirect_uri: 'https://evil.example.com/cb'});
    expect(res.statusCode).toBe(400);
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
    expect(h.db.select().from(agents).all()).toHaveLength(0);
  });

  it('re-validates the code challenge method on the consent decision', async () => {
    const {cookie} = await h.register();
    const client = (await registerClient(h)).json();

    const res = await decide(h, cookie, client.client_id, 'allow', {code_challenge_method: 'plain'});
    expect(res.statusCode).toBe(200);
    const url = new URL((res.json() as {redirectTo: string}).redirectTo);
    expect(url.searchParams.get('error')).toBe('invalid_request');
    expect(url.searchParams.get('code')).toBeNull();
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });
});

describe('oauth token exchange', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({config: config()});
  });

  it('exchanges a code with the right verifier exactly once', async () => {
    const {clientId, code, user} = await fullGrant(h);

    const first = await exchange(h, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(first.statusCode).toBe(200);

    const body = first.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^aj_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toMatch(/^aj_[A-Za-z0-9_-]{43}$/);
    expect(body.expires_in).toBe(8 * 60 * 60);
    expect(first.headers['cache-control']).toContain('no-store');

    // The code row is gone the moment it is spent.
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);

    const second = await exchange(h, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('invalid_grant');

    expect(authenticateBearer(h.db, `Bearer ${body.access_token}`)).toEqual({
      userId: user.id,
      agentId: expect.any(String),
    });
  });

  it('rejects an expired code', async () => {
    const {clientId, code} = await fullGrant(h);
    h.db
      .update(oauthCodes)
      .set({expiresAt: Date.now() - 1})
      .run();

    const res = await exchange(h, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });

  it('rejects a code replayed with a different client_id', async () => {
    const {code} = await fullGrant(h);
    const other = (await registerClient(h, {client_name: 'Other'})).json();

    const res = await exchange(h, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: other.client_id,
      code_verifier: VERIFIER,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    // A code presented by the wrong client is burned, not left for a later race.
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });

  it('rejects a code presented with a different redirect uri', async () => {
    const {clientId, code} = await fullGrant(h);

    const res = await exchange(h, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://127.0.0.1:41234/callback2',
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(0);
  });

  it('rejects a wrong or missing verifier, and one smuggled as plain', async () => {
    for (const verifier of [undefined, '', 'a'.repeat(43), CHALLENGE]) {
      const fresh = await createHarness({config: config()});
      const {clientId, code} = await fullGrant(fresh);

      const res = await exchange(fresh, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        ...(verifier === undefined ? {} : {code_verifier: verifier}),
      });
      expect(res.statusCode, String(verifier)).toBe(400);
      expect(res.json().error).toBe('invalid_grant');
      // A failed PKCE check burns the code too, so it cannot be brute-forced.
      expect(fresh.db.select().from(oauthCodes).all()).toHaveLength(0);
    }
  });

  it('rejects an unknown code without revealing anything about it', async () => {
    const {clientId} = await fullGrant(h);
    const res = await exchange(h, {
      grant_type: 'authorization_code',
      code: 'aj_totally-made-up-code-value-aaaaaaaaaaaaaaa',
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: VERIFIER,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({error: 'invalid_grant', error_description: expect.any(String)});
  });

  it('does not echo an attacker-supplied parameter name back in the error', async () => {
    const long = 'x'.repeat(5000);
    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: `grant_type=authorization_code&${long}=1&${long}=2`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    expect(res.body).not.toContain(long);
    expect(res.body.length).toBeLessThan(500);
  });

  it('refuses a token request with a repeated parameter', async () => {
    const {clientId, code} = await fullGrant(h);

    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT)}&client_id=${encodeURIComponent(clientId)}&code_verifier=${VERIFIER}&code_verifier=wrong`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    // Refused before anything was redeemed: the code survives for the real client.
    expect(h.db.select().from(oauthCodes).all()).toHaveLength(1);
  });

  it('rejects an unsupported grant type', async () => {
    const res = await exchange(h, {grant_type: 'password', username: 'a', password: 'b'});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unsupported_grant_type');
  });

  it('stores only hashes of tokens', async () => {
    const {clientId, code} = await fullGrant(h);
    const body = (
      await exchange(h, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      })
    ).json();

    const rows = h.db.select().from(oauthTokens).all();
    expect(rows).toHaveLength(1);

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(body.access_token);
    expect(serialised).not.toContain(body.refresh_token);
    expect(serialised).not.toContain('aj_');
    expect(rows[0]!.accessTokenHash).toBe(createHash('sha256').update(body.access_token).digest('hex'));
    expect(rows[0]!.refreshTokenHash).toBe(createHash('sha256').update(body.refresh_token).digest('hex'));
    expect(rows[0]!.expiresAt).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);
  });

  it('refreshes an access token and rotates the refresh token', async () => {
    const {clientId, code} = await fullGrant(h);
    const first = (
      await exchange(h, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      })
    ).json();

    const refreshed = await exchange(h, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.statusCode).toBe(200);

    const second = refreshed.json();
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(authenticateBearer(h.db, `Bearer ${second.access_token}`)).not.toBeNull();
    // The old access token dies with the rotation.
    expect(authenticateBearer(h.db, `Bearer ${first.access_token}`)).toBeNull();

    const reused = await exchange(h, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error).toBe('invalid_grant');
  });

  it('kills the whole chain when a rotated refresh token is replayed', async () => {
    const {clientId, code} = await fullGrant(h);
    const first = (
      await exchange(h, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      })
    ).json();
    const second = (
      await exchange(h, {grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId})
    ).json();

    // Replaying a spent refresh token is the signature of a stolen token.
    await exchange(h, {grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId});

    expect(authenticateBearer(h.db, `Bearer ${second.access_token}`)).toBeNull();
    const afterBreach = await exchange(h, {
      grant_type: 'refresh_token',
      refresh_token: second.refresh_token,
      client_id: clientId,
    });
    expect(afterBreach.statusCode).toBe(400);
  });

  it('rejects a refresh presented by a different client', async () => {
    const {clientId, code} = await fullGrant(h);
    const first = (
      await exchange(h, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      })
    ).json();
    const other = (await registerClient(h, {client_name: 'Other'})).json();

    const res = await exchange(h, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: other.client_id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('will not accept an access token as a refresh token', async () => {
    const {clientId, code} = await fullGrant(h);
    const first = (
      await exchange(h, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      })
    ).json();

    const res = await exchange(h, {
      grant_type: 'refresh_token',
      refresh_token: first.access_token,
      client_id: clientId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });
});

describe('bearer authentication', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({config: config()});
  });

  async function tokens() {
    const {clientId, code, user} = await fullGrant(h);
    const body = (
      await exchange(h, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      })
    ).json();
    return {...body, user, clientId} as {
      access_token: string;
      refresh_token: string;
      user: {id: string};
      clientId: string;
    };
  }

  it('resolves a live token to its user and agent', async () => {
    const t = await tokens();
    const result = authenticateBearer(h.db, `Bearer ${t.access_token}`);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(t.user.id);

    const agent = h.db.select().from(agents).where(eq(agents.id, result!.agentId)).get();
    expect(agent).toBeDefined();
    expect(agent!.userId).toBe(t.user.id);
  });

  it('accepts the scheme case-insensitively but nothing else', async () => {
    const t = await tokens();
    expect(authenticateBearer(h.db, `bearer ${t.access_token}`)).not.toBeNull();
    expect(authenticateBearer(h.db, `BEARER ${t.access_token}`)).not.toBeNull();
    expect(authenticateBearer(h.db, `Basic ${t.access_token}`)).toBeNull();
    expect(authenticateBearer(h.db, t.access_token)).toBeNull();
  });

  it('is safe with a missing or malformed header', async () => {
    for (const header of [undefined, '', '   ', 'Bearer', 'Bearer ', 'Bearer  ', 'Bearer a b', ' ']) {
      expect(authenticateBearer(h.db, header)).toBeNull();
    }
  });

  it('rejects an unknown token', async () => {
    expect(authenticateBearer(h.db, 'Bearer aj_not-a-real-token')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const t = await tokens();
    h.db
      .update(oauthTokens)
      .set({expiresAt: Date.now() - 1})
      .run();
    expect(authenticateBearer(h.db, `Bearer ${t.access_token}`)).toBeNull();
  });

  it('rejects a bearer token after the agent is revoked', async () => {
    const t = await tokens();
    const agentId = authenticateBearer(h.db, `Bearer ${t.access_token}`)!.agentId;

    h.db.delete(agents).where(eq(agents.id, agentId)).run();
    expect(authenticateBearer(h.db, `Bearer ${t.access_token}`)).toBeNull();
  });

  it('rejects a bearer token after the token is revoked', async () => {
    const t = await tokens();

    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: FORM,
      payload: new URLSearchParams({token: t.access_token, client_id: t.clientId}).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(authenticateBearer(h.db, `Bearer ${t.access_token}`)).toBeNull();
  });

  it('revokes the pair when the refresh token is the one revoked', async () => {
    const t = await tokens();
    await h.app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: FORM,
      payload: new URLSearchParams({token: t.refresh_token, client_id: t.clientId}).toString(),
    });

    expect(authenticateBearer(h.db, `Bearer ${t.access_token}`)).toBeNull();
    const res = await exchange(h, {
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: t.clientId,
    });
    expect(res.statusCode).toBe(400);
  });

  it('answers 200 to revoking a token that was never issued', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: FORM,
      payload: new URLSearchParams({token: 'aj_never-existed'}).toString(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('keeps one user out of another user tokens', async () => {
    const a = await tokens();
    const other = await h.register('other@example.com');
    const client = (await registerClient(h, {client_name: 'Other client'})).json();
    const {code} = await grantCode(h, other.cookie, client.client_id);
    const b = (
      await exchange(h, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: VERIFIER,
      })
    ).json();

    expect(authenticateBearer(h.db, `Bearer ${a.access_token}`)!.userId).toBe(a.user.id);
    expect(authenticateBearer(h.db, `Bearer ${b.access_token}`)!.userId).toBe(other.user.id);
    expect(authenticateBearer(h.db, `Bearer ${b.access_token}`)!.userId).not.toBe(a.user.id);
  });
});

describe('issueTokens', () => {
  it('issues a prefixed pair and stores only hashes', async () => {
    const h = await createHarness({config: config()});
    const {user, cookie} = await h.register();
    const registered = (await registerClient(h)).json();
    await grantCode(h, cookie, registered.client_id);

    const clientRow = h.db.select().from(oauthClients).where(eq(oauthClients.clientId, registered.client_id)).get()!;
    const agentRow = h.db.select().from(agents).where(eq(agents.userId, user.id)).get()!;

    const issued = issueTokens(h.db, {clientId: clientRow.id, userId: user.id, agentId: agentRow.id});

    expect(issued.accessToken.startsWith('aj_')).toBe(true);
    expect(issued.refreshToken.startsWith('aj_')).toBe(true);
    expect(issued.expiresIn).toBe(8 * 60 * 60);
    expect(issued.accessToken).not.toBe(issued.refreshToken);

    const row = h.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.accessTokenHash, createHash('sha256').update(issued.accessToken).digest('hex')))
      .get();
    expect(row).toBeDefined();
    expect(row!.userId).toBe(user.id);
    expect(row!.agentId).toBe(agentRow.id);
    expect(row!.revokedAt).toBeNull();
  });
});
