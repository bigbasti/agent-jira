import {describe, it, expect, beforeEach} from 'vitest';
import {createHarness} from '../testing/harness.js';
import type {AppConfig} from '../config.js';

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

describe('GET /api/config', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness({config: config({publicUrl: 'https://board.example'})});
  });

  it('401s without a session', async () => {
    const res = await h.app.inject({method: 'GET', url: '/api/config'});
    expect(res.statusCode).toBe(401);
  });

  it("derives mcpUrl from the server's publicUrl — never hardcoded", async () => {
    const {cookie} = await h.register();

    const res = await h.app.inject({method: 'GET', url: '/api/config', headers: {cookie}});

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({publicUrl: 'https://board.example', mcpUrl: 'https://board.example/mcp'});
  });

  it('trims a trailing slash off publicUrl so mcpUrl never doubles a slash', async () => {
    const fresh = await createHarness({config: config({publicUrl: 'https://board.example/'})});
    const {cookie} = await fresh.register();

    const res = await fresh.app.inject({method: 'GET', url: '/api/config', headers: {cookie}});

    expect(res.json()).toEqual({publicUrl: 'https://board.example', mcpUrl: 'https://board.example/mcp'});
  });
});
