import {describe, it, expect, beforeEach} from 'vitest';
import {eq, or} from 'drizzle-orm';
import {createHarness} from '../testing/harness.js';
import {agents, storyDependencies, storyUpdates} from '../db/schema.js';
import {moveStory, postProgress, TransitionError} from '../services/stories.js';
import {NotFoundError} from '../services/projects.js';
import {DEFAULT_MODEL_ID} from '../../shared/models.js';
import type {ServerEvent, Story, StoryUpdate} from '../../shared/types.js';

describe('stories', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    h = await createHarness();
  });

  /** Registers a user and gives them one project — the minimum context a story needs. */
  async function setup(email = 'a@example.com') {
    const {cookie, user} = await h.register(email);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: {cookie},
      payload: {name: 'agent-jira', path: `/Users/dev/${email}`},
    });
    return {cookie, user, projectId: res.json().id as string};
  }

  async function post(cookie: string, url: string, payload?: unknown) {
    return h.app.inject({method: 'POST', url, headers: {cookie}, payload: payload as never});
  }

  async function createStory(cookie: string, payload: Record<string, unknown>) {
    const res = await post(cookie, '/api/stories', payload);
    expect(res.statusCode).toBe(201);
    return res.json() as Story;
  }

  async function getStory(cookie: string, id: string) {
    const res = await h.app.inject({method: 'GET', url: `/api/stories/${id}`, headers: {cookie}});
    expect(res.statusCode).toBe(200);
    return res.json() as Story;
  }

  async function move(cookie: string, id: string, payload: Record<string, unknown>) {
    return post(cookie, `/api/stories/${id}/move`, payload);
  }

  async function timeline(cookie: string, id: string) {
    const res = await h.app.inject({method: 'GET', url: `/api/stories/${id}/updates`, headers: {cookie}});
    expect(res.statusCode).toBe(200);
    return res.json() as StoryUpdate[];
  }

  function addAgent(userId: string, id: string) {
    h.db.insert(agents).values({id, userId, name: id, createdAt: Date.now()}).run();
    return id;
  }

  it('creates into draft with the default model and a rank', async () => {
    const {cookie, projectId} = await setup();

    const story = await createStory(cookie, {projectId, title: 'Wire up the board'});

    expect(story).toMatchObject({
      projectId,
      title: 'Wire up the board',
      description: '',
      status: 'draft',
      model: DEFAULT_MODEL_ID,
      progressPct: 0,
      progressLabel: '',
      claimedByAgentId: null,
      stopRequested: false,
      playRequestedAt: null,
      blockedBy: [],
    });
    expect(story.id).toBeTruthy();
    expect(typeof story.rank).toBe('string');
    expect(story.rank.length).toBeGreaterThan(0);
  });

  it("rejects a story for another user's project", async () => {
    const {projectId: projectA} = await setup('a@example.com');
    const {cookie: cookieB} = await setup('b@example.com');

    const res = await post(cookieB, '/api/stories', {projectId: projectA, title: 'Sneaky'});
    expect(res.statusCode).toBe(404);

    // Nothing was written under B either — the refusal is a refusal, not a silent re-home.
    const board = await h.app.inject({method: 'GET', url: '/api/board', headers: {cookie: cookieB}});
    expect(board.json().stories).toHaveLength(0);
  });

  it('rejects an unknown model id', async () => {
    const {cookie, projectId} = await setup();

    const res = await post(cookie, '/api/stories', {projectId, title: 'Hello', model: 'gpt-9000'});
    expect(res.statusCode).toBe(400);

    const board = await h.app.inject({method: 'GET', url: '/api/board', headers: {cookie}});
    expect(board.json().stories).toHaveLength(0);
  });

  it('stores dependencies and exposes blockedBy', async () => {
    const {cookie, projectId} = await setup();
    const s1 = await createStory(cookie, {projectId, title: 'First'});
    expect((await move(cookie, s1.id, {status: 'todo'})).statusCode).toBe(200);

    const s2 = await createStory(cookie, {projectId, title: 'Second', dependsOn: [s1.id]});
    expect(s2.blockedBy).toEqual([s1.id]);
    expect((await getStory(cookie, s2.id)).blockedBy).toEqual([s1.id]);

    // A dependency in `finished` no longer blocks.
    await move(cookie, s1.id, {status: 'in_progress'});
    await move(cookie, s1.id, {status: 'in_test'});
    await move(cookie, s1.id, {status: 'finished'});
    expect((await getStory(cookie, s2.id)).blockedBy).toEqual([]);
  });

  it("rejects a dependency on another user's story", async () => {
    const {cookie: cookieA, projectId: projectA} = await setup('a@example.com');
    const secret = await createStory(cookieA, {projectId: projectA, title: "A's story"});

    const {cookie: cookieB, projectId: projectB} = await setup('b@example.com');
    const res = await post(cookieB, '/api/stories', {projectId: projectB, title: 'Mine', dependsOn: [secret.id]});
    expect(res.statusCode).toBe(400);
  });

  it('rejects a dependency cycle', async () => {
    const {cookie, projectId} = await setup();
    const s1 = await createStory(cookie, {projectId, title: 'First'});
    const s2 = await createStory(cookie, {projectId, title: 'Second', dependsOn: [s1.id]});

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/stories/${s1.id}`,
      headers: {cookie},
      payload: {dependsOn: [s2.id]},
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json().message)).toMatch(/cycle/i);

    // The rejected edge was not written.
    expect((await getStory(cookie, s1.id)).blockedBy).toEqual([]);
    expect((await getStory(cookie, s2.id)).blockedBy).toEqual([s1.id]);
  });

  it('moves draft -> todo and back', async () => {
    const {cookie, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Round trip'});

    const toTodo = await move(cookie, story.id, {status: 'todo'});
    expect(toTodo.statusCode).toBe(200);
    expect(toTodo.json().status).toBe('todo');

    const back = await move(cookie, story.id, {status: 'draft'});
    expect(back.statusCode).toBe(200);
    expect(back.json().status).toBe('draft');
    expect((await getStory(cookie, story.id)).status).toBe('draft');
  });

  it('409s when an agent tries to accept', async () => {
    const {cookie, user, projectId} = await setup();
    const agentId = addAgent(user.id, 'agent-1');
    const story = await createStory(cookie, {projectId, title: 'Agent work'});
    await move(cookie, story.id, {status: 'todo'});

    // The agent claims and drives the story all the way to `finished` itself.
    const base = {userId: user.id, storyId: story.id, actor: 'agent' as const, agentId};
    const claimed = moveStory(h.db, h.app.hub, {...base, status: 'in_progress'});
    expect(claimed.claimedByAgentId).toBe(agentId);
    moveStory(h.db, h.app.hub, {...base, status: 'in_test'});
    moveStory(h.db, h.app.hub, {...base, status: 'finished'});

    expect(() => moveStory(h.db, h.app.hub, {...base, status: 'accepted'})).toThrow(TransitionError);
    expect(() => moveStory(h.db, h.app.hub, {...base, status: 'accepted'})).toThrow(/accept/i);
    expect((await getStory(cookie, story.id)).status).toBe('finished');

    // The same move by a human is allowed — the refusal is about the actor, not the story.
    const accepted = await move(cookie, story.id, {status: 'accepted'});
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe('accepted');
  });

  it('clears the claim when the story leaves the agent’s hands', async () => {
    const {cookie, user, projectId} = await setup();
    const agentId = addAgent(user.id, 'agent-1');
    const story = await createStory(cookie, {projectId, title: 'Agent work'});
    await move(cookie, story.id, {status: 'todo'});

    const base = {userId: user.id, storyId: story.id, actor: 'agent' as const, agentId};
    expect(moveStory(h.db, h.app.hub, {...base, status: 'in_progress'}).claimedByAgentId).toBe(agentId);
    expect(moveStory(h.db, h.app.hub, {...base, status: 'in_test'}).claimedByAgentId).toBe(agentId);

    // Handing the work over ends the agent's hold on it: a story in `finished` (or
    // `accepted` after it) is the human's, and an agent must not still be holding a claim
    // on work it has given back.
    const finished = moveStory(h.db, h.app.hub, {...base, status: 'finished'});
    expect(finished.claimedByAgentId).toBeNull();
    expect((await getStory(cookie, story.id)).claimedByAgentId).toBeNull();

    // It can still take its own work back for a fix — that re-takes the claim.
    expect(moveStory(h.db, h.app.hub, {...base, status: 'in_progress'}).claimedByAgentId).toBe(agentId);
  });

  it('drops the agent’s presence when a human takes a story out of its hands', async () => {
    const {cookie, user, projectId} = await setup();
    const agentId = addAgent(user.id, 'agent-1');
    const story = await createStory(cookie, {projectId, title: 'Agent work'});
    await move(cookie, story.id, {status: 'todo'});
    moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'in_progress', actor: 'agent', agentId});
    h.db.update(agents).set({currentStoryId: story.id, status: 'working'}).where(eq(agents.id, agentId)).run();

    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, event => events.push(event));
    expect((await move(cookie, story.id, {status: 'todo'})).statusCode).toBe(200);
    unsubscribe();

    const agent = h.db.select().from(agents).where(eq(agents.id, agentId)).get()!;
    expect(agent.currentStoryId).toBeNull();
    expect(agent.status).toBe('idle');
    expect(
      events.some(
        event => event.type === 'agent.updated' && event.agent.id === agentId && event.agent.currentStoryId === null,
      ),
    ).toBe(true);
  });

  it("refuses to let an agent move another agent's story", async () => {
    const {cookie, user, projectId} = await setup();
    const mine = addAgent(user.id, 'agent-1');
    const other = addAgent(user.id, 'agent-2');
    const story = await createStory(cookie, {projectId, title: 'Claimed'});
    await move(cookie, story.id, {status: 'todo'});
    moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'in_progress', actor: 'agent', agentId: mine});

    expect(() =>
      moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'in_test', actor: 'agent', agentId: other}),
    ).toThrow(TransitionError);
    // A second agent cannot steal an already-claimed story either.
    expect(() =>
      moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'in_progress', actor: 'agent', agentId: other}),
    ).toThrow(TransitionError);

    const after = await getStory(cookie, story.id);
    expect(after.status).toBe('in_progress');
    expect(after.claimedByAgentId).toBe(mine);
  });

  it('reorders within a column using beforeId/afterId', async () => {
    const {cookie, projectId} = await setup();
    const s1 = await createStory(cookie, {projectId, title: 'One'});
    const s2 = await createStory(cookie, {projectId, title: 'Two'});
    const s3 = await createStory(cookie, {projectId, title: 'Three'});
    expect([s1.rank < s2.rank, s2.rank < s3.rank]).toEqual([true, true]);

    const res = await move(cookie, s3.id, {status: 'draft', beforeId: s1.id, afterId: s2.id});
    expect(res.statusCode).toBe(200);
    const moved = res.json() as Story;
    expect(moved.rank > s1.rank).toBe(true);
    expect(moved.rank < s2.rank).toBe(true);

    const board = await h.app.inject({method: 'GET', url: '/api/board', headers: {cookie}});
    const order = (board.json().stories as Story[])
      .filter(s => s.status === 'draft')
      .sort((a, b) => (a.rank < b.rank ? -1 : 1))
      .map(s => s.title);
    expect(order).toEqual(['One', 'Three', 'Two']);

    // A reorder is not a status change, so it leaves no "moved from draft to draft" behind.
    expect(await timeline(cookie, s3.id)).toEqual([]);
  });

  it('clears stop_requested and the claim when released to todo', async () => {
    const {cookie, user, projectId} = await setup();
    const agentId = addAgent(user.id, 'agent-1');
    const story = await createStory(cookie, {projectId, title: 'Released'});
    await move(cookie, story.id, {status: 'todo'});
    await post(cookie, `/api/stories/${story.id}/play`);
    moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'in_progress', actor: 'agent', agentId});
    await post(cookie, `/api/stories/${story.id}/progress`, {progressPct: 60, label: 'Two thirds there'});
    await post(cookie, `/api/stories/${story.id}/stop`);

    const beforeRelease = await getStory(cookie, story.id);
    expect(beforeRelease).toMatchObject({claimedByAgentId: agentId, stopRequested: true, progressPct: 60});
    expect(beforeRelease.playRequestedAt).not.toBeNull();

    const released = moveStory(h.db, h.app.hub, {
      userId: user.id,
      storyId: story.id,
      status: 'todo',
      actor: 'agent',
      agentId,
    });
    expect(released).toMatchObject({
      status: 'todo',
      claimedByAgentId: null,
      stopRequested: false,
      playRequestedAt: null,
      // An ordinary release keeps the work done so far visible.
      progressPct: 60,
    });

    // Rework from `finished` is different: the progress bar starts over.
    await move(cookie, story.id, {status: 'in_progress'});
    await move(cookie, story.id, {status: 'in_test'});
    await move(cookie, story.id, {status: 'finished'});
    const reworked = await move(cookie, story.id, {status: 'todo'});
    expect(reworked.json()).toMatchObject({status: 'todo', progressPct: 0, progressLabel: ''});
  });

  it('records a status_change update on every move', async () => {
    const {cookie, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Tracked'});
    await move(cookie, story.id, {status: 'todo'});
    await move(cookie, story.id, {status: 'in_progress'});

    const updates = await timeline(cookie, story.id);
    const statusChanges = updates.filter(u => u.kind === 'status_change');
    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[0]).toMatchObject({authorType: 'user', kind: 'status_change'});
    expect(statusChanges[0]!.body).toContain('todo');
    expect(statusChanges[1]!.body).toContain('in_progress');
  });

  it('publishes story.moved on the hub', async () => {
    const {cookie, user, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Broadcast'});

    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, e => events.push(e));
    await move(cookie, story.id, {status: 'todo'});
    unsubscribe();

    const moved = events.find(e => e.type === 'story.moved');
    expect(moved).toBeDefined();
    expect(moved).toMatchObject({type: 'story.moved', story: {id: story.id, status: 'todo'}});
  });

  it('publishes story.created and story.deleted on the hub', async () => {
    const {cookie, user, projectId} = await setup();
    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, e => events.push(e));

    const story = await createStory(cookie, {projectId, title: 'Short lived'});
    await h.app.inject({method: 'DELETE', url: `/api/stories/${story.id}`, headers: {cookie}});
    unsubscribe();

    expect(events.find(e => e.type === 'story.created')).toMatchObject({story: {id: story.id}});
    expect(events).toContainEqual({type: 'story.deleted', id: story.id});
  });

  // The task list called this "clamps progress to 0..100", but its own body asks for 400s:
  // out-of-range progress is refused, never silently rewritten. The name says what it does.
  it('refuses progress outside 0..100 and publishes story.progress', async () => {
    const {cookie, user, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Progressing'});

    expect((await post(cookie, `/api/stories/${story.id}/progress`, {progressPct: -5})).statusCode).toBe(400);
    expect((await post(cookie, `/api/stories/${story.id}/progress`, {progressPct: 150})).statusCode).toBe(400);
    // Out of range is refused outright, not silently clamped.
    expect((await getStory(cookie, story.id)).progressPct).toBe(0);

    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, e => events.push(e));
    const ok = await post(cookie, `/api/stories/${story.id}/progress`, {progressPct: 50, label: 'Half way'});
    unsubscribe();

    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({progressPct: 50, progressLabel: 'Half way'});
    expect(events).toContainEqual({
      type: 'story.progress',
      id: story.id,
      progressPct: 50,
      progressLabel: 'Half way',
    });
    const progressUpdates = (await timeline(cookie, story.id)).filter(u => u.kind === 'progress');
    expect(progressUpdates).toHaveLength(1);
    expect(progressUpdates[0]).toMatchObject({progressPct: 50, body: 'Half way'});
  });

  it('appends a human remark and returns it in the timeline', async () => {
    const {cookie, user, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Remarked'});

    const events: ServerEvent[] = [];
    const unsubscribe = h.app.hub.subscribe(user.id, e => events.push(e));
    const res = await post(cookie, `/api/stories/${story.id}/updates`, {body: 'Use the shared rank helper'});
    unsubscribe();

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      storyId: story.id,
      kind: 'remark',
      authorType: 'user',
      authorId: user.id,
      body: 'Use the shared rank helper',
      progressPct: null,
    });

    const updates = await timeline(cookie, story.id);
    expect(updates.map(u => u.body)).toContain('Use the shared rank helper');

    // Several remarks inside one millisecond still come back in the order they were made
    // — `created_at` alone cannot order them.
    for (const body of ['first', 'second', 'third', 'fourth']) {
      expect((await post(cookie, `/api/stories/${story.id}/updates`, {body})).statusCode).toBe(201);
    }
    expect((await timeline(cookie, story.id)).map(u => u.body)).toEqual([
      'Use the shared rank helper',
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(events).toContainEqual({type: 'story.update', storyId: story.id, update: res.json()});

    // An empty remark is not a remark.
    expect((await post(cookie, `/api/stories/${story.id}/updates`, {body: '   '})).statusCode).toBe(400);
  });

  it('sets playRequestedAt on play and stopRequested on stop', async () => {
    const {cookie, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Playable'});
    await move(cookie, story.id, {status: 'todo'});

    const played = await post(cookie, `/api/stories/${story.id}/play`);
    expect(played.statusCode).toBe(200);
    expect(played.json().playRequestedAt).toBeGreaterThan(0);
    expect(played.json().stopRequested).toBe(false);

    const stopped = await post(cookie, `/api/stories/${story.id}/stop`);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().stopRequested).toBe(true);

    // Playing again lifts a pending stop request.
    const replayed = await post(cookie, `/api/stories/${story.id}/play`);
    expect(replayed.json()).toMatchObject({stopRequested: false});
    expect((await getStory(cookie, story.id)).stopRequested).toBe(false);
  });

  it('deletes a story along with its updates and dependencies', async () => {
    const {cookie, projectId} = await setup();
    const s1 = await createStory(cookie, {projectId, title: 'Doomed'});
    const s2 = await createStory(cookie, {projectId, title: 'Dependent', dependsOn: [s1.id]});
    await post(cookie, `/api/stories/${s1.id}/updates`, {body: 'a remark'});
    await move(cookie, s1.id, {status: 'todo'});
    expect(await timeline(cookie, s1.id)).not.toHaveLength(0);

    const res = await h.app.inject({method: 'DELETE', url: `/api/stories/${s1.id}`, headers: {cookie}});
    expect(res.statusCode).toBe(204);

    expect((await h.app.inject({method: 'GET', url: `/api/stories/${s1.id}`, headers: {cookie}})).statusCode).toBe(404);
    expect(h.db.select().from(storyUpdates).where(eq(storyUpdates.storyId, s1.id)).all()).toEqual([]);
    expect(
      h.db
        .select()
        .from(storyDependencies)
        .where(or(eq(storyDependencies.storyId, s1.id), eq(storyDependencies.dependsOnStoryId, s1.id)))
        .all(),
    ).toEqual([]);

    // The dependent story survives, no longer blocked by a story that no longer exists.
    expect((await getStory(cookie, s2.id)).blockedBy).toEqual([]);
  });

  it("never leaks another user's story through any endpoint", async () => {
    const {cookie: cookieA, projectId} = await setup('a@example.com');
    const story = await createStory(cookieA, {projectId, title: "A's story"});
    const {cookie: cookieB} = await setup('b@example.com');

    const attempts: Array<{method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown}> = [
      {method: 'GET', url: `/api/stories/${story.id}`},
      {method: 'PATCH', url: `/api/stories/${story.id}`, payload: {title: 'hijacked'}},
      {method: 'POST', url: `/api/stories/${story.id}/move`, payload: {status: 'todo'}},
      {method: 'POST', url: `/api/stories/${story.id}/play`},
      {method: 'POST', url: `/api/stories/${story.id}/stop`},
      {method: 'POST', url: `/api/stories/${story.id}/progress`, payload: {progressPct: 10}},
      {method: 'GET', url: `/api/stories/${story.id}/updates`},
      {method: 'POST', url: `/api/stories/${story.id}/updates`, payload: {body: 'not yours'}},
      {method: 'DELETE', url: `/api/stories/${story.id}`},
    ];

    for (const attempt of attempts) {
      const res = await h.app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: {cookie: cookieB},
        payload: attempt.payload as never,
      });
      expect(`${attempt.method} ${attempt.url} => ${res.statusCode}`).toBe(`${attempt.method} ${attempt.url} => 404`);
    }

    // A's story is exactly as it was, and B's board never saw it.
    expect(await getStory(cookieA, story.id)).toMatchObject({title: "A's story", status: 'draft'});
    expect(await timeline(cookieA, story.id)).toEqual([]);
    const boardB = await h.app.inject({method: 'GET', url: '/api/board', headers: {cookie: cookieB}});
    expect(boardB.json().stories).toEqual([]);
  });

  it('keeps a pending play when a todo story is only reordered', async () => {
    const {cookie, projectId} = await setup();
    const queued = await createStory(cookie, {projectId, title: 'Queued'});
    const other = await createStory(cookie, {projectId, title: 'Other'});
    await move(cookie, queued.id, {status: 'todo'});
    await move(cookie, other.id, {status: 'todo'});

    const played = await post(cookie, `/api/stories/${queued.id}/play`);
    const playRequestedAt = played.json().playRequestedAt as number;
    expect(playRequestedAt).toBeGreaterThan(0);
    await post(cookie, `/api/stories/${queued.id}/stop`);

    // Dragging a queued card up its own column must not silently un-queue it.
    const reordered = await move(cookie, queued.id, {status: 'todo', afterId: other.id});
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json()).toMatchObject({status: 'todo', playRequestedAt, stopRequested: true});
    expect(reordered.json().rank < other.rank).toBe(true);

    // Arriving in todo from another column still releases the story.
    await move(cookie, queued.id, {status: 'in_progress'});
    const released = await move(cookie, queued.id, {status: 'todo'});
    expect(released.json()).toMatchObject({playRequestedAt: null, stopRequested: false});
  });

  it('refuses to let an agent claim a blocked story, but lets a human move it', async () => {
    const {cookie, user, projectId} = await setup();
    const agentId = addAgent(user.id, 'agent-1');
    const blocker = await createStory(cookie, {projectId, title: 'Blocker'});
    const blocked = await createStory(cookie, {projectId, title: 'Blocked', dependsOn: [blocker.id]});
    await move(cookie, blocked.id, {status: 'todo'});
    expect((await getStory(cookie, blocked.id)).blockedBy).toEqual([blocker.id]);

    const claim = {userId: user.id, storyId: blocked.id, status: 'in_progress' as const, actor: 'agent' as const, agentId};
    expect(() => moveStory(h.db, h.app.hub, claim)).toThrow(TransitionError);
    expect(() => moveStory(h.db, h.app.hub, claim)).toThrow(new RegExp(blocker.id));
    expect(await getStory(cookie, blocked.id)).toMatchObject({status: 'todo', claimedByAgentId: null});

    // A human may deliberately override the block.
    const forced = await move(cookie, blocked.id, {status: 'in_progress'});
    expect(forced.statusCode).toBe(200);

    // Once the blocker is finished the agent can claim the story itself.
    await move(cookie, blocked.id, {status: 'todo'});
    await move(cookie, blocker.id, {status: 'todo'});
    await move(cookie, blocker.id, {status: 'in_progress'});
    await move(cookie, blocker.id, {status: 'in_test'});
    await move(cookie, blocker.id, {status: 'finished'});
    expect(moveStory(h.db, h.app.hub, claim).claimedByAgentId).toBe(agentId);
  });

  it("refuses an agent identity that belongs to another user", async () => {
    const {cookie, user, projectId} = await setup('a@example.com');
    const {user: userB} = await setup('b@example.com');
    const foreignAgent = addAgent(userB.id, 'agent-b');
    const story = await createStory(cookie, {projectId, title: 'Mine'});
    await move(cookie, story.id, {status: 'todo'});

    expect(() =>
      moveStory(h.db, h.app.hub, {
        userId: user.id,
        storyId: story.id,
        status: 'in_progress',
        actor: 'agent',
        agentId: foreignAgent,
      }),
    ).toThrow(NotFoundError);
    expect(await getStory(cookie, story.id)).toMatchObject({status: 'todo', claimedByAgentId: null});

    // The same check guards progress reporting.
    const mine = addAgent(user.id, 'agent-a');
    moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'in_progress', actor: 'agent', agentId: mine});
    expect(() =>
      postProgress(h.db, h.app.hub, {userId: user.id, storyId: story.id, progressPct: 10, agentId: foreignAgent}),
    ).toThrow(NotFoundError);
    expect((await getStory(cookie, story.id)).progressPct).toBe(0);
  });

  it('places the card at the end of the column when a drag neighbour has moved on', async () => {
    const {cookie, projectId} = await setup();
    const first = await createStory(cookie, {projectId, title: 'First'});
    const second = await createStory(cookie, {projectId, title: 'Second'});
    const dragged = await createStory(cookie, {projectId, title: 'Dragged'});
    // Another client moves `first` out of draft between the drag starting and landing.
    await move(cookie, first.id, {status: 'todo'});

    const res = await move(cookie, dragged.id, {status: 'draft', beforeId: first.id, afterId: second.id});
    expect(res.statusCode).toBe(200);
    // `first` is stale, so only `second` constrains the drop.
    expect(res.json().rank < second.rank).toBe(true);

    const bothStale = await move(cookie, second.id, {status: 'draft', beforeId: first.id, afterId: first.id});
    expect(bothStale.statusCode).toBe(200);
    expect(bothStale.json().rank > res.json().rank).toBe(true);
  });

  it('404s on a drag neighbour that does not exist or is another user\'s', async () => {
    const {cookie: cookieA, projectId: projectA} = await setup('a@example.com');
    const foreign = await createStory(cookieA, {projectId: projectA, title: "A's card"});
    const {cookie, projectId} = await setup('b@example.com');
    const story = await createStory(cookie, {projectId, title: 'Mine'});

    expect((await move(cookie, story.id, {status: 'draft', beforeId: 'no-such-story'})).statusCode).toBe(404);
    expect((await move(cookie, story.id, {status: 'draft', afterId: foreign.id})).statusCode).toBe(404);
    expect((await getStory(cookie, story.id)).rank).toBe(story.rank);
  });

  it('keeps the current progress label when a caller reports a bare percentage', async () => {
    const {cookie, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Labelled'});

    await post(cookie, `/api/stories/${story.id}/progress`, {progressPct: 25, label: 'Writing the tests'});
    const bare = await post(cookie, `/api/stories/${story.id}/progress`, {progressPct: 40});
    expect(bare.statusCode).toBe(200);
    expect(bare.json()).toMatchObject({progressPct: 40, progressLabel: 'Writing the tests'});

    // An explicit empty label still clears it.
    const cleared = await post(cookie, `/api/stories/${story.id}/progress`, {progressPct: 45, label: ''});
    expect(cleared.json()).toMatchObject({progressPct: 45, progressLabel: ''});
  });

  it('409s with a reason when the move is not allowed', async () => {
    const {cookie, projectId} = await setup();
    const story = await createStory(cookie, {projectId, title: 'Impatient'});

    const res = await move(cookie, story.id, {status: 'finished'});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({error: 'transition_refused'});
    expect(String(res.json().message)).toMatch(/draft.*finished/i);
    expect((await getStory(cookie, story.id)).status).toBe('draft');
    expect(await timeline(cookie, story.id)).toEqual([]);
  });

  it('all story routes require auth', async () => {
    const unauthenticated = [
      {method: 'GET' as const, url: '/api/stories/whatever'},
      {method: 'POST' as const, url: '/api/stories', payload: {projectId: 'x', title: 'y'}},
      {method: 'PATCH' as const, url: '/api/stories/whatever', payload: {title: 'y'}},
      {method: 'POST' as const, url: '/api/stories/whatever/move', payload: {status: 'todo'}},
      {method: 'POST' as const, url: '/api/stories/whatever/play'},
      {method: 'POST' as const, url: '/api/stories/whatever/stop'},
      {method: 'POST' as const, url: '/api/stories/whatever/progress', payload: {progressPct: 1}},
      {method: 'GET' as const, url: '/api/stories/whatever/updates'},
      {method: 'POST' as const, url: '/api/stories/whatever/updates', payload: {body: 'x'}},
      {method: 'DELETE' as const, url: '/api/stories/whatever'},
    ];

    for (const attempt of unauthenticated) {
      const res = await h.app.inject({method: attempt.method, url: attempt.url, payload: attempt.payload as never});
      expect(`${attempt.method} ${attempt.url} => ${res.statusCode}`).toBe(`${attempt.method} ${attempt.url} => 401`);
    }
  });
});
