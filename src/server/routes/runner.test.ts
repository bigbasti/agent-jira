import {describe, it, expect, beforeEach} from 'vitest';
import {eq} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import {createHarness} from '../testing/harness.js';
import {agents, oauthClients, stories} from '../db/schema.js';
import {issueTokens} from '../oauth/tokens.js';
import {requestPlay} from '../services/stories.js';
import type {Story} from '../../shared/types.js';

describe('GET /api/runner/queued', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });

  /**
   * Inserts an oauth client and an agent belonging to `userId`, mints it a real bearer
   * token pair with `issueTokens` and returns the access token — the same shape a
   * completed OAuth consent flow would leave behind, without re-driving the whole dance
   * for every test.
   */
  function connectAgent(userId: string, name = 'Night shift') {
    const clientRowId = nanoid();
    h.db
      .insert(oauthClients)
      .values({
        id: clientRowId,
        userId: null,
        clientId: nanoid(24),
        clientSecretHash: null,
        redirectUris: JSON.stringify(['http://127.0.0.1:1/callback']),
        name: 'Test client',
        createdAt: Date.now(),
      })
      .run();

    const agentId = nanoid();
    h.db
      .insert(agents)
      .values({id: agentId, userId, name, autonomous: false, status: 'idle', currentStoryId: null, lastSeenAt: null, createdAt: Date.now()})
      .run();

    const {accessToken} = issueTokens(h.db, {clientId: clientRowId, userId, agentId});
    return {agentId, accessToken};
  }

  async function createProject(cookie: string, path = '/Users/dev/agent-kanban') {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-kanban', path},
    });
    expect(res.statusCode).toBe(201);
    return res.json() as {id: string; path: string};
  }

  async function createStory(cookie: string, projectId: string, title: string, dependsOn?: string[]) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: {cookie},
      payload: {projectId, title, dependsOn},
    });
    expect(res.statusCode).toBe(201);
    return res.json() as Story;
  }

  async function moveToTodo(cookie: string, storyId: string) {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/stories/${storyId}/move`,
      headers: {cookie},
      payload: {status: 'todo'},
    });
    expect(res.statusCode).toBe(200);
  }

  /** Plays a story and pins `playRequestedAt` to an exact value, so ordering tests aren't at the mercy of clock resolution. */
  function play(userId: string, storyId: string, at: number) {
    requestPlay(h.db, h.app.hub, userId, storyId);
    h.db.update(stories).set({playRequestedAt: at}).where(eq(stories.id, storyId)).run();
  }

  it('401s without a bearer token', async () => {
    const res = await h.app.inject({method: 'GET', url: '/api/runner/queued'});
    expect(res.statusCode).toBe(401);
  });

  it('401s with a garbage bearer token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/runner/queued',
      headers: {authorization: 'Bearer not-a-real-token'},
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns null when nothing is queued', async () => {
    const {cookie, user} = await h.register();
    const {accessToken} = connectAgent(user.id);
    const project = await createProject(cookie);
    const story = await createStory(cookie, project.id, 'Do the thing');
    await moveToTodo(cookie, story.id);
    // Not played — sitting in todo unplayed should not be picked up.

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/runner/queued',
      headers: {authorization: `Bearer ${accessToken}`},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({story: null});
  });

  it('returns the oldest played story with its project path', async () => {
    const {cookie, user} = await h.register();
    const {accessToken} = connectAgent(user.id);
    const project = await createProject(cookie, '/Users/dev/oldest-project');
    const newer = await createStory(cookie, project.id, 'Newer story');
    const older = await createStory(cookie, project.id, 'Older story');
    await moveToTodo(cookie, newer.id);
    await moveToTodo(cookie, older.id);
    play(user.id, newer.id, 2000);
    play(user.id, older.id, 1000);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/runner/queued',
      headers: {authorization: `Bearer ${accessToken}`},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      story: {id: older.id, title: 'Older story', projectPath: '/Users/dev/oldest-project'},
    });
  });

  it('skips blocked and already-claimed stories', async () => {
    const {cookie, user} = await h.register();
    const {accessToken} = connectAgent(user.id);
    const project = await createProject(cookie);

    // Blocker stays in `todo`, never accepted — so anything depending on it is blocked.
    const blocker = await createStory(cookie, project.id, 'Blocker');
    await moveToTodo(cookie, blocker.id);

    const blocked = await createStory(cookie, project.id, 'Blocked story', [blocker.id]);
    await moveToTodo(cookie, blocked.id);
    play(user.id, blocked.id, 1000);

    const claimed = await createStory(cookie, project.id, 'Already claimed');
    await moveToTodo(cookie, claimed.id);
    play(user.id, claimed.id, 1500);
    // Simulate a story that is claimed while still sitting in `todo` — belt and suspenders
    // against the endpoint ever handing out a story someone is already working on.
    const {agentId: otherAgentId} = connectAgent(user.id, 'Other agent');
    h.db.update(stories).set({claimedByAgentId: otherAgentId}).where(eq(stories.id, claimed.id)).run();

    const available = await createStory(cookie, project.id, 'Available story');
    await moveToTodo(cookie, available.id);
    play(user.id, available.id, 2000);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/runner/queued',
      headers: {authorization: `Bearer ${accessToken}`},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({story: {id: available.id, title: 'Available story'}});
  });

  it("never returns another user's story", async () => {
    const {cookie: cookieA, user: userA} = await h.register('a@example.com');
    const {user: userB} = await h.register('b@example.com');
    const {accessToken: tokenB} = connectAgent(userB.id);

    const projectA = await createProject(cookieA);
    const storyA = await createStory(cookieA, projectA.id, "A's story");
    await moveToTodo(cookieA, storyA.id);
    play(userA.id, storyA.id, 1000);

    const res = await h.app.inject({
      method: 'GET',
      url: '/api/runner/queued',
      headers: {authorization: `Bearer ${tokenB}`},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({story: null});

    // sanity: userA's story really is queued — it's the cross-user filter that hides it.
    const {accessToken: tokenA} = connectAgent(userA.id, 'Owner agent');
    const asOwner = await h.app.inject({
      method: 'GET',
      url: '/api/runner/queued',
      headers: {authorization: `Bearer ${tokenA}`},
    });
    expect(asOwner.json()).toMatchObject({story: {id: storyA.id}});
  });
});
