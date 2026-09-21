import {and, eq, gt, sql} from 'drizzle-orm';
import type {Database} from '../db/index.js';
import {agents, stories, storyUpdates} from '../db/schema.js';
import type {EventHub} from '../events/hub.js';
import type {Agent, AgentStatus} from '../../shared/types.js';

/**
 * The control block: the board's side channel to a working agent.
 *
 * An agent that is busy implementing a story is not polling anything, so every tool
 * result carries this block — it is the only way a stop request or a human's remark
 * reaches the agent between two tool calls.
 */
export interface ControlBlock {
  /** The human pressed Stop on this story; the agent must release it and stop. */
  stop_requested: boolean;
  /** The agent may claim its next story without asking. */
  autonomous: boolean;
  /** Remarks the human typed on the story since this agent last heard from us. */
  remarks: string[];
}

export interface ControlBlockInput {
  userId: string;
  agentId: string;
  /** The story the call was about; falls back to the story the agent is holding. */
  storyId?: string | null;
}

const EMPTY_CONTROL: ControlBlock = {stop_requested: false, autonomous: false, remarks: []};

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
export function findOwnedAgent(db: Database, userId: string, agentId: string): Agent | undefined {
  const row = db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .get();
  return row ? toAgent(row) : undefined;
}

/**
 * Patches an agent row and publishes `agent.updated` — but only when something the board
 * renders actually changed. Every tool call touches `last_seen_at`; publishing an event
 * for each of those would fill every open socket with noise that changes no pixel.
 */
export function updateAgent(
  db: Database,
  hub: EventHub,
  input: {userId: string; agentId: string},
  patch: {status?: AgentStatus; currentStoryId?: string | null; autonomous?: boolean},
): Agent | undefined {
  const {userId, agentId} = input;
  const existing = findOwnedAgent(db, userId, agentId);
  if (!existing) return undefined;

  const next: Agent = {...existing, ...patch};
  const changed =
    next.status !== existing.status ||
    next.currentStoryId !== existing.currentStoryId ||
    next.autonomous !== existing.autonomous;
  if (!changed) return existing;

  db.update(agents)
    .set(patch)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .run();

  hub.publish(userId, {type: 'agent.updated', agent: next});
  return next;
}

/**
 * Builds the control block for one tool call and advances the agent's delivery watermark.
 *
 * Remarks are the `story_updates` of kind `remark` on the story in context that were
 * created after `agents.last_seen_at`; the watermark then moves forward, so each remark
 * reaches the agent exactly once. Delivering one twice makes an agent redo work it has
 * already done; never delivering one strands the human, so both halves matter.
 *
 * The new watermark is `max(now - 1, newest delivered remark)`, not `now`:
 *
 *  - `now` alone would lose a remark written in the same millisecond as this call but
 *    after it had read the table — with millisecond timestamps that is a real window,
 *    and the remark would then be excluded forever by the strict `>` comparison;
 *  - `now - 1` alone would re-deliver a remark that was itself created at `now`.
 *
 * Taking the larger of the two closes the first hole without opening the second. (The
 * one case it cannot cover — a second remark written in the same millisecond as this
 * call, which itself delivered a remark stamped that same millisecond — needs a finer
 * watermark than a millisecond column can express.)
 *
 * A story that is not `userId`'s (or an agent that is not) yields the empty block: a
 * control block must never carry another user's remarks.
 */
export function controlBlock(db: Database, {userId, agentId, storyId}: ControlBlockInput): ControlBlock {
  const agent = findOwnedAgent(db, userId, agentId);
  if (!agent) return {...EMPTY_CONTROL};

  const contextStoryId = storyId ?? agent.currentStoryId;
  const story = contextStoryId
    ? db
        .select({stopRequested: stories.stopRequested})
        .from(stories)
        .where(and(eq(stories.id, contextStoryId), eq(stories.userId, userId)))
        .get()
    : undefined;

  const since = agent.lastSeenAt ?? 0;
  const remarkRows =
    story && contextStoryId
      ? db
          .select({body: storyUpdates.body, createdAt: storyUpdates.createdAt})
          .from(storyUpdates)
          .where(
            and(
              eq(storyUpdates.storyId, contextStoryId),
              eq(storyUpdates.kind, 'remark'),
              gt(storyUpdates.createdAt, since),
            ),
          )
          // Same tie-break as the story timeline: two remarks can share a millisecond,
          // and the human's order is the insertion order.
          .orderBy(storyUpdates.createdAt, sql`rowid`)
          .all()
      : [];

  const now = Date.now();
  const newestDelivered = remarkRows.reduce((max, row) => Math.max(max, row.createdAt), Number.NEGATIVE_INFINITY);
  const lastSeenAt = Math.max(since, now - 1, newestDelivered);
  db.update(agents)
    .set({lastSeenAt})
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .run();

  return {
    stop_requested: story?.stopRequested ?? false,
    autonomous: agent.autonomous,
    remarks: remarkRows.map(row => row.body),
  };
}
