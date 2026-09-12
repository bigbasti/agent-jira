import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {requireUser, ConflictError} from '../services/auth.js';
import {listProjects, createProject, updateProject, deleteProject, NotFoundError} from '../services/projects.js';

/** Registers `/api/projects*` on `app`. All routes require an authenticated user. */
export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', {preHandler: requireUser}, async req => {
    return listProjects(app.db, req.user!.id);
  });

  app.post('/api/projects', {preHandler: requireUser}, async (req, reply) => {
    try {
      const project = createProject(app.db, app.hub, req.user!.id, req.body);
      return reply.code(201).send(project);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({error: 'invalid_request', details: err.issues});
      }
      throw err;
    }
  });

  app.patch('/api/projects/:id', {preHandler: requireUser}, async (req, reply) => {
    const {id} = req.params as {id: string};
    try {
      const project = updateProject(app.db, app.hub, req.user!.id, id, req.body);
      return reply.send(project);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return reply.code(400).send({error: 'invalid_request', details: err.issues});
      }
      if (err instanceof NotFoundError) {
        return reply.code(404).send({error: 'not_found'});
      }
      throw err;
    }
  });

  app.delete('/api/projects/:id', {preHandler: requireUser}, async (req, reply) => {
    const {id} = req.params as {id: string};
    try {
      deleteProject(app.db, app.hub, req.user!.id, id);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof NotFoundError) {
        return reply.code(404).send({error: 'not_found'});
      }
      if (err instanceof ConflictError) {
        return reply.code(409).send({error: 'conflict'});
      }
      throw err;
    }
  });
}
