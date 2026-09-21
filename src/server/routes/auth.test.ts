import {describe, it, expect, beforeEach} from 'vitest';
import {eq} from 'drizzle-orm';
import {createHarness} from '../testing/harness.js';
import {users} from '../db/schema.js';
import {LOGIN_RATE_LIMIT, REGISTER_RATE_LIMIT} from './auth.js';

describe('auth', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });

  it('registers and returns the user', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {email: 'Dev@Example.com ', password: 'hunter22hunter22'},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBe('dev@example.com'); // lowercased, trimmed
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('rate limits repeated login attempts', async () => {
    const payload = {email: 'dev@example.com', password: 'hunter22hunter22'};
    expect((await h.app.inject({method: 'POST', url: '/api/auth/register', payload})).statusCode).toBe(201);

    const wrong = {email: 'dev@example.com', password: 'not-the-password'};
    const codes: number[] = [];
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.max + 1; attempt += 1) {
      codes.push((await h.app.inject({method: 'POST', url: '/api/auth/login', payload: wrong})).statusCode);
    }

    // Every attempt costs a full argon2id verification, so an unthrottled endpoint is both
    // a password-guessing oracle and a cheap way to burn the box's CPU.
    expect(codes.slice(0, LOGIN_RATE_LIMIT.max)).toEqual(Array(LOGIN_RATE_LIMIT.max).fill(401));
    expect(codes.at(-1)).toBe(429);

    // The throttle must not become a lockout that also refuses the real password.
    const rejected = await h.app.inject({method: 'POST', url: '/api/auth/login', payload});
    expect(rejected.statusCode).toBe(429);
  });

  it('rate limits repeated registrations', async () => {
    const codes: number[] = [];
    for (let attempt = 0; attempt < REGISTER_RATE_LIMIT.max + 1; attempt += 1) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {email: `user${attempt}@example.com`, password: 'hunter22hunter22'},
      });
      codes.push(res.statusCode);
    }

    expect(codes.slice(0, REGISTER_RATE_LIMIT.max)).toEqual(Array(REGISTER_RATE_LIMIT.max).fill(201));
    expect(codes.at(-1)).toBe(429);
  });

  it('rejects a short password', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {email: 'a@b.co', password: 'short'},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate email', async () => {
    const payload = {email: 'dupe@example.com', password: 'hunter22hunter22'};

    const first = await h.app.inject({method: 'POST', url: '/api/auth/register', payload});
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({method: 'POST', url: '/api/auth/register', payload});
    expect(second.statusCode).toBe(409);
  });

  it('never stores the password in plaintext', async () => {
    const password = 'hunter22hunter22';
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {email: 'plain@example.com', password},
    });

    const row = h.db.select().from(users).where(eq(users.email, 'plain@example.com')).get();
    expect(row).toBeDefined();
    expect(row!.passwordHash).not.toBe(password);
    expect(row!.passwordHash.startsWith('$argon2')).toBe(true);
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    const email = 'login@example.com';
    const password = 'hunter22hunter22';
    await h.app.inject({method: 'POST', url: '/api/auth/register', payload: {email, password}});

    const ok = await h.app.inject({method: 'POST', url: '/api/auth/login', payload: {email, password}});
    expect(ok.statusCode).toBe(200);
    expect(ok.json().email).toBe(email);
    expect(ok.headers['set-cookie']).toBeTruthy();

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {email, password: 'wrong-password-123'},
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({error: 'invalid_credentials'});
  });

  it('returns the same status and body for an unknown email as for a wrong password', async () => {
    // Enumeration protection: an attacker probing emails must not be able to
    // distinguish "no such account" from "account exists, wrong password".
    const email = 'known@example.com';
    const password = 'hunter22hunter22';
    await h.app.inject({method: 'POST', url: '/api/auth/register', payload: {email, password}});

    const unknownEmail = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {email: 'unknown@example.com', password},
    });
    const wrongPassword = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {email, password: 'wrong-password-123'},
    });

    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('401s on /api/me without a session and 200s with one', async () => {
    const anon = await h.app.inject({method: 'GET', url: '/api/me'});
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({error: 'unauthorized'});

    const {cookie, user} = await h.register();
    const authed = await h.app.inject({method: 'GET', url: '/api/me', headers: {cookie}});
    expect(authed.statusCode).toBe(200);
    // requireUser only puts {id, email} on req.user (see services/auth.ts) — /api/me
    // echoes exactly that, not the full user record.
    expect(authed.json()).toEqual({id: user.id, email: user.email});
  });

  it('logs out, invalidating the session', async () => {
    const {cookie} = await h.register();

    const before = await h.app.inject({method: 'GET', url: '/api/me', headers: {cookie}});
    expect(before.statusCode).toBe(200);

    const logout = await h.app.inject({method: 'POST', url: '/api/auth/logout', headers: {cookie}});
    expect(logout.statusCode).toBe(204);

    const after = await h.app.inject({method: 'GET', url: '/api/me', headers: {cookie}});
    expect(after.statusCode).toBe(401);
  });
});
