import type {FastifyInstance, FastifyReply} from 'fastify';
import {z} from 'zod';
import {requireUser} from '../services/auth.js';
import {NotFoundError} from '../services/projects.js';
import {authenticateBearer} from '../oauth/tokens.js';
import {listAgents, nextQueuedStory, patchAgent, revokeAgent} from '../services/agents.js';

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({error: 'invalid_request', message: err.issues[0]?.message, details: err.issues});
  }
  if (err instanceof NotFoundError) {
    return reply.code(404).send({error: 'not_found'});
  }
  throw err;
}

/** Registers `/api/agents*` on `app`. All routes require an authenticated user. */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const agentId = (req: {params: unknown}) => (req.params as {id: string}).id;

  app.get('/api/agents', {preHandler: requireUser}, async req => listAgents(app.db, req.user!.id));

  app.patch('/api/agents/:id', {preHandler: requireUser}, async (req, reply) => {
    try {
      return reply.send(patchAgent(app.db, app.hub, req.user!.id, agentId(req), req.body));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/agents/:id', {preHandler: requireUser}, async (req, reply) => {
    try {
      revokeAgent(app.db, app.hub, req.user!.id, agentId(req));
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // The host runner script's cold-start poll. Bearer-authenticated with the same tokens
  // MCP uses (an agent's connection, minted by the OAuth consent flow) rather than the
  // human's session cookie — the runner has no browser session, only a bearer token
  // minted the same way any agent's is (see README.md's "Host runner" section for how
  // to get one).
  app.get('/api/runner/queued', async (req, reply) => {
    const identity = authenticateBearer(app.db, req.headers.authorization);
    if (!identity) {
      return reply.code(401).send({error: 'invalid_token', message: 'A valid bearer token is required.'});
    }
    const story = nextQueuedStory(app.db, identity.userId);
    return reply.send({story: story ?? null});
  });
}
