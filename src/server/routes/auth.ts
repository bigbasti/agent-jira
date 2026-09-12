import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {registerUser, verifyUser, requireUser, ConflictError} from '../services/auth.js';
import {SESSION_COOKIE_NAME} from '../plugins/session.js';

/** Registers `/api/auth/*` and `/api/me` on `app`. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
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

  app.post('/api/auth/login', async (req, reply) => {
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
