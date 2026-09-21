import {and, eq, gt, sql} from 'drizzle-orm';
import type {Database} from '../db/index.js';
import {agents, stories, storyUpdates} from '../db/schema.js';
import {findOwnedAgent} from '../services/agents.js';

export {findOwnedAgent, updateAgent} from '../services/agents.js';

/**
 * The control block: the board's side channel to a working agent.
 *
 * An agent that is busy implementing a story is not polling anything, so every tool
 * result carries this block — it is the only way a stop request or a human's remark
 * reaches the agent between two tool calls.
 */
/** One remark the human typed, tagged with the story it was written on. */
export interface Remark {
  story_id: string;
  story_title: string;
  body: string;
}

export interface ControlBlock {
  /** The human pressed Stop on this story; the agent must release it and stop. */
  stop_requested: boolean;
  /** The agent may claim its next story without asking. */
  autonomous: boolean;
  /** Remarks the human typed on any of their stories since this agent last heard from us. */
  remarks: Remark[];
}

export interface ControlBlockInput {
  userId: string;
  agentId: string;
  /** The story the call was about; falls back to the story the agent is holding. */
  storyId?: string | null;
}

/** The control block that claims nothing: no stop, not autonomous, no remarks. */
export function emptyControl(): ControlBlock {
  return {stop_requested: false, autonomous: false, remarks: []};
}

/**
 * Builds the control block for one tool call and advances the agent's delivery watermark.
 *
 * Remarks are the `story_updates` of kind `remark` on **any** of the user's stories that
 * were created after `agents.last_seen_at`; the watermark then moves forward, so each
 * remark reaches the agent exactly once. Delivering one twice makes an agent redo work it
 * has already done; never delivering one strands the human, so both halves matter.
 *
 * Reading across every story rather than only the story in context is what makes the
 * second half true. There is one watermark per agent and it advances on every call, so a
 * remark left on a queued story while the agent works on another one would otherwise sink
 * below the watermark and never be delivered at all — the human would see their remark on
 * the card and never get an answer. Each remark therefore carries the story it belongs to,
 * and the agent decides when to act on it.
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
  if (!agent) return emptyControl();

  const contextStoryId = storyId ?? agent.currentStoryId;
  const story = contextStoryId
    ? db
        .select({stopRequested: stories.stopRequested})
        .from(stories)
        .where(and(eq(stories.id, contextStoryId), eq(stories.userId, userId)))
        .get()
    : undefined;

  const since = agent.lastSeenAt ?? 0;
  const remarkRows = db
    .select({
      body: storyUpdates.body,
      createdAt: storyUpdates.createdAt,
      storyId: storyUpdates.storyId,
      storyTitle: stories.title,
    })
    .from(storyUpdates)
    // The join is what scopes remarks to this user: `story_updates` has no user of its own.
    .innerJoin(stories, and(eq(stories.id, storyUpdates.storyId), eq(stories.userId, userId)))
    .where(and(eq(storyUpdates.kind, 'remark'), gt(storyUpdates.createdAt, since)))
    // Same tie-break as the story timeline: two remarks can share a millisecond, and the
    // human's order is the insertion order. Qualified, because the join has two rowids.
    .orderBy(storyUpdates.createdAt, sql`story_updates.rowid`)
    .all();

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
    remarks: remarkRows.map(row => ({story_id: row.storyId, story_title: row.storyTitle, body: row.body})),
  };
}
