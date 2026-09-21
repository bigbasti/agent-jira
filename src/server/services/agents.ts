import {and, desc, eq} from 'drizzle-orm';
import {nanoid} from 'nanoid';
import {z} from 'zod';
import type {Database} from '../db/index.js';
import {agents, oauthTokens, stories, storyUpdates} from '../db/schema.js';
import type {EventHub} from '../events/hub.js';
import {MAX_AGENT_NAME_LENGTH, sanitiseAgentName} from '../oauth/authorize.js';
import {listProjects, NotFoundError} from './projects.js';
import {getStory, listStories} from './stories.js';
import {rankBetween} from '../../shared/rank.js';
import type {Agent, AgentStatus} from '../../shared/types.js';

/**
 * Agent presence and lifecycle: listing, the autonomous switch, renaming, and revoking.
 *
 * This is also the one place `findOwnedAgent`/`updateAgent` live — the MCP server (task
 * 13) touches an agent's `status`/`currentStoryId`/`autonomous` on almost every tool call,
 * and the board's human-facing routes touch `autonomous`/`name`. Both go through the same
 * patch-and-publish-if-changed function so there is exactly one rule for when
 * `agent.updated` fires.
 */

/** The transaction handle better-sqlite3's synchronous `db.transaction` hands the callback. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run a query: the database itself or an open transaction. */
type Queryable = Database | Tx;

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    autonomous: row.autonomous,
    status: row.status,
    currentStoryId: row.currentStoryId,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/** Loads one of `userId`'s agents. Another user's agent is indistinguishable from none. */
export function findOwnedAgent(db: Queryable, userId: string, agentId: string): Agent | undefined {
  const row = db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .get();
  return row ? toAgent(row) : undefined;
}

/** Like `findOwnedAgent`, but throws `NotFoundError` instead of returning `undefined`. */
function requireOwnedAgent(db: Queryable, userId: string, agentId: string): Agent {
  const agent = findOwnedAgent(db, userId, agentId);
  if (!agent) {
    throw new NotFoundError('Agent not found');
  }
  return agent;
}

/** Every agent belonging to `userId`. */
export function listAgents(db: Database, userId: string): Agent[] {
  return db.select().from(agents).where(eq(agents.userId, userId)).all().map(toAgent);
}

/**
 * Patches an agent row and publishes `agent.updated` — but only when something the board
 * renders actually changed. Every MCP tool call touches `last_seen_at`; publishing an
 * event for each of those would fill every open socket with noise that changes no pixel.
 */
export function updateAgent(
  db: Database,
  hub: EventHub,
  input: {userId: string; agentId: string},
  patch: {status?: AgentStatus; currentStoryId?: string | null; autonomous?: boolean; name?: string},
): Agent | undefined {
  const {userId, agentId} = input;
  const existing = findOwnedAgent(db, userId, agentId);
  if (!existing) return undefined;

  const next: Agent = {...existing, ...patch};
  const changed =
    next.status !== existing.status ||
    next.currentStoryId !== existing.currentStoryId ||
    next.autonomous !== existing.autonomous ||
    next.name !== existing.name;
  if (!changed) return existing;

  db.update(agents)
    .set(patch)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .run();

  hub.publish(userId, {type: 'agent.updated', agent: next});
  return next;
}

export const patchAgentSchema = z
  .object({
    autonomous: z.boolean().optional(),
    name: z.string().trim().min(1).max(MAX_AGENT_NAME_LENGTH).optional(),
  })
  .refine(input => Object.keys(input).length > 0, 'Nothing to update');

/**
 * Applies a human's edit to one of their agents — the autonomous switch, a rename, or
 * both at once. Throws `NotFoundError` when the agent is not `userId`'s.
 */
export function patchAgent(db: Database, hub: EventHub, userId: string, agentId: string, input: unknown): Agent {
  const parsed = patchAgentSchema.parse(input);

  const patch: {autonomous?: boolean; name?: string} = {};
  if (parsed.autonomous !== undefined) patch.autonomous = parsed.autonomous;
  if (parsed.name !== undefined) patch.name = sanitiseAgentName(parsed.name);

  // `updateAgent` does its own ownership lookup (it has to — it's also called from the MCP
  // server with no prior check) and returns `undefined` when the agent isn't `userId`'s or
  // doesn't exist, at which point this reports the same `NotFoundError` `requireOwnedAgent`
  // used to, without a second, redundant lookup for the common case where it does exist.
  const agent = updateAgent(db, hub, {userId, agentId}, patch);
  if (!agent) throw new NotFoundError('Agent not found');
  return agent;
}

