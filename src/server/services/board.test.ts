import {describe, it, expect, beforeEach} from 'vitest';
import {createHarness} from '../testing/harness.js';
import {agents} from '../db/schema.js';
import {getBoard} from './board.js';
import {STATUSES} from '../../shared/status.js';
import type {Story} from '../../shared/types.js';

describe('board', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });

  async function setup(email = 'a@example.com') {
    const {cookie, user} = await h.register(email);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: `project-${email}`, path: `/Users/dev/${email}`},
    });
    return {cookie, user, projectId: res.json().id as string};
  }

  async function createStory(cookie: string, payload: Record<string, unknown>) {
    const res = await h.app.inject({method: 'POST', url: '/api/stories', headers: {cookie}, payload});
    expect(res.statusCode).toBe(201);
    return res.json() as Story;
  }

  it('lists the six columns in board order', async () => {
    const {user} = await setup();
    expect(getBoard(h.db, user.id).columns).toEqual([...STATUSES]);
  });

  it('returns the stories, projects and agents of one user', async () => {
    const {cookie, user, projectId} = await setup();
    h.db.insert(agents).values({id: 'agent-1', userId: user.id, name: 'Worker', createdAt: Date.now()}).run();
    const story = await createStory(cookie, {projectId, title: 'On the board'});

    const board = getBoard(h.db, user.id);
    expect(board.stories.map(s => s.id)).toEqual([story.id]);
    expect(board.projects.map(p => p.id)).toEqual([projectId]);
    expect(board.agents).toMatchObject([{id: 'agent-1', name: 'Worker', status: 'offline', autonomous: false}]);
  });

  it('orders stories by rank and carries blockedBy', async () => {
    const {cookie, user, projectId} = await setup();
    const first = await createStory(cookie, {projectId, title: 'First'});
    const second = await createStory(cookie, {projectId, title: 'Second', dependsOn: [first.id]});

    const board = getBoard(h.db, user.id);
    expect(board.stories.map(s => s.title)).toEqual(['First', 'Second']);
    expect(board.stories.map(s => s.blockedBy)).toEqual([[], [first.id]]);

    // Re-ranking the second story above the first reorders the snapshot.
    await h.app.inject({
      method: 'POST',
      url: `/api/stories/${second.id}/move`,
      headers: {cookie},
      payload: {status: 'draft', afterId: first.id},
    });
    expect(getBoard(h.db, user.id).stories.map(s => s.title)).toEqual(['Second', 'First']);
  });

  it("never includes another user's stories, projects or agents", async () => {
    const {cookie: cookieA, user: userA, projectId: projectA} = await setup('a@example.com');
    h.db.insert(agents).values({id: 'agent-a', userId: userA.id, name: 'A', createdAt: Date.now()}).run();
    await createStory(cookieA, {projectId: projectA, title: "A's story"});

    const {user: userB} = await setup('b@example.com');
    const boardB = getBoard(h.db, userB.id);
    expect(boardB.stories).toEqual([]);
    expect(boardB.agents).toEqual([]);
    expect(boardB.projects.map(p => p.name)).toEqual(['project-b@example.com']);
  });

  it('serves the snapshot over GET /api/board for the session user only', async () => {
    const {cookie, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Served'});

    const res = await h.app.inject({method: 'GET', url: '/api/board', headers: {cookie}});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      columns: [...STATUSES],
      stories: [{id: story.id, title: 'Served', blockedBy: []}],
      agents: [],
    });

    expect((await h.app.inject({method: 'GET', url: '/api/board'})).statusCode).toBe(401);
  });
});
