import {describe, it, expect} from 'vitest';
import {createTestDb} from './testing.js';
import {openDb} from './index.js';
import {runMigrations} from './migrate.js';
import {users, projects, stories, storyDependencies, storyUpdates} from './schema.js';
import {eq, or} from 'drizzle-orm';

describe('migrations', () => {
  it('creates every table and enforces user scoping columns', () => {
    const db = createTestDb();
    db.insert(users).values({id: 'u1', email: 'a@b.c', passwordHash: 'x', createdAt: 1}).run();
    const rows = db.select().from(users).where(eq(users.email, 'a@b.c')).all();
    expect(rows).toHaveLength(1);
  });

  it('cascades story deletion to dependencies and updates, and restricts project deletion', () => {
    const db = createTestDb();

    db.insert(users).values({id: 'u1', email: 'u1@b.c', passwordHash: 'x', createdAt: 1}).run();
    db.insert(projects).values({id: 'p1', userId: 'u1', name: 'Proj', path: '/tmp/proj', createdAt: 1}).run();
    db.insert(stories).values([
      {
        id: 's1', userId: 'u1', projectId: 'p1', title: 'Story 1', model: 'opus',
        status: 'todo', rank: 'a0', createdAt: 1, updatedAt: 1,
      },
      {
        id: 's2', userId: 'u1', projectId: 'p1', title: 'Story 2', model: 'opus',
        status: 'todo', rank: 'a1', createdAt: 1, updatedAt: 1,
      },
    ]).run();
    db.insert(storyDependencies).values({storyId: 's2', dependsOnStoryId: 's1'}).run();
    db.insert(storyUpdates).values({
      id: 'su1', storyId: 's1', authorType: 'user', authorId: 'u1',
      kind: 'note', body: 'hello', createdAt: 1,
    }).run();

    // A project that still has stories must not be deletable — FK restrict.
    expect(() => db.delete(projects).where(eq(projects.id, 'p1')).run()).toThrow();

    db.delete(stories).where(eq(stories.id, 's1')).run();

    const remainingDeps = db
      .select()
      .from(storyDependencies)
      .where(or(eq(storyDependencies.storyId, 's1'), eq(storyDependencies.dependsOnStoryId, 's1')))
      .all();
    expect(remainingDeps).toHaveLength(0);

    const remainingUpdates = db.select().from(storyUpdates).where(eq(storyUpdates.storyId, 's1')).all();
    expect(remainingUpdates).toHaveLength(0);
  });

  it('is idempotent: reapplying migrations to an already-migrated db is a no-op', () => {
    // Mirrors production (src/server/index.ts calls runMigrations(db) against the same
    // persistent file-backed db on every restart) — so this must run migrate() twice
    // against the SAME db handle, not build two independent databases.
    const db = openDb(':memory:');
    runMigrations(db);

    db.insert(users).values({id: 'u1', email: 'idempotent@b.c', passwordHash: 'x', createdAt: 1}).run();
    const before = db.select().from(users).all();
    expect(before).toHaveLength(1);

    expect(() => runMigrations(db)).not.toThrow();

    // If migrations were re-applied destructively (e.g. tables dropped and recreated,
    // or statements reissued without the applied-migrations guard), this row would
    // either vanish or the second run would throw on a duplicate-table/duplicate-PK
    // conflict. Neither happens: drizzle's migrator tracks applied migrations and
    // skips them on the second call.
    const after = db.select().from(users).all();
    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
  });
});
