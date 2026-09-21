import type {FastifyInstance} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {z} from 'zod';
import {registerUser, verifyUser, requireUser, ConflictError} from '../services/auth.js';
import {SESSION_COOKIE_NAME} from '../plugins/session.js';

/**
 * Ten tries a minute per address. Every attempt costs a full argon2id verification, so an
 * unthrottled login is both a password-guessing oracle and a cheap way to pin the box's
 * CPU; ten leaves room for a human's typos and nothing for a script.
 */
export const LOGIN_RATE_LIMIT = {max: 10, timeWindow: '1 minute'} as const;

/** Signing up is a once-per-person act. Five an hour per address is already generous. */
export const REGISTER_RATE_LIMIT = {max: 5, timeWindow: '1 hour'} as const;

/** Registers `/api/auth/*` and `/api/me` on `app`. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Scoped to these routes (`global: false`): the limits below are the only ones here, and
  // the board's own endpoints — which a working agent hits constantly — stay unlimited.
  await app.register(rateLimit, {global: false});

  app.post('/api/auth/register', {config: {rateLimit: REGISTER_RATE_LIMIT}}, async (req, reply) => {
    try {
      const user = await registerUser(app.db, req.body);
      req.session.userId = user.id;
      await req.session.save();
      return reply.code(201).send(user);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({error: 'invalid_request', details: err.issues});
      }
      if (err instanceof ConflictError) {
        return reply.code(409).send({error: 'conflict'});
      }
      throw err;
    }
  });

  app.post('/api/auth/login', {config: {rateLimit: LOGIN_RATE_LIMIT}}, async (req, reply) => {
    let user;
    try {
      user = await verifyUser(app.db, req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({error: 'invalid_request', details: err.issues});
      }
      throw err;
    }

    if (!user) {
      return reply.code(401).send({error: 'invalid_credentials'});
    }

    req.session.userId = user.id;
    await req.session.save();
    return reply.send(user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await req.session.destroy();
    reply.clearCookie(SESSION_COOKIE_NAME, {path: '/'});
    return reply.code(204).send();
  });

  app.get('/api/me', {preHandler: requireUser}, async req => {
    return req.user;
  });
}