/** The rank at the end of `userId`'s `todo` column — where a revoke-released story lands. */
function endOfTodo(tx: Tx, userId: string): string {
  const row = tx
    .select({rank: stories.rank})
    .from(stories)
    .where(and(eq(stories.userId, userId), eq(stories.status, 'todo')))
    .orderBy(desc(stories.rank))
    .limit(1)
    .get();
  return rankBetween(row?.rank ?? null, null);
}

/**
 * Revokes an agent: deletes its OAuth tokens (so its next MCP call 401s), releases any
 * story it holds back to `todo` with a `system` note, then deletes the agent row — all in
 * one transaction, so a crash partway through can never leave a token alive with no agent
 * behind it, or a story stuck `in_progress` with no claimant.
 *
 * Publishes the released story's `story.updated` (if there was one) and `agent.deleted`
 * after the transaction commits, so every open tab drops the agent and sees its story land
 * back in `todo` without a full refetch.
 */
export function revokeAgent(db: Database, hub: EventHub, userId: string, agentId: string): void {
  const releasedStoryId = db.transaction(tx => {
    requireOwnedAgent(tx, userId, agentId);

    tx.delete(oauthTokens)
      .where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.agentId, agentId)))
      .run();

    const claimed = tx
      .select({id: stories.id})
      .from(stories)
      .where(and(eq(stories.userId, userId), eq(stories.claimedByAgentId, agentId)))
      .get();

    if (claimed) {
      const now = Date.now();
      tx.update(stories)
        .set({
          status: 'todo' as const,
          rank: endOfTodo(tx, userId),
          claimedByAgentId: null,
          stopRequested: false,
          playRequestedAt: null,
          updatedAt: now,
        })
        .where(eq(stories.id, claimed.id))
        .run();
      tx.insert(storyUpdates)
        .values({
          id: nanoid(),
          storyId: claimed.id,
          authorType: 'system',
          authorId: 'system',
          kind: 'status_change',
          body: 'Agent revoked — story released',
          progressPct: null,
          createdAt: now,
        })
        .run();
    }

    tx.delete(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .run();

    return claimed?.id ?? null;
  });

  if (releasedStoryId) {
    hub.publish(userId, {type: 'story.updated', story: getStory(db, userId, releasedStoryId)});
  }
  hub.publish(userId, {type: 'agent.deleted', id: agentId});
}

/** What the host runner needs to cold-start an agent on one story. */
export interface QueuedStory {
  id: string;
  title: string;
  projectPath: string;
}

/**
 * The oldest played story `userId` has waiting for an agent to pick up: in `todo`,
 * unblocked, and not already claimed. This is the cold-start counterpart to the MCP
 * `wait_for_work` long-poll — where that tool answers an agent that is already parked and
 * connected, this is what the host runner script polls when *no* agent is running at all,
 * so it knows what to launch and where.
 *
 * Ties in `playRequestedAt` (a played-but-not-yet-picked-up backlog) resolve oldest first,
 * same as any other queue: the story a human has been waiting longest on goes first.
 */
export function nextQueuedStory(db: Database, userId: string): QueuedStory | undefined {
  const queued = listStories(db, userId)
    .filter(
      story =>
        story.status === 'todo' &&
        story.playRequestedAt !== null &&
        story.blockedBy.length === 0 &&
        story.claimedByAgentId === null,
    )
    .sort((a, b) => (a.playRequestedAt ?? 0) - (b.playRequestedAt ?? 0));

  const story = queued[0];
  if (!story) return undefined;

  // The FK from stories.project_id guarantees this project exists; `find` over
  // `listProjects` reuses the same userId-scoped read the rest of the service layer uses
  // rather than a bespoke lookup for one field.
  const project = listProjects(db, userId).find(candidate => candidate.id === story.projectId);
  if (!project) return undefined;

  return {id: story.id, title: story.title, projectPath: project.path};
}
