import {and, eq} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import {z} from 'zod';
import type {Database} from '../db/index.js';
import {projects, stories} from '../db/schema.js';
import type {EventHub} from '../events/hub.js';
import type {Project} from '../../shared/types.js';
import {ConflictError} from './auth.js';

export class NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

// An absolute path is required because `project.path` becomes the agent's working
// directory over MCP — a relative path would be meaningless without knowing the agent
// process's cwd.
const absolutePath = z
  .string()
  .trim()
  .min(1)
  .refine(p => p.startsWith('/') || /^[A-Za-z]:\\/.test(p), 'Path must be absolute');

export const createProjectSchema = z.object({
  name: z.string().trim().min(1),
  path: absolutePath,
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    path: absolutePath.optional(),
  })
  .refine(input => input.name !== undefined || input.path !== undefined, 'Nothing to update');

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

function findOwnedProject(db: Database, userId: string, id: string) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .get();
}

/** Lists every project belonging to `userId`. */
export function listProjects(db: Database, userId: string): Project[] {
  return db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .all()
    .map(toProject);
}

/**
 * Creates a project for `userId`. `input` is validated with `createProjectSchema`
 * (throws `ZodError` on an invalid shape, empty name, or non-absolute path). Publishes
 * `{type: 'project.changed'}` on `hub` for `userId`.
 */
export function createProject(db: Database, hub: EventHub, userId: string, input: unknown): Project {
  const {name, path} = createProjectSchema.parse(input);
  const row = {id: nanoid(), userId, name, path, createdAt: Date.now(), archivedAt: null};
  db.insert(projects).values(row).run();

  const project = toProject(row);
  hub.publish(userId, {type: 'project.changed'});
  return project;
}

/**
 * Updates a project owned by `userId`. `input` is validated with `updateProjectSchema`.
 * Throws `NotFoundError` if no project with `id` belongs to `userId` — a project owned
 * by another user is indistinguishable from a missing one. Publishes
 * `{type: 'project.changed'}` on `hub` for `userId`.
 */
export function updateProject(db: Database, hub: EventHub, userId: string, id: string, input: unknown): Project {
  const updates = updateProjectSchema.parse(input);

  const existing = findOwnedProject(db, userId, id);
  if (!existing) {
    throw new NotFoundError();
  }

  const row = {...existing, ...updates};
  db.update(projects)
    .set(updates)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .run();

  const project = toProject(row);
  hub.publish(userId, {type: 'project.changed'});
  return project;
}

/**
 * Deletes a project owned by `userId`. Throws `NotFoundError` if no project with `id`
 * belongs to `userId`. Throws `ConflictError` if the project still has stories — checked
 * explicitly here (rather than letting `stories.project_id`'s `onDelete: 'restrict'` FK
 * throw a raw SQLite error) so the route can return a clean 409. Publishes
 * `{type: 'project.changed'}` on `hub` for `userId`.
 */
export function deleteProject(db: Database, hub: EventHub, userId: string, id: string): void {
  const existing = findOwnedProject(db, userId, id);
  if (!existing) {
    throw new NotFoundError();
  }

  const hasStories = db.select({id: stories.id}).from(stories).where(eq(stories.projectId, id)).get();
  if (hasStories) {
    throw new ConflictError('Project still has stories');
  }

  db.delete(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .run();

  hub.publish(userId, {type: 'project.changed'});
}
