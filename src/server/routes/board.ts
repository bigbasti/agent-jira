import type {FastifyInstance} from 'fastify';
import {requireUser} from '../services/auth.js';
import {getBoard} from '../services/board.js';

/** Registers `GET /api/board` — the whole board for the session's user. */
export async function boardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/board', {preHandler: requireUser}, async req => {
    return getBoard(app.db, req.user!.id);
  });
}
