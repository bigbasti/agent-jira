import {describe, it, expect, beforeEach} from 'vitest';
import {createHarness} from '../testing/harness.js';
import {stories} from '../db/schema.js';
import type {ServerEvent} from '../../shared/types.js';

describe('projects', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });

  it('creates a project with a name and an absolute path', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({name: 'agent-jira', path: '/Users/dev/git/agent-jira'});
  });

  it('rejects a relative path', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: 'relative/dir'},
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a Windows-style absolute path', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: 'C:\\dev\\agent-jira'},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({name: 'agent-jira', path: 'C:\\dev\\agent-jira'});
  });

  it('rejects a bare "/" path (no path segment)', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/'},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a path containing a NUL byte', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/\0evil'},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty name', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: '   ', path: '/Users/dev/git/agent-jira'},
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists only the caller's projects", async () => {
    const {cookie: cookieA} = await h.register('a@example.com');
    const {cookie: cookieB} = await h.register('b@example.com');

    await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie: cookieA},
      payload: {name: 'proj-a', path: '/Users/dev/a'},
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie: cookieB},
      payload: {name: 'proj-b', path: '/Users/dev/b'},
    });

    const resA = await h.app.inject({method: 'GET', url: '/api/projects', headers: {cookie: cookieA}});
    expect(resA.statusCode).toBe(200);
    const listA = resA.json();
    expect(listA).toHaveLength(1);
    expect(listA[0]).toMatchObject({name: 'proj-a', path: '/Users/dev/a'});

    const resB = await h.app.inject({method: 'GET', url: '/api/projects', headers: {cookie: cookieB}});
    expect(resB.statusCode).toBe(200);
    const listB = resB.json();
    expect(listB).toHaveLength(1);
    expect(listB[0]).toMatchObject({name: 'proj-b', path: '/Users/dev/b'});
  });

  it("404s when updating another user's project", async () => {
    const {cookie: cookieA} = await h.register('a@example.com');
    const {cookie: cookieB} = await h.register('b@example.com');

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie: cookieA},
      payload: {name: 'proj-a', path: '/Users/dev/a'},
    });
    const {id} = created.json();

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: {cookie: cookieB},
      payload: {name: 'renamed'},
    });
    expect(res.statusCode).toBe(404);

    // Confirm the row was genuinely untouched, not just that the response looked like a 404.
    const stillA = await h.app.inject({method: 'GET', url: '/api/projects', headers: {cookie: cookieA}});
    expect(stillA.json()[0]).toMatchObject({name: 'proj-a'});
  });

  it('404s when updating a project that does not exist', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/projects/does-not-exist',
      headers: {cookie},
      payload: {name: 'renamed'},
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates a project the caller owns', async () => {
    const {cookie} = await h.register();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'},
    });
    const {id} = created.json();

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/projects/${id}`,
      headers: {cookie},
      payload: {name: 'renamed'},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({id, name: 'renamed', path: '/Users/dev/git/agent-jira'});
  });

  it('rejects an empty PATCH body (nothing to update)', async () => {
    const {cookie} = await h.register();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'},
    });
    const {id} = created.json();

    const res = await h.app.inject({method: 'PATCH', url: `/api/projects/${id}`, headers: {cookie}, payload: {}});
    expect(res.statusCode).toBe(400);
  });

  it('409s when deleting a project that still has stories', async () => {
    const {cookie, user} = await h.register();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'},
    });
    const {id: projectId} = created.json();

    h.db
      .insert(stories)
      .values({
        id: 's1',
        userId: user.id,
        projectId,
        title: 'Story 1',
        model: 'opus',
        status: 'todo',
        rank: 'a0',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();

    const res = await h.app.inject({method: 'DELETE', url: `/api/projects/${projectId}`, headers: {cookie}});
    expect(res.statusCode).toBe(409);

    // The project must still be there — the 409 is a deliberate refusal, not a failed delete.
    const list = await h.app.inject({method: 'GET', url: '/api/projects', headers: {cookie}});
    expect(list.json()).toHaveLength(1);
  });

  it('deletes a project with no stories', async () => {
    const {cookie} = await h.register();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'},
    });
    const {id} = created.json();

    const res = await h.app.inject({method: 'DELETE', url: `/api/projects/${id}`, headers: {cookie}});
    expect(res.statusCode).toBe(204);

    const list = await h.app.inject({method: 'GET', url: '/api/projects', headers: {cookie}});
    expect(list.json()).toHaveLength(0);
  });

  it("404s when deleting another user's project", async () => {
    const {cookie: cookieA} = await h.register('a@example.com');
    const {cookie: cookieB} = await h.register('b@example.com');

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie: cookieA},
      payload: {name: 'proj-a', path: '/Users/dev/a'},
    });
    const {id} = created.json();

    const res = await h.app.inject({method: 'DELETE', url: `/api/projects/${id}`, headers: {cookie: cookieB}});
    expect(res.statusCode).toBe(404);

    const stillA = await h.app.inject({method: 'GET', url: '/api/projects', headers: {cookie: cookieA}});
    expect(stillA.json()).toHaveLength(1);
  });

  it('all project routes require auth', async () => {
    const list = await h.app.inject({method: 'GET', url: '/api/projects'});
    expect(list.statusCode).toBe(401);

    const create = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {name: 'x', path: '/x'},
    });
    expect(create.statusCode).toBe(401);

    const patch = await h.app.inject({method: 'PATCH', url: '/api/projects/whatever', payload: {name: 'x'}});
    expect(patch.statusCode).toBe(401);

    const del = await h.app.inject({method: 'DELETE', url: '/api/projects/whatever'});
    expect(del.statusCode).toBe(401);
  });

  it('publishes project.changed on create', async () => {
    const {cookie, user} = await h.register();
    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, event => events.push(event));

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'},
    });
    expect(res.statusCode).toBe(201);

    expect(events).toContainEqual({type: 'project.changed'});
    unsubscribe();
  });

  it('publishes project.changed on update and delete', async () => {
    const {cookie, user} = await h.register();
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'},
    });
    const {id} = created.json();

    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, event => events.push(event));

    await h.app.inject({method: 'PATCH', url: `/api/projects/${id}`, headers: {cookie}, payload: {name: 'renamed'}});
    await h.app.inject({method: 'DELETE', url: `/api/projects/${id}`, headers: {cookie}});

    expect(events).toEqual([{type: 'project.changed'}, {type: 'project.changed'}]);
    unsubscribe();
  });
});
