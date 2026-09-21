import {describe, it, expect, beforeEach} from 'vitest';
import {eq} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import {createHarness} from '../testing/harness.js';
import {agents, oauthClients, oauthTokens} from '../db/schema.js';
import {authenticateBearer, issueTokens} from '../oauth/tokens.js';
import {moveStory} from '../services/stories.js';
import type {ServerEvent, Story, StoryUpdate} from '../../shared/types.js';

describe('agents', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });

  /**
   * Inserts an oauth client and an agent belonging to `userId`, mints it a real bearer
   * token pair with `issueTokens` and returns both — the same shape a completed OAuth
   * consent flow would leave behind, without re-driving the whole dance for every test.
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

  async function setupProjectAndStory(cookie: string) {
    const projectRes = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/agent-jira'},
    });
    expect(projectRes.statusCode).toBe(201);
    const projectId = projectRes.json().id as string;

    const storyRes = await h.app.inject({
      method: 'POST',
      url: '/api/stories',
      headers: {cookie},
      payload: {projectId, title: 'Do the thing'},
    });
    expect(storyRes.statusCode).toBe(201);
    return storyRes.json() as Story;
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

  async function getStory(cookie: string, id: string): Promise<Story> {
    const res = await h.app.inject({method: 'GET', url: `/api/stories/${id}`, headers: {cookie}});
    expect(res.statusCode).toBe(200);
    return res.json() as Story;
  }

  async function timeline(cookie: string, id: string): Promise<StoryUpdate[]> {
    const res = await h.app.inject({method: 'GET', url: `/api/stories/${id}/updates`, headers: {cookie}});
    expect(res.statusCode).toBe(200);
    return res.json() as StoryUpdate[];
  }

  it("lists only the caller's agents", async () => {
    const {cookie, user} = await h.register('a@example.com');
    const {user: userB} = await h.register('b@example.com');
    connectAgent(user.id, 'Mine');
    connectAgent(userB.id, 'Theirs');

    const res = await h.app.inject({method: 'GET', url: '/api/agents', headers: {cookie}});

    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{id: string; name: string; userId: string}>;
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Mine');
    expect(list[0]?.userId).toBe(user.id);
  });

  it('401s a request with no session', async () => {
    const res = await h.app.inject({method: 'GET', url: '/api/agents'});
    expect(res.statusCode).toBe(401);
  });

  it('toggles autonomous and publishes agent.updated', async () => {
    const {cookie, user} = await h.register();
    const {agentId} = connectAgent(user.id);
    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, e => events.push(e));

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: {cookie},
      payload: {autonomous: true},
    });
    unsubscribe();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({id: agentId, autonomous: true});
    expect(events).toEqual([{type: 'agent.updated', agent: expect.objectContaining({id: agentId, autonomous: true})}]);
  });

  it('renames an agent', async () => {
    const {cookie, user} = await h.register();
    const {agentId} = connectAgent(user.id, 'Old name');

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: {cookie},
      payload: {name: 'New name'},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({id: agentId, name: 'New name'});
  });

  it('refuses an empty patch', async () => {
    const {cookie, user} = await h.register();
    const {agentId} = connectAgent(user.id);

    const res = await h.app.inject({method: 'PATCH', url: `/api/agents/${agentId}`, headers: {cookie}, payload: {}});

    expect(res.statusCode).toBe(400);
  });

  it("404s patching another user's agent", async () => {
    const {user} = await h.register('a@example.com');
    const {cookie: cookieB} = await h.register('b@example.com');
    const {agentId} = connectAgent(user.id);

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}`,
      headers: {cookie: cookieB},
      payload: {autonomous: true},
    });

    expect(res.statusCode).toBe(404);
  });

  it('revoking an agent deletes its tokens and 401s its next mcp call', async () => {
    const {cookie, user} = await h.register();
    const {agentId, accessToken} = connectAgent(user.id);

    // Sanity check: the token is live before the revoke.
    expect(authenticateBearer(h.db, `Bearer ${accessToken}`)).toEqual({userId: user.id, agentId});

    const res = await h.app.inject({method: 'DELETE', url: `/api/agents/${agentId}`, headers: {cookie}});
    expect(res.statusCode).toBe(204);

    expect(h.db.select().from(oauthTokens).where(eq(oauthTokens.agentId, agentId)).all()).toHaveLength(0);
    expect(authenticateBearer(h.db, `Bearer ${accessToken}`)).toBeNull();

    const mcpRes = await h.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {authorization: `Bearer ${accessToken}`, 'content-type': 'application/json'},
      payload: {jsonrpc: '2.0', id: 1, method: 'tools/list'},
    });
    expect(mcpRes.statusCode).toBe(401);
  });

  it('revoking an agent deletes the agent row itself', async () => {
    const {cookie, user} = await h.register();
    const {agentId} = connectAgent(user.id);

    await h.app.inject({method: 'DELETE', url: `/api/agents/${agentId}`, headers: {cookie}});

    expect(h.db.select().from(agents).where(eq(agents.id, agentId)).get()).toBeUndefined();
    const list = await h.app.inject({method: 'GET', url: '/api/agents', headers: {cookie}});
    expect(list.json()).toEqual([]);
  });

  it('releases a claimed story when its agent is revoked', async () => {
    const {cookie, user} = await h.register();
    const {agentId} = connectAgent(user.id);
    const story = await setupProjectAndStory(cookie);
    await moveToTodo(cookie, story.id);
    moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'in_progress', actor: 'agent', agentId});

    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, e => events.push(e));

    const res = await h.app.inject({method: 'DELETE', url: `/api/agents/${agentId}`, headers: {cookie}});
    unsubscribe();
    expect(res.statusCode).toBe(204);

    const after = await getStory(cookie, story.id);
    expect(after.status).toBe('todo');
    expect(after.claimedByAgentId).toBeNull();
    expect(after.stopRequested).toBe(false);
    expect(after.playRequestedAt).toBeNull();

    const updates = await timeline(cookie, story.id);
    const releaseNote = updates.find(update => update.body === 'Agent revoked — story released');
    expect(releaseNote).toBeTruthy();
    expect(releaseNote?.authorType).toBe('system');

    expect(
      events.some(event => event.type === 'story.updated' && event.story.id === story.id && event.story.status === 'todo'),
    ).toBe(true);
    expect(events.some(event => event.type === 'agent.deleted' && event.id === agentId)).toBe(true);
  });

  it('revoking an agent holding no story publishes no story.updated event', async () => {
    const {cookie, user} = await h.register();
    const {agentId} = connectAgent(user.id);
    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, e => events.push(e));

    await h.app.inject({method: 'DELETE', url: `/api/agents/${agentId}`, headers: {cookie}});
    unsubscribe();

    expect(events.some(event => event.type === 'story.updated')).toBe(false);
    expect(events).toEqual([{type: 'agent.deleted', id: agentId}]);
  });

  it("404s revoking another user's agent, and leaves it connected", async () => {
    const {user} = await h.register('a@example.com');
    const {cookie: cookieB} = await h.register('b@example.com');
    const {agentId, accessToken} = connectAgent(user.id);

    const res = await h.app.inject({method: 'DELETE', url: `/api/agents/${agentId}`, headers: {cookie: cookieB}});

    expect(res.statusCode).toBe(404);
    expect(authenticateBearer(h.db, `Bearer ${accessToken}`)).not.toBeNull();
  });

  it('404s revoking an unknown agent id', async () => {
    const {cookie} = await h.register();
    const res = await h.app.inject({method: 'DELETE', url: '/api/agents/does-not-exist', headers: {cookie}});
    expect(res.statusCode).toBe(404);
  });
});
