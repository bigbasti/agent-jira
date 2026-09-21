import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {describe, it, expect, afterAll} from 'vitest';
import {buildApp} from './app.js';
import {createTestDb} from './db/testing.js';
import {loadConfig} from './config.js';

const app = await buildApp({db: createTestDb()});
afterAll(() => app.close());

describe('health', () => {
  it('reports ok', async () => {
    const res = await app.inject({method: 'GET', url: '/api/health'});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({status: 'ok'});
  });
});

describe('security headers', () => {
  it('tells every browser not to sniff a content type, and not to frame the app', async () => {
    const res = await app.inject({method: 'GET', url: '/api/health'});

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // The consent screen is a route in this SPA: a decision that hands an agent access to
    // the board must not be framable by the page that asked for it.
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('carries them on an error response too', async () => {
    const res = await app.inject({method: 'GET', url: '/api/agents'});

    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('SPA serving in production', () => {
  const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testing/spa-fixture');

  async function buildProdApp() {
    const built = await buildApp({
      db: createTestDb(),
      config: {...loadConfig({} as NodeJS.ProcessEnv), nodeEnv: 'production'},
      webDir,
    });
    await built.ready();
    return built;
  }

  it('is not registered outside production — no static plugin, no fallback', async () => {
    // The default app built above uses the default (development) config.
    const res = await app.inject({method: 'GET', url: '/some-spa-route'});
    expect(res.statusCode).toBe(404);
  });

  it('serves a real static asset as-is', async () => {
    const prodApp = await buildProdApp();
    try {
      const res = await prodApp.inject({method: 'GET', url: '/assets/app.js'});
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('fixture asset');
    } finally {
      await prodApp.close();
    }
  });

  it('falls back to index.html for an unmatched SPA route', async () => {
    const prodApp = await buildProdApp();
    try {
      const res = await prodApp.inject({method: 'GET', url: '/consent'});
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('falls back to index.html at the root path too', async () => {
    const prodApp = await buildProdApp();
    try {
      const res = await prodApp.inject({method: 'GET', url: '/'});
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('404s a missing static asset instead of returning index.html', async () => {
    const prodApp = await buildProdApp();
    try {
      const res = await prodApp.inject({method: 'GET', url: '/assets/does-not-exist.js'});
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('never shadows an unmatched /api/* path with the SPA fallback', async () => {
    const prodApp = await buildProdApp();
    try {
      const res = await prodApp.inject({method: 'GET', url: '/api/does-not-exist'});
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('never shadows an unmatched /.well-known/* path with the SPA fallback', async () => {
    const prodApp = await buildProdApp();
    try {
      const res = await prodApp.inject({method: 'GET', url: '/.well-known/does-not-exist'});
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('never shadows /ws or /mcp with the SPA fallback', async () => {
    const prodApp = await buildProdApp();
    try {
      const wsRes = await prodApp.inject({method: 'GET', url: '/ws'});
      expect(wsRes.body).not.toContain('<div id="root">');

      const mcpRes = await prodApp.inject({method: 'GET', url: '/mcp'});
      expect(mcpRes.body).not.toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('never shadows /ws/ or /mcp/ (a trailing slash) with the SPA fallback', async () => {
    // `/ws` and `/mcp` are registered as exact routes, so `/ws/`/`/mcp/` don't match them
    // and fall through to the notFoundHandler — exactly the path that must still refuse,
    // not silently serve `index.html`, for a client that appends a trailing slash.
    const prodApp = await buildProdApp();
    try {
      const wsRes = await prodApp.inject({method: 'GET', url: '/ws/'});
      expect(wsRes.statusCode).toBe(404);
      expect(wsRes.body).not.toContain('<div id="root">');

      const mcpRes = await prodApp.inject({method: 'GET', url: '/mcp/'});
      expect(mcpRes.statusCode).toBe(404);
      expect(mcpRes.body).not.toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('never shadows an alternate-case reserved path with the SPA fallback', async () => {
    const prodApp = await buildProdApp();
    try {
      const upperApi = await prodApp.inject({method: 'GET', url: '/API/does-not-exist'});
      expect(upperApi.statusCode).toBe(404);
      expect(upperApi.body).not.toContain('<div id="root">');

      const upperWellKnown = await prodApp.inject({method: 'GET', url: '/.WELL-KNOWN/does-not-exist'});
      expect(upperWellKnown.statusCode).toBe(404);
      expect(upperWellKnown.body).not.toContain('<div id="root">');

      const upperWs = await prodApp.inject({method: 'GET', url: '/WS/'});
      expect(upperWs.statusCode).toBe(404);
      expect(upperWs.body).not.toContain('<div id="root">');

      const upperMcp = await prodApp.inject({method: 'GET', url: '/MCP/'});
      expect(upperMcp.statusCode).toBe(404);
      expect(upperMcp.body).not.toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });

  it('does not fall back to index.html for a non-GET method', async () => {
    const prodApp = await buildProdApp();
    try {
      const res = await prodApp.inject({method: 'POST', url: '/consent'});
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain('<div id="root">');
    } finally {
      await prodApp.close();
    }
  });
});
