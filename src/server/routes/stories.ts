import type {FastifyInstance, FastifyReply} from 'fastify';
import {z} from 'zod';
import {requireUser} from '../services/auth.js';
import {NotFoundError} from '../services/projects.js';
import {
  TransitionError,
  ValidationError,
  addUpdate,
  createStory,
  deleteStory,
  getStory,
  listUpdates,
  moveStory,
  moveStoryBodySchema,
  postProgress,
  progressSchema,
  remarkSchema,
  requestPlay,
  requestStop,
  updateStory,
} from '../services/stories.js';

/**
 * Maps the service layer's typed errors onto status codes, and rethrows anything else so
 * an unexpected failure still surfaces as a 500 rather than a misleading 4xx.
 */
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({error: 'invalid_request', message: err.issues[0]?.message, details: err.issues});
  }
  if (err instanceof ValidationError) {
    return reply.code(400).send({error: 'invalid_request', message: err.message});
  }
  if (err instanceof NotFoundError) {
    return reply.code(404).send({error: 'not_found'});
  }
  if (err instanceof TransitionError) {
    return reply.code(409).send({error: 'transition_refused', message: err.message});
  }
  throw err;
}

/** Registers `/api/stories*` on `app`. All routes require an authenticated user. */
export async function storyRoutes(app: FastifyInstance): Promise<void> {
  // Every REST caller is the human sitting in front of the board; the agent actor reaches
  // the same services through MCP, never through these routes.
  const storyId = (req: {params: unknown}) => (req.params as {id: string}).id;

  app.post('/api/stories', {preHandler: requireUser}, async (req, reply) => {
    try {
      return reply.code(201).send(createStory(app.db, app.hub, req.user!.id, req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/stories/:id', {preHandler: requireUser}, async (req, reply) => {
    try {
      return reply.send(getStory(app.db, req.user!.id, storyId(req)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch('/api/stories/:id', {preHandler: requireUser}, async (req, reply) => {
    try {
      return reply.send(updateStory(app.db, app.hub, req.user!.id, storyId(req), req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/stories/:id/move', {preHandler: requireUser}, async (req, reply) => {
    try {
      const {status, beforeId, afterId} = moveStoryBodySchema.parse(req.body);
      return reply.send(
        moveStory(app.db, app.hub, {
          userId: req.user!.id,
          storyId: storyId(req),
          status,
          beforeId,
          afterId,
          actor: 'user',
        }),
      );
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/stories/:id/progress', {preHandler: requireUser}, async (req, reply) => {
    try {
      const {progressPct, label} = progressSchema.parse(req.body);
      return reply.send(postProgress(app.db, app.hub, {userId: req.user!.id, storyId: storyId(req), progressPct, label}));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/stories/:id/play', {preHandler: requireUser}, async (req, reply) => {
    try {
      return reply.send(requestPlay(app.db, app.hub, req.user!.id, storyId(req)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/stories/:id/stop', {preHandler: requireUser}, async (req, reply) => {
    try {
      return reply.send(requestStop(app.db, app.hub, req.user!.id, storyId(req)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/stories/:id', {preHandler: requireUser}, async (req, reply) => {
    try {
      deleteStory(app.db, app.hub, req.user!.id, storyId(req));
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/stories/:id/updates', {preHandler: requireUser}, async (req, reply) => {
    try {
      return reply.send(listUpdates(app.db, req.user!.id, storyId(req)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/stories/:id/updates', {preHandler: requireUser}, async (req, reply) => {
    try {
      const {body} = remarkSchema.parse(req.body);
      const userId = req.user!.id;
      const update = addUpdate(app.db, app.hub, {
        userId,
        storyId: storyId(req),
        body,
        kind: 'remark',
        authorType: 'user',
        authorId: userId,
      });
      return reply.code(201).send(update);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
