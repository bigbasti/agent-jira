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
// process's cwd. A bare "/" (or a bare Windows drive root like "C:\") is rejected too:
// it's never a legitimate project checkout, and handing an agent the filesystem root as
// its cwd is a foot-gun worth ruling out up front rather than trusting every later
// caller to guard against — so at least one real path segment is required past the
// root. A NUL byte is rejected outright since it can truncate the path in underlying
// C-level filesystem calls, silently pointing the agent somewhere other than intended.
const absolutePath = z
  .string()
  .trim()
  .min(1)
  .refine(p => !p.includes('\0'), 'Path must not contain a NUL byte')
  .refine(p => /^\/[^/]/.test(p) || /^[A-Za-z]:\\[^\\]/.test(p), 'Path must be an absolute path with at least one segment');

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

function isForeignKeyRestrictError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && typeof (err as {code?: unknown}).code === 'string' && (err as {code: string}).code.startsWith('SQLITE_CONSTRAINT');
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
 * throw a raw SQLite error) so the route can return a clean 409. The pre-check and the
 * delete are not atomic in principle — under today's single-process synchronous
 * better-sqlite3 model no interleaving is possible, so this is theoretical — but the
 * delete is wrapped in a catch anyway so a raw `SQLITE_CONSTRAINT` from the restrict FK
 * (if that model ever changes) still translates to the same clean 409 rather than
 * surfacing as a 500. Publishes `{type: 'project.changed'}` on `hub` for `userId`.
 */
export function deleteProject(db: Database, hub: EventHub, userId: string, id: string): void {
  const existing = findOwnedProject(db, userId, id);
  if (!existing) {
    throw new NotFoundError();
  }

  const hasStories = db
    .select({id: stories.id})
    .from(stories)
    .where(and(eq(stories.projectId, id), eq(stories.userId, userId)))
    .get();
  if (hasStories) {
    throw new ConflictError('Project still has stories');
  }

  try {
    db.delete(projects)
      .where(and(eq(projects.id, id), eq(projects.userId, userId)))
      .run();
  } catch (err) {
    if (isForeignKeyRestrictError(err)) {
      throw new ConflictError('Project still has stories');
    }
    throw err;
  }

  hub.publish(userId, {type: 'project.changed'});
}
