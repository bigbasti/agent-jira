import {buildApp} from '../app.js';
import {createTestDb} from '../db/testing.js';
import type {User} from '../../shared/types.js';

/**
 * Builds a fully wired app (migrated in-memory db, sessions, auth routes) for server
 * tests, plus a `register` helper that returns a ready-to-use session cookie.
 */
export async function createHarness() {
  const db = createTestDb();
  const app = await buildApp({db});
  await app.ready();

  async function register(
    email = 'dev@example.com',
    password = 'hunter22hunter22',
  ): Promise<{cookie: string; user: User}> {
    const res = await app.inject({method: 'POST', url: '/api/auth/register', payload: {email, password}});
    const cookie = (res.headers['set-cookie'] as string).split(';')[0]!;
    return {cookie, user: res.json() as User};
  }

  return {app, db, register};
}
