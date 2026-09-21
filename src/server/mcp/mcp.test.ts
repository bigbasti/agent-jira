import {describe, it, expect, beforeEach, onTestFinished} from 'vitest';
import {eq} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHarness} from '../testing/harness.js';
import {agents, oauthClients, stories, storyUpdates} from '../db/schema.js';
import {issueTokens} from '../oauth/tokens.js';
import {createProject} from '../services/projects.js';
import {addUpdate, createStory, moveStory, requestPlay} from '../services/stories.js';
import {clampTimeoutSeconds} from './tools.js';
import {controlBlock} from './control.js';
import type {Project, ServerEvent, Story, StoryUpdate} from '../../shared/types.js';

interface Control {
  stop_requested: boolean;
  autonomous: boolean;
  remarks: string[];
}

type WithControl<T> = T & {control: Control};

describe('mcp server', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let baseUrl: string;

  beforeEach(async () => {
    h = await createHarness();
    baseUrl = await h.app.listen({host: '127.0.0.1', port: 0});
  });

  /** A registered user with one project — the minimum context a story needs. */
  async function seedUser(email = 'dev@example.com') {
    const {cookie, user} = await h.register(email);
    const project = createProject(h.db, h.app.hub, user.id, {name: 'agent-jira', path: `/Users/dev/${user.id}`});
    return {cookie, user, project};
  }

  /** An `oauth_clients` row, standing in for the Claude Code registration. */
  function seedOauthClient(userId: string): string {
    const id = nanoid();
    h.db
      .insert(oauthClients)
      .values({
        id,
        userId,
        clientId: nanoid(),
        clientSecretHash: null,
        redirectUris: JSON.stringify(['http://127.0.0.1:41234/callback']),
        name: 'Claude Code',
        createdAt: Date.now(),
      })
      .run();
    return id;
  }

  /** An agent plus a live access token for it — what the OAuth flow hands a client. */
  function seedAgent(userId: string, opts: {name?: string; autonomous?: boolean} = {}) {
    const agentId = nanoid();
    h.db
      .insert(agents)
      .values({
        id: agentId,
        userId,
        name: opts.name ?? 'Claude Code',
        autonomous: opts.autonomous ?? false,
        status: 'offline',
        createdAt: Date.now(),
      })
      .run();
    const {accessToken} = issueTokens(h.db, {clientId: seedOauthClient(userId), userId, agentId});
    return {agentId, token: accessToken};
  }

  function agentRow(agentId: string) {
    return h.db.select().from(agents).where(eq(agents.id, agentId)).get()!;
  }

  function storyRow(storyId: string) {
    return h.db.select().from(stories).where(eq(stories.id, storyId)).get()!;
  }

  function seedStory(userId: string, projectId: string, title: string, dependsOn: string[] = []): Story {
    return createStory(h.db, h.app.hub, userId, {projectId, title, dependsOn});
  }

  /** A story sitting in the `todo` column, ready to be claimed. */
  function seedTodoStory(userId: string, projectId: string, title: string, dependsOn: string[] = []): Story {
    const story = seedStory(userId, projectId, title, dependsOn);
    return moveStory(h.db, h.app.hub, {userId, storyId: story.id, status: 'todo', actor: 'user'});
  }

  async function connect(token: string): Promise<Client> {
    const client = new Client({name: 'test-agent', version: '1.0.0'});
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {headers: {authorization: `Bearer ${token}`}},
    });
    await client.connect(transport);
    onTestFinished(() => client.close());
    return client;
  }

  /** Calls a tool and returns the raw text block, whatever it contains. */
  async function rawCall(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({name, arguments: args});
    const content = result.content as Array<{type: string; text: string}> | undefined;
    const first = content?.[0];
    expect(first?.type, `tool ${name} returned no text block`).toBe('text');
    return {isError: result.isError === true, text: first!.text};
  }

  /** Calls a tool and parses its JSON payload (every tool result is JSON text). */
  async function call<T = Record<string, unknown>>(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{isError: boolean; data: WithControl<T>}> {
    const {isError, text} = await rawCall(client, name, args);
    return {isError, data: JSON.parse(text) as WithControl<T>};
  }

  /** Calls a tool that is expected to succeed, failing loudly (with the error) if it did not. */
  async function ok<T = Record<string, unknown>>(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<WithControl<T>> {
    const {isError, text} = await rawCall(client, name, args);
    expect(isError, `tool ${name} failed: ${text}`).toBe(false);
    return JSON.parse(text) as WithControl<T>;
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('condition was not met in time');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  /** Claims the next story and returns it — the state most tool tests start from. */
  async function claimed(client: Client) {
    const payload = await ok<{claimed: boolean; story: Story; project: Project}>(client, 'claim_next_story');
    expect(payload.claimed).toBe(true);
    return payload;
  }

  describe('transport and authentication', () => {
    it('401s without a bearer token, pointing at the resource metadata', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
      });

      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate');
      expect(challenge).toMatch(/^Bearer /);
      expect(challenge).toContain('resource_metadata=');
      expect(challenge).toContain('/.well-known/oauth-protected-resource/mcp');
    });

    it('401s on a malformed, unknown or revoked token', async () => {
      for (const header of ['Bearer nonsense', 'Basic abc', 'Bearer', '']) {
        const res = await fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(header === '' ? {} : {authorization: header}),
          },
          body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
        });
        expect(res.status, `header: ${header}`).toBe(401);
      }
    });

    it('serves the operating manual as the server instructions', async () => {
      const {user} = await seedUser();
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const instructions = client.getInstructions() ?? '';
      expect(instructions).toMatch(/kanban board/i);
      expect(instructions).toContain('control.stop_requested');
      expect(instructions).toContain('claim_next_story');
    });

    it('lists every documented tool and no others', async () => {
      const {user} = await seedUser();
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const names = (await client.listTools()).tools.map(tool => tool.name).sort();
      expect(names).toEqual(
        [
          'claim_next_story',
          'get_board',
          'get_story',
          'list_projects',
          'move_story',
          'post_progress',
          'post_update',
          'release_story',
          'set_agent_mode',
          'wait_for_work',
        ].sort(),
      );
    });

    it('repeats the rules that matter in the tool descriptions', async () => {
      const {user} = await seedUser();
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const byName = new Map((await client.listTools()).tools.map(tool => [tool.name, tool.description ?? '']));
      expect(byName.get('move_story')).toMatch(/never skip|do not skip/i);
      expect(byName.get('move_story')).toMatch(/accepted/);
      expect(byName.get('post_progress')).toMatch(/progress bar|every meaningful step/i);
      expect(byName.get('release_story')).toMatch(/stop_requested|stop/i);
      expect(byName.get('claim_next_story')).toMatch(/project\.path|clear/i);
    });
  });

  describe('reading the board', () => {
    it('returns only the token owner’s board', async () => {
      const mine = await seedUser('mine@example.com');
      const theirs = await seedUser('theirs@example.com');
      const myStory = seedTodoStory(mine.user.id, mine.project.id, 'My story');
      const theirStory = seedTodoStory(theirs.user.id, theirs.project.id, 'Their secret story');
      seedAgent(theirs.user.id, {name: 'Their agent'});

      const {token} = seedAgent(mine.user.id);
      const client = await connect(token);

      const board = await ok<{board: {stories: Story[]; projects: Project[]; agents: Array<{id: string}>}}>(
        client,
        'get_board',
      );
      expect(board.board.stories.map(story => story.id)).toEqual([myStory.id]);
      expect(JSON.stringify(board.board)).not.toContain('Their secret story');
      expect(JSON.stringify(board.board)).not.toContain(theirStory.id);
      expect(board.board.projects.map(project => project.id)).toEqual([mine.project.id]);
      expect(board.board.agents.every(agent => agent.id !== undefined)).toBe(true);
      expect(JSON.stringify(board.board.agents)).not.toContain('Their agent');

      const projects = await ok<{projects: Project[]}>(client, 'list_projects');
      expect(projects.projects.map(project => project.id)).toEqual([mine.project.id]);
    });

    it('refuses to read another user’s story', async () => {
      const mine = await seedUser('mine@example.com');
      const theirs = await seedUser('theirs@example.com');
      const theirStory = seedTodoStory(theirs.user.id, theirs.project.id, 'Their secret story');

      const {token} = seedAgent(mine.user.id);
      const client = await connect(token);

      const result = await rawCall(client, 'get_story', {storyId: theirStory.id});
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain('Their secret story');
      expect(result.text).toMatch(/not found/i);
    });

    it('returns a story with its project path and its timeline', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const payload = await ok<{story: Story; project: Project; updates: StoryUpdate[]}>(client, 'get_story', {
        storyId: story.id,
      });
      expect(payload.story.id).toBe(story.id);
      expect(payload.project.path).toBe(project.path);
      expect(payload.updates.map(update => update.kind)).toContain('status_change');
    });
  });

  describe('claiming work', () => {
    it('claims the highest-ranked unblocked todo story, skipping blocked ones', async () => {
      const {user, project} = await seedUser();
      const dependency = seedStory(user.id, project.id, 'Schema first');
      const blocked = seedTodoStory(user.id, project.id, 'Blocked story', [dependency.id]);
      const next = seedTodoStory(user.id, project.id, 'Claimable story');

      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);

      const payload = await claimed(client);
      expect(payload.story.id).toBe(next.id);
      expect(payload.story.title).toBe('Claimable story');
      expect(payload.story.status).toBe('in_progress');
      expect(payload.project.path).toBe(project.path);

      expect(storyRow(blocked.id).status).toBe('todo');
      expect(storyRow(next.id).claimedByAgentId).toBe(agentId);
      expect(agentRow(agentId).currentStoryId).toBe(next.id);
      expect(agentRow(agentId).status).toBe('working');
    });

    it('claims a named story when given a storyId', async () => {
      const {user, project} = await seedUser();
      seedTodoStory(user.id, project.id, 'First');
      const wanted = seedTodoStory(user.id, project.id, 'Second');
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const payload = await ok<{story: Story}>(client, 'claim_next_story', {storyId: wanted.id});
      expect(payload.story.id).toBe(wanted.id);
    });

    it('refuses to claim a blocked story by id, with a readable reason', async () => {
      const {user, project} = await seedUser();
      const dependency = seedStory(user.id, project.id, 'Schema first');
      const blocked = seedTodoStory(user.id, project.id, 'Blocked story', [dependency.id]);
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const result = await rawCall(client, 'claim_next_story', {storyId: blocked.id});
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/blocked/i);
      expect(result.text).not.toMatch(/\bat [\w./]+:\d+:\d+/); // no stack frames
      expect(storyRow(blocked.id).status).toBe('todo');
    });

    it('refuses to claim when another agent holds the story', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Contested');
      const other = seedAgent(user.id, {name: 'Other agent'});
      h.db.update(stories).set({claimedByAgentId: other.agentId}).where(eq(stories.id, story.id)).run();

      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);

      const result = await rawCall(client, 'claim_next_story', {storyId: story.id});
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/already claimed by another agent/i);
      expect(storyRow(story.id).claimedByAgentId).toBe(other.agentId);
      expect(agentRow(agentId).currentStoryId).toBeNull();
    });

    it('reports that there is nothing to claim rather than failing', async () => {
      const {user} = await seedUser();
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const payload = await ok<{claimed: boolean; story: Story | null; reason: string}>(client, 'claim_next_story');
      expect(payload.claimed).toBe(false);
      expect(payload.story).toBeNull();
      expect(payload.reason).toBeTruthy();
    });

    it('releases a story back to todo and leaves the agent idle', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Half done');
      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const payload = await ok<{story: Story}>(client, 'release_story', {
        storyId: story.id,
        reason: 'Stopped on request',
      });
      expect(payload.story.status).toBe('todo');
      expect(storyRow(story.id).claimedByAgentId).toBeNull();
      expect(agentRow(agentId).currentStoryId).toBeNull();
      expect(agentRow(agentId).status).toBe('idle');

      const timeline = h.db.select().from(storyUpdates).where(eq(storyUpdates.storyId, story.id)).all();
      expect(timeline.some(update => update.body.includes('Stopped on request'))).toBe(true);
    });
  });

  describe('moving work', () => {
    it('moves in_progress -> in_test and rejects -> accepted', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const moved = await ok<{story: Story}>(client, 'move_story', {
        storyId: story.id,
        status: 'in_test',
        reason: 'Implementation done, running the suite',
      });
      expect(moved.story.status).toBe('in_test');

      const refused = await rawCall(client, 'move_story', {
        storyId: story.id,
        status: 'accepted',
        reason: 'It works',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/only a human/i);
      expect(storyRow(story.id).status).toBe('in_test');
    });

    it('records the reason for a move on the timeline', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      await ok(client, 'move_story', {storyId: story.id, status: 'in_test', reason: 'Suite is green locally'});

      const timeline = h.db.select().from(storyUpdates).where(eq(storyUpdates.storyId, story.id)).all();
      expect(timeline.some(update => update.body === 'Moved from in_progress to in_test')).toBe(true);
      expect(timeline.some(update => update.body.includes('Suite is green locally'))).toBe(true);
    });

    it('requires a reason for a move', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const result = await rawCall(client, 'move_story', {storyId: story.id, status: 'in_test'});
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/reason/i);
      expect(storyRow(story.id).status).toBe('in_progress');
    });

    it('refuses to move a story another agent holds', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Contested');
      const other = seedAgent(user.id, {name: 'Other agent'});
      h.db
        .update(stories)
        .set({claimedByAgentId: other.agentId, status: 'in_progress'})
        .where(eq(stories.id, story.id))
        .run();

      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const result = await rawCall(client, 'move_story', {
        storyId: story.id,
        status: 'in_test',
        reason: 'Trying my luck',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/claimed/i);
      expect(storyRow(story.id).status).toBe('in_progress');
    });

    it('rejects an unknown status with a useful message', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const result = await rawCall(client, 'move_story', {storyId: story.id, status: 'done', reason: 'x'});
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/status/i);
    });
  });

  describe('reporting progress', () => {
    it('updates the progress bar and publishes on the hub', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const events: ServerEvent[] = [];
      h.app.hub.subscribe(user.id, (event: ServerEvent) => events.push(event));

      const payload = await ok<{story: Story}>(client, 'post_progress', {
        storyId: story.id,
        progressPct: 40,
        label: 'Writing the failing test',
      });
      expect(payload.story.progressPct).toBe(40);
      expect(payload.story.progressLabel).toBe('Writing the failing test');

      const row = storyRow(story.id);
      expect(row.progressPct).toBe(40);
      expect(row.progressLabel).toBe('Writing the failing test');

      expect(events.some(event => event.type === 'story.progress' && event.progressPct === 40)).toBe(true);
      expect(events.some(event => event.type === 'story.update')).toBe(true);
    });

    it('rejects an out-of-range progress value', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const result = await rawCall(client, 'post_progress', {storyId: story.id, progressPct: 150, label: 'Nearly'});
      expect(result.isError).toBe(true);
      expect(storyRow(story.id).progressPct).toBe(0);
    });

    it('appends a note to the timeline with post_update', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      await ok(client, 'post_update', {storyId: story.id, body: 'Found the session plugin already does this'});

      const timeline = h.db.select().from(storyUpdates).where(eq(storyUpdates.storyId, story.id)).all();
      const note = timeline.find(update => update.kind === 'note');
      expect(note?.body).toBe('Found the session plugin already does this');
      expect(note?.authorType).toBe('agent');
      expect(note?.authorId).toBe(agentId);
    });
  });

  describe('the control block', () => {
    it('is present in every tool result', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const calls: Array<[string, Record<string, unknown>]> = [
        ['get_board', {}],
        ['list_projects', {}],
        ['claim_next_story', {}],
        ['get_story', {storyId: story.id}],
        ['post_progress', {storyId: story.id, progressPct: 10, label: 'Starting'}],
        ['post_update', {storyId: story.id, body: 'A note'}],
        ['move_story', {storyId: story.id, status: 'in_test', reason: 'Verifying'}],
        ['set_agent_mode', {autonomous: true}],
        ['wait_for_work', {timeoutSeconds: 1}],
        ['release_story', {storyId: story.id, reason: 'Done for now'}],
      ];

      for (const [name, args] of calls) {
        const payload = await ok(client, name, args);
        expect(payload.control, `tool ${name} returned no control block`).toBeDefined();
        expect(typeof payload.control.stop_requested, `tool ${name}`).toBe('boolean');
        expect(typeof payload.control.autonomous, `tool ${name}`).toBe('boolean');
        expect(Array.isArray(payload.control.remarks), `tool ${name}`).toBe(true);
      }
    });

    it('is present on a failed tool call too, so a stop still reaches the agent', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const result = await rawCall(client, 'move_story', {storyId: story.id, status: 'accepted', reason: 'Nope'});
      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.text) as {control: Control};
      expect(payload.control).toBeDefined();
      expect(payload.control.stop_requested).toBe(false);
    });

    it('surfaces a human remark exactly once', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      addUpdate(h.db, h.app.hub, {
        userId: user.id,
        storyId: story.id,
        body: 'Please reuse the existing session plugin',
        kind: 'remark',
        authorType: 'user',
        authorId: user.id,
      });

      const first = await ok(client, 'get_board');
      expect(first.control.remarks).toEqual(['Please reuse the existing session plugin']);

      const second = await ok(client, 'get_board');
      expect(second.control.remarks).toEqual([]);

      addUpdate(h.db, h.app.hub, {
        userId: user.id,
        storyId: story.id,
        body: 'And add a test for the empty case',
        kind: 'remark',
        authorType: 'user',
        authorId: user.id,
      });

      const third = await ok(client, 'get_board');
      expect(third.control.remarks).toEqual(['And add a test for the empty case']);
    });

    it('delivers several remarks in the order the human wrote them', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      for (const body of ['First remark', 'Second remark', 'Third remark']) {
        addUpdate(h.db, h.app.hub, {
          userId: user.id,
          storyId: story.id,
          body,
          kind: 'remark',
          authorType: 'user',
          authorId: user.id,
        });
      }

      const payload = await ok(client, 'get_board');
      expect(payload.control.remarks).toEqual(['First remark', 'Second remark', 'Third remark']);
    });

    it('does not deliver an agent’s own notes as remarks', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      await ok(client, 'post_update', {storyId: story.id, body: 'my own note'});
      await ok(client, 'post_progress', {storyId: story.id, progressPct: 20, label: 'Working'});

      const payload = await ok(client, 'get_board');
      expect(payload.control.remarks).toEqual([]);
    });

    it('reports stop_requested after POST /api/stories/:id/stop', async () => {
      const {cookie, user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);
      await claimed(client);

      const before = await ok(client, 'get_board');
      expect(before.control.stop_requested).toBe(false);

      const res = await h.app.inject({method: 'POST', url: `/api/stories/${story.id}/stop`, headers: {cookie}});
      expect(res.statusCode).toBe(200);

      const after = await ok(client, 'get_board');
      expect(after.control.stop_requested).toBe(true);
    });

    it('reports the agent’s autonomous flag and lets set_agent_mode change it', async () => {
      const {user} = await seedUser();
      const {agentId, token} = seedAgent(user.id, {autonomous: false});
      const client = await connect(token);

      const before = await ok(client, 'get_board');
      expect(before.control.autonomous).toBe(false);

      const payload = await ok<{agent: {autonomous: boolean}}>(client, 'set_agent_mode', {autonomous: true});
      expect(payload.agent.autonomous).toBe(true);
      expect(payload.control.autonomous).toBe(true);
      expect(agentRow(agentId).autonomous).toBe(true);

      const after = await ok(client, 'get_board');
      expect(after.control.autonomous).toBe(true);
    });

    it('never leaks another user’s remarks', async () => {
      const mine = await seedUser('mine@example.com');
      const theirs = await seedUser('theirs@example.com');
      const theirStory = seedTodoStory(theirs.user.id, theirs.project.id, 'Their story');
      addUpdate(h.db, h.app.hub, {
        userId: theirs.user.id,
        storyId: theirStory.id,
        body: 'Their private remark',
        kind: 'remark',
        authorType: 'user',
        authorId: theirs.user.id,
      });

      const {agentId} = seedAgent(mine.user.id);
      const control = controlBlock(h.db, {userId: mine.user.id, agentId, storyId: theirStory.id});
      expect(control.remarks).toEqual([]);
      expect(control.stop_requested).toBe(false);
    });
  });

  describe('waiting for work', () => {
    it('returns immediately when a claimable story is already waiting', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Ready to go');
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const startedAt = Date.now();
      const payload = await ok<{work: boolean; story: Story | null}>(client, 'wait_for_work', {timeoutSeconds: 30});
      expect(payload.work).toBe(true);
      expect(payload.story?.id).toBe(story.id);
      expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    it('resolves when the human moves a story into todo', async () => {
      const {user, project} = await seedUser();
      const story = seedStory(user.id, project.id, 'Still a draft');
      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);

      const pending = ok<{work: boolean; story: Story | null}>(client, 'wait_for_work', {timeoutSeconds: 30});
      await waitUntil(() => agentRow(agentId).status === 'waiting');

      moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'todo', actor: 'user'});

      const payload = await pending;
      expect(payload.work).toBe(true);
      expect(payload.story?.id).toBe(story.id);
    });

    it('stays parked until a story actually becomes claimable', async () => {
      const {user, project} = await seedUser();
      const dependency = seedStory(user.id, project.id, 'Schema first');
      const blocked = seedTodoStory(user.id, project.id, 'Blocked story', [dependency.id]);
      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);

      const pending = ok<{work: boolean; story: Story | null}>(client, 'wait_for_work', {timeoutSeconds: 30});
      await waitUntil(() => agentRow(agentId).status === 'waiting');

      // An event that does not make anything claimable must not end the wait.
      requestPlay(h.db, h.app.hub, user.id, blocked.id);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(agentRow(agentId).status).toBe('waiting');

      // Finishing the dependency unblocks it, and now the wait resolves.
      for (const status of ['todo', 'in_progress', 'in_test', 'finished'] as const) {
        moveStory(h.db, h.app.hub, {userId: user.id, storyId: dependency.id, status, actor: 'user'});
      }

      const payload = await pending;
      expect(payload.work).toBe(true);
      expect(payload.story?.id).toBe(blocked.id);
    });

    it('returns work:false after the timeout', async () => {
      const {user} = await seedUser();
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const startedAt = Date.now();
      const payload = await ok<{work: boolean; story: Story | null}>(client, 'wait_for_work', {timeoutSeconds: 1});
      expect(payload.work).toBe(false);
      expect(payload.story).toBeNull();
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    });

    it('marks the agent waiting, then working, then idle', async () => {
      const {user, project} = await seedUser();
      const story = seedStory(user.id, project.id, 'Still a draft');
      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);

      const pending = ok(client, 'wait_for_work', {timeoutSeconds: 30});
      await waitUntil(() => agentRow(agentId).status === 'waiting');

      moveStory(h.db, h.app.hub, {userId: user.id, storyId: story.id, status: 'todo', actor: 'user'});
      await pending;
      expect(agentRow(agentId).status).toBe('idle');

      await claimed(client);
      expect(agentRow(agentId).status).toBe('working');
      expect(agentRow(agentId).currentStoryId).toBe(story.id);

      await ok(client, 'release_story', {storyId: story.id, reason: 'Handing it back'});
      expect(agentRow(agentId).status).toBe('idle');
      expect(agentRow(agentId).currentStoryId).toBeNull();
    });

    it('publishes the agent’s status changes on the hub', async () => {
      const {user, project} = await seedUser();
      seedTodoStory(user.id, project.id, 'Ready to go');
      const {agentId, token} = seedAgent(user.id);
      const client = await connect(token);

      const events: ServerEvent[] = [];
      h.app.hub.subscribe(user.id, (event: ServerEvent) => events.push(event));

      await claimed(client);
      const agentEvents = events.filter(event => event.type === 'agent.updated');
      expect(agentEvents.length).toBeGreaterThan(0);
      expect(agentEvents.some(event => event.type === 'agent.updated' && event.agent.id === agentId)).toBe(true);
      expect(agentEvents.some(event => event.type === 'agent.updated' && event.agent.status === 'working')).toBe(true);
    });

    it('clamps the long-poll timeout to 55 seconds', () => {
      expect(clampTimeoutSeconds(undefined)).toBeLessThanOrEqual(55);
      expect(clampTimeoutSeconds(600)).toBe(55);
      expect(clampTimeoutSeconds(55)).toBe(55);
      expect(clampTimeoutSeconds(10)).toBe(10);
      expect(clampTimeoutSeconds(0)).toBeGreaterThan(0);
      expect(clampTimeoutSeconds(-5)).toBeGreaterThan(0);
    });

    it('marks a token owner’s agent waiting without touching another user’s agent', async () => {
      const mine = await seedUser('mine@example.com');
      const theirs = await seedUser('theirs@example.com');
      const other = seedAgent(theirs.user.id, {name: 'Their agent'});

      const {agentId, token} = seedAgent(mine.user.id);
      const client = await connect(token);
      const pending = ok(client, 'wait_for_work', {timeoutSeconds: 1});
      await waitUntil(() => agentRow(agentId).status === 'waiting');
      expect(agentRow(other.agentId).status).toBe('offline');
      await pending;
    });
  });

  describe('resources', () => {
    it('exposes the board and a story as resources', async () => {
      const {user, project} = await seedUser();
      const story = seedTodoStory(user.id, project.id, 'Add login');
      const {token} = seedAgent(user.id);
      const client = await connect(token);

      const resources = (await client.listResources()).resources.map(resource => resource.uri);
      expect(resources).toContain('board://current');

      const board = await client.readResource({uri: 'board://current'});
      const boardText = (board.contents[0] as {text: string}).text;
      expect(JSON.parse(boardText).stories.map((s: Story) => s.id)).toEqual([story.id]);

      const read = await client.readResource({uri: `story://${story.id}`});
      const storyText = (read.contents[0] as {text: string}).text;
      expect(JSON.parse(storyText).story.id).toBe(story.id);
    });

    it('refuses to read another user’s story resource', async () => {
      const mine = await seedUser('mine@example.com');
      const theirs = await seedUser('theirs@example.com');
      const theirStory = seedTodoStory(theirs.user.id, theirs.project.id, 'Their secret story');

      const {token} = seedAgent(mine.user.id);
      const client = await connect(token);

      await expect(client.readResource({uri: `story://${theirStory.id}`})).rejects.toThrow(/not found/i);
    });
  });
});
