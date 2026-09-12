import {describe, it, expect, afterAll} from 'vitest';
import {buildApp} from './app.js';
import {createTestDb} from './db/testing.js';

const app = await buildApp({db: createTestDb()});
afterAll(() => app.close());

describe('health', () => {
  it('reports ok', async () => {
    const res = await app.inject({method: 'GET', url: '/api/health'});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({status: 'ok'});
  });
});
