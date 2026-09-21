import {and, desc, eq, inArray, ne, or, sql} from 'drizzle-orm';
import {alias} from 'drizzle-orm/sqlite-core';
import {nanoid} from 'nanoid';
import {z} from 'zod';
import type {Database} from '../db/index.js';
import {agents, projects, stories, storyDependencies, storyUpdates} from '../db/schema.js';
import type {EventHub} from '../events/hub.js';
import {NotFoundError} from './projects.js';
import {rankBetween} from '../../shared/rank.js';
import {canTransition, type Actor} from '../../shared/transitions.js';
import {blockedBy, wouldCycle} from '../../shared/dependencies.js';
import {DEFAULT_MODEL_ID, findModel} from '../../shared/models.js';
import {STATUSES, type Status} from '../../shared/status.js';
import type {Agent, Story, StoryUpdate, StoryUpdateAuthorType, StoryUpdateKind} from '../../shared/types.js';

/**
 * A refused status transition — the actor is not allowed to make this move (or, for an
 * agent, not on this story). Routes map it to 409 and surface `message` as the reason, so
 * an optimistic UI can snap the card back and say why.
 */
export class TransitionError extends Error {
  constructor(message = 'Transition not allowed') {
    super(message);
    this.name = 'TransitionError';
  }
}

/**
 * A request that is well-formed but refers to something impossible — an unknown model, a
 * dependency on a story that isn't the caller's, an edge that would close a cycle, or a
 * pair of reorder neighbours with no rank between them. Routes map it to 400. It exists
 * alongside `ZodError` because these rules need the database to decide, so they cannot
 * live in a schema.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** The transaction handle better-sqlite3's synchronous `db.transaction` hands the callback. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run a query: the database itself or an open transaction. */
type Queryable = Database | Tx;

const modelId = z.string().refine(id => findModel(id) !== undefined, 'Unknown model id');
const dependsOnIds = z.array(z.string().trim().min(1));

export const createStorySchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  model: modelId.optional(),
  dependsOn: dependsOnIds.optional(),
});

export const updateStorySchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    model: modelId.optional(),
    projectId: z.string().trim().min(1).optional(),
    dependsOn: dependsOnIds.optional(),
  })
  .refine(input => Object.keys(input).length > 0, 'Nothing to update');

/** The client-supplied half of a move; `actor`/`agentId` come from the caller, never the body. */
export const moveStoryBodySchema = z.object({
  status: z.enum(STATUSES),
  beforeId: z.string().trim().min(1).nullish(),
  afterId: z.string().trim().min(1).nullish(),
});

// Progress is refused outside 0..100 rather than clamped: a caller reporting 150% has a
// bug, and silently rewriting it to 100% would hide that bug behind a plausible bar.
export const progressSchema = z.object({
  progressPct: z.number().int().min(0).max(100),
  label: z.string().optional(),
});

export const remarkSchema = z.object({body: z.string().trim().min(1)});

export interface MoveStoryInput {
  userId: string;
  storyId: string;
  status: Status;
  beforeId?: string | null;
  afterId?: string | null;
  actor: Actor;
  /** Required when `actor` is `'agent'` — the agent doing the move. */
  agentId?: string | null;
}

export interface PostProgressInput {
  userId: string;
  storyId: string;
  progressPct: number;
  label?: string;
  /** When set, the progress is attributed to that agent, which must hold the claim. */
  agentId?: string | null;
}

export interface AddUpdateInput {
  userId: string;
  storyId: string;
  body: string;
  kind: StoryUpdateKind;
  authorType: StoryUpdateAuthorType;
  authorId: string;
}

type StoryRow = typeof stories.$inferSelect;

// Two aliases of `stories` so a dependency edge can be joined to both of its endpoints at
// once — that is what scopes `story_dependencies` (which has no user_id of its own) to a
// single user from both sides.
const dependentStory = alias(stories, 'dependent_story');
const dependencyStory = alias(stories, 'dependency_story');

/** Every dependency edge between two stories owned by `userId`, as `storyId -> dependsOn[]`. */
function loadDependencyEdges(db: Queryable, userId: string): Map<string, string[]> {
  const rows = db
    .select({storyId: storyDependencies.storyId, dependsOnStoryId: storyDependencies.dependsOnStoryId})
    .from(storyDependencies)
    .innerJoin(dependentStory, and(eq(dependentStory.id, storyDependencies.storyId), eq(dependentStory.userId, userId)))
    .innerJoin(
      dependencyStory,
      and(eq(dependencyStory.id, storyDependencies.dependsOnStoryId), eq(dependencyStory.userId, userId)),
    )
    .all();

  const edges = new Map<string, string[]>();
  for (const row of rows) {
    edges.set(row.storyId, [...(edges.get(row.storyId) ?? []), row.dependsOnStoryId]);
  }
  return edges;
}

/** The status of every story owned by `userId` — the other half of the `blockedBy` rule. */
function loadStatuses(db: Queryable, userId: string): Map<string, Status> {
  const rows = db.select({id: stories.id, status: stories.status}).from(stories).where(eq(stories.userId, userId)).all();
  return new Map(rows.map(row => [row.id, row.status]));
}

/** Everything needed to compute `blockedBy` for any of `userId`'s stories, read once. */
function dependencyContext(db: Queryable, userId: string) {
  return {edges: loadDependencyEdges(db, userId), statusOf: loadStatuses(db, userId)};
}

function toStory(row: StoryRow, blocked: string[]): Story {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    model: row.model,
    status: row.status,
    rank: row.rank,
    progressPct: row.progressPct,
    progressLabel: row.progressLabel,
    claimedByAgentId: row.claimedByAgentId,
    stopRequested: row.stopRequested,
    playRequestedAt: row.playRequestedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    blockedBy: blocked,
  };
}

/** Turns one row into a `Story`, reading the dependency graph to fill in `blockedBy`. */
function hydrate(db: Queryable, userId: string, row: StoryRow): Story {
  const {edges, statusOf} = dependencyContext(db, userId);
  return toStory(row, blockedBy(row.id, edges, statusOf));
}

function findOwnedStory(db: Queryable, userId: string, storyId: string): StoryRow | undefined {
  return db
    .select()
    .from(stories)
    .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
    .get();
}

/** Loads a story, treating one owned by another user as missing. */
function requireOwnedStory(db: Queryable, userId: string, storyId: string): StoryRow {
  const row = findOwnedStory(db, userId, storyId);
  if (!row) {
    throw new NotFoundError('Story not found');
  }
  return row;
}

/**
 * Confirms an agent identity belongs to `userId`. Today `userId` and `agentId` both come
 * out of the same OAuth token so they always agree, but the service must not depend on its
 * callers for that: an agent id is an authorisation, and it is checked here.
 */
function requireOwnedAgent(db: Queryable, userId: string, agentId: string): void {
  const row = db
    .select({id: agents.id})
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .get();
  if (!row) {
    throw new NotFoundError('Agent not found');
  }
}

function requireOwnedProject(db: Queryable, userId: string, projectId: string): void {
  const row = db
    .select({id: projects.id})
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .get();
  if (!row) {
    throw new NotFoundError('Project not found');
  }
}

/**
 * The columns a story is in while an agent is actually working on it. A claim is only
 * meaningful here: the moment a story leaves these two — handed over at `finished`, or
 * given back to `todo` — it stops being the agent's, and the claim goes with it.
 */
const WORKING_STATUSES: ReadonlySet<Status> = new Set<Status>(['in_progress', 'in_test']);

/** Whether a story in `status` is in some agent's hands. */
export function isWorkingStatus(status: Status): boolean {
  return WORKING_STATUSES.has(status);
}

/**
 * Clears an agent's hold on a story that has just left its hands, and returns the agent
 * as it now is so the caller can publish `agent.updated` once the transaction commits.
 *
 * Returns `null` when there is nothing to do — the agent is gone, or it was already
 * pointed at something else. An `offline` agent keeps that status: it has not become
 * reachable again just because its story moved.
 */
function clearAgentHold(tx: Tx, userId: string, agentId: string, storyId: string): Agent | null {
  const row = tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .get();
  if (!row || row.currentStoryId !== storyId) return null;

  const status = row.status === 'offline' ? 'offline' : ('idle' as const);
  tx.update(agents)
    .set({currentStoryId: null, status})
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .run();

  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    autonomous: row.autonomous,
    status,
    currentStoryId: null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

function insertUpdate(
  tx: Tx,
  update: {
    storyId: string;
    authorType: StoryUpdateAuthorType;
    authorId: string;
    kind: StoryUpdateKind;
    body: string;
    progressPct: number | null;
  },
): StoryUpdate {
  const row = {id: nanoid(), createdAt: Date.now(), ...update};
  tx.insert(storyUpdates).values(row).run();
  return row;
}

/**
 * Replaces `storyId`'s dependency edges with `dependsOn`. Every id must be another story
 * owned by `userId` (a cross-user dependency is rejected, not silently dropped), and each
 * edge is checked against the graph as it stands after the old edges are cleared, so
 * re-saving an unchanged set never reads as a cycle.
 */
function setDependencies(tx: Tx, userId: string, storyId: string, dependsOn: string[]): void {
  const wanted = [...new Set(dependsOn)];

  if (wanted.length > 0) {
    const owned = new Set(
      tx
        .select({id: stories.id})
        .from(stories)
        .where(and(eq(stories.userId, userId), inArray(stories.id, wanted)))
        .all()
        .map(row => row.id),
    );
    for (const id of wanted) {
      if (!owned.has(id)) {
        throw new ValidationError(`No story ${id} to depend on`);
      }
    }
  }

  tx.delete(storyDependencies).where(eq(storyDependencies.storyId, storyId)).run();

  const edges = loadDependencyEdges(tx, userId);
  edges.set(storyId, []);
  for (const dependsOnId of wanted) {
    if (wouldCycle(storyId, dependsOnId, edges)) {
      throw new ValidationError(`Depending on ${dependsOnId} would create a dependency cycle`);
    }
    edges.set(storyId, [...(edges.get(storyId) ?? []), dependsOnId]);
    tx.insert(storyDependencies).values({storyId, dependsOnStoryId: dependsOnId}).run();
  }
}

/** The highest rank currently in `status`, ignoring `exceptStoryId` (the story being moved). */
function lastRankIn(db: Queryable, userId: string, status: Status, exceptStoryId?: string): string | null {
  const row = db
    .select({rank: stories.rank})
    .from(stories)
    .where(
      and(
        eq(stories.userId, userId),
        eq(stories.status, status),
        exceptStoryId ? ne(stories.id, exceptStoryId) : undefined,
      ),
    )
    .orderBy(desc(stories.rank))
    .limit(1)
    .get();
  return row?.rank ?? null;
}

/**
 * The rank of a neighbour named in a move. Returns `null` when the neighbour is one of
 * `userId`'s stories but no longer sits in `status` — a drop computed against a board that
 * someone else has since reordered is stale, not invalid, and must not fail the drag.
 * A neighbour that does not exist, or belongs to another user, is still `NotFoundError`.
 */
function neighbourRank(db: Queryable, userId: string, status: Status, neighbourId: string): string | null {
  const row = db
    .select({rank: stories.rank, status: stories.status})
    .from(stories)
    .where(and(eq(stories.id, neighbourId), eq(stories.userId, userId)))
    .get();
  if (!row) {
    throw new NotFoundError(`No story ${neighbourId}`);
  }
  return row.status === status ? row.rank : null;
}

/**
 * Where the moved story lands: between `beforeId` and `afterId`, or at the end of the
 * target column when neither survives. A move within the same column with no neighbours at
 * all is not a reorder, and keeps the rank it has.
 */
function rankForMove(db: Queryable, existing: StoryRow, input: MoveStoryInput, status: Status): string {
  const {userId, storyId} = input;
  // A story is never its own neighbour; the client may still send it while dragging.
  const beforeId = input.beforeId && input.beforeId !== storyId ? input.beforeId : null;
  const afterId = input.afterId && input.afterId !== storyId ? input.afterId : null;
  const endOfColumn = () => rankBetween(lastRankIn(db, userId, status, storyId), null);

  if (!beforeId && !afterId) {
    return status === existing.status ? existing.rank : endOfColumn();
  }

  const before = beforeId ? neighbourRank(db, userId, status, beforeId) : null;
  const after = afterId ? neighbourRank(db, userId, status, afterId) : null;
  if (before === null && after === null) {
    // Both named neighbours have moved on since the client last saw the board.
    return endOfColumn();
  }

  try {
    return rankBetween(before, after);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new ValidationError(`Cannot place a story between those two cards: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Whether an agent may pick this story up of its own accord.
 *
 * A story sitting in `todo` is not on its own an invitation to start work: `todo` is also
 * the human's staging column, and an agent that started editing files in a project
 * directory because a card was dragged one column across would be doing work nobody asked
 * for. The invitation is either the human pressing Play on the card (`playRequestedAt`) or
 * the agent being autonomous — the gate spec §6 describes for `wait_for_work`, and the one
 * the host runner's cold-start poll already applied.
 *
 * This is the rule for *automatic* selection only. A human naming a story by id —
 * `claim_next_story(storyId)` — is its own authorisation and does not come through here.
 */
export function isClaimableBy(story: Story, agent: {id: string; autonomous: boolean} | undefined): boolean {
  if (story.status !== 'todo') return false;
  if (story.blockedBy.length > 0) return false;
  if (story.claimedByAgentId !== null && story.claimedByAgentId !== agent?.id) return false;
  // A human's Stop is a parked-until-Play instruction, the same for every agent whether or
  // not it is autonomous: autonomy removes the need for Play, it does not override an
  // explicit Stop. `requestPlay` clears this flag, so pressing Play un-parks the card again.
  if (story.stopRequested) return false;
  return story.playRequestedAt !== null || agent?.autonomous === true;
}

/**
 * Every story of `userId`, each carrying its computed `blockedBy`, sorted by rank — which
 * orders each column correctly, since ranks are only ever compared within a column and the
 * board groups by status before rendering.
 */
export function listStories(db: Database, userId: string): Story[] {
  const rows = db.select().from(stories).where(eq(stories.userId, userId)).orderBy(stories.rank).all();
  const {edges, statusOf} = dependencyContext(db, userId);
  return rows.map(row => toStory(row, blockedBy(row.id, edges, statusOf)));
}

/** Loads one story of `userId`. Throws `NotFoundError` when it is missing or another user's. */
export function getStory(db: Database, userId: string, storyId: string): Story {
  return hydrate(db, userId, requireOwnedStory(db, userId, storyId));
}

/** The story's timeline, oldest first. Throws `NotFoundError` unless `userId` owns it. */
export function listUpdates(db: Database, userId: string, storyId: string): StoryUpdate[] {
  requireOwnedStory(db, userId, storyId);
  return db
    .select()
    .from(storyUpdates)
    .where(eq(storyUpdates.storyId, storyId))
    // `created_at` has millisecond resolution, and an agent can easily post two updates
    // inside one millisecond. SQLite's implicit `rowid` is the insertion order, so it
    // breaks those ties the way a reader expects instead of by random id.
    .orderBy(storyUpdates.createdAt, sql`rowid`)
    .all();
}

/**
 * Creates a story in `draft`, at the end of the draft column, defaulting `model` to
 * `DEFAULT_MODEL_ID`. `input` is validated with `createStorySchema` (`ZodError` on a bad
 * shape or an unknown model). Throws `NotFoundError` when the project is not the caller's,
 * and `ValidationError` when a `dependsOn` id is not one of the caller's stories.
 * Publishes `story.created` after the transaction commits.
 */
export function createStory(db: Database, hub: EventHub, userId: string, input: unknown): Story {
  const parsed = createStorySchema.parse(input);

  const story = db.transaction(tx => {
    requireOwnedProject(tx, userId, parsed.projectId);

    const now = Date.now();
    const row = {
      id: nanoid(),
      userId,
      projectId: parsed.projectId,
      title: parsed.title,
      description: parsed.description ?? '',
      model: parsed.model ?? DEFAULT_MODEL_ID,
      status: 'draft' as const,
      rank: rankBetween(lastRankIn(tx, userId, 'draft'), null),
      progressPct: 0,
      progressLabel: '',
      claimedByAgentId: null,
      stopRequested: false,
      playRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(stories).values(row).run();
    setDependencies(tx, userId, row.id, parsed.dependsOn ?? []);

    return hydrate(tx, userId, row);
  });

  hub.publish(userId, {type: 'story.created', story});
  return story;
}

/**
 * Updates a story's editable fields (everything but its status, rank and progress, which
 * have their own operations). Passing `dependsOn` replaces the whole dependency set.
 * Publishes `story.updated` after the transaction commits.
 */
export function updateStory(db: Database, hub: EventHub, userId: string, storyId: string, input: unknown): Story {
  const parsed = updateStorySchema.parse(input);

  const story = db.transaction(tx => {
    const existing = requireOwnedStory(tx, userId, storyId);
    if (parsed.projectId !== undefined) {
      requireOwnedProject(tx, userId, parsed.projectId);
    }

    const patch = {
      ...(parsed.title !== undefined ? {title: parsed.title} : {}),
      ...(parsed.description !== undefined ? {description: parsed.description} : {}),
      ...(parsed.model !== undefined ? {model: parsed.model} : {}),
      ...(parsed.projectId !== undefined ? {projectId: parsed.projectId} : {}),
      updatedAt: Date.now(),
    };
    tx.update(stories)
      .set(patch)
      .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
      .run();

    if (parsed.dependsOn !== undefined) {
      setDependencies(tx, userId, storyId, parsed.dependsOn);
    }

    return hydrate(tx, userId, {...existing, ...patch});
  });

  hub.publish(userId, {type: 'story.updated', story});
  return story;
}

/**
 * Moves a story to `status`, optionally placing it between `beforeId` and `afterId`
 * (a move within the same column is a pure reorder).
 *
 * `canTransition` is the only judge of whether the move is allowed; a refusal becomes a
 * `TransitionError` carrying its reason. An agent may additionally only move a story it
 * has claimed — the one exception being the claim itself (`todo -> in_progress`), which is
 * what takes ownership, and which is refused when another agent already holds the story or
 * when the story is still blocked by an unfinished dependency.
 *
 * Landing in `todo` from another column releases the story: the claim and the play request
 * are cleared. The stop request is deliberately *not* cleared — Stop means "parked until a
 * human presses Play", and a release is exactly when that would otherwise let an autonomous
 * agent re-claim the card on the spot (see `isClaimableBy`); `requestPlay` is what clears it.
 * Coming from `finished` or `accepted` that is rework rather than a release, so the progress
 * bar starts over too. A move from `todo` to `todo` is only a reorder of the queue and
 * clears nothing.
 *
 * More generally, a story that leaves `in_progress`/`in_test` has left the agent's hands —
 * handed over at `finished` as much as given back to `todo` — so the claim is cleared and
 * the agent holding it stops showing as working on it (`agent.updated`). Without that a
 * claim outlives the work: an agent ends up holding two stories at once, and revoking it
 * picks one of them arbitrarily.
 *
 * Every move that changes the column records a `status_change` update and publishes
 * `story.update` alongside `story.moved`, after the transaction commits. A move within one
 * column is a pure reorder: it still publishes `story.moved` so every board sees the new
 * order, but writing "moved from draft to draft" into the timeline on every drag would be
 * noise rather than history.
 */
export function moveStory(db: Database, hub: EventHub, input: MoveStoryInput): Story {
  const {userId, storyId, status, actor, agentId} = input;

  const {story, update, agent} = db.transaction(tx => {
    const existing = requireOwnedStory(tx, userId, storyId);
    const from = existing.status;

    const allowed = canTransition(from, status, actor);
    if (!allowed.ok) {
      throw new TransitionError(allowed.reason);
    }

    let claimedByAgentId = existing.claimedByAgentId;
    let author = {authorType: 'user' as StoryUpdateAuthorType, authorId: userId};
    if (actor === 'agent') {
      if (!agentId) {
        throw new TransitionError('An agent must identify itself to move a story.');
      }
      requireOwnedAgent(tx, userId, agentId);
      author = {authorType: 'agent', authorId: agentId};
      // Moving an unheld story into `in_progress` is what takes the claim — out of `todo`
      // normally, and out of `finished` when the agent picks its own handed-over work back
      // up for a fix (the claim was cleared when it handed it over).
      if (status === 'in_progress' && claimedByAgentId !== agentId) {
        if (claimedByAgentId !== null) {
          throw new TransitionError('That story is already claimed by another agent.');
        }
        // A blocked story may sit in `todo`, but no agent may pick it up — this is the one
        // enforcement point both the MCP tools and the board go through. A human moving a
        // blocked story on is a deliberate override and stays allowed.
        const {edges, statusOf} = dependencyContext(tx, userId);
        const blockers = blockedBy(storyId, edges, statusOf);
        if (blockers.length > 0) {
          throw new TransitionError(`That story is blocked by ${blockers.join(', ')} and cannot be claimed yet.`);
        }
        claimedByAgentId = agentId;
      } else if (claimedByAgentId !== agentId) {
        throw new TransitionError('Agents can only move stories they have claimed.');
      }
    }

    // Landing in `todo` from another column releases the story. A move that starts and ends
    // in `todo` is a reorder of the queue, and must leave a pending play or stop alone.
    const releasing = status === 'todo' && from !== 'todo';
    const rework = releasing && (from === 'finished' || from === 'accepted');
    // A story that leaves `in_progress`/`in_test` has left the agent's hands, whoever moved
    // it: handed over at `finished`, given back to `todo`, or pulled out by the human. The
    // claim goes with it, so a claim can never outlive the work it stands for.
    const unclaiming = releasing || (isWorkingStatus(from) && !isWorkingStatus(status));
    const patch = {
      status,
      rank: rankForMove(tx, existing, input, status),
      claimedByAgentId: unclaiming ? null : claimedByAgentId,
      // A release must not discard a pending Stop: that is the only thing that makes Stop
      // actually stop a story an autonomous agent could otherwise re-claim on the spot (see
      // `isClaimableBy`). Landing in `todo` still clears the *play* request — a stopped card
      // waits for the human to press Play again, not for the play that got interrupted.
      stopRequested: existing.stopRequested,
      playRequestedAt: releasing ? null : existing.playRequestedAt,
      progressPct: rework ? 0 : existing.progressPct,
      progressLabel: rework ? '' : existing.progressLabel,
      updatedAt: Date.now(),
    };
    tx.update(stories)
      .set(patch)
      .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
      .run();

    const storyUpdate =
      from === status
        ? null
        : insertUpdate(tx, {
            storyId,
            ...author,
            kind: 'status_change',
            body: `Moved from ${from} to ${status}`,
            progressPct: null,
          });

    // The agent that was holding it must stop showing as working on a card it no longer
    // has — including when it was a human who took the story back, which no agent-side
    // code path would ever hear about.
    const heldBy = existing.claimedByAgentId;
    const agent = unclaiming && heldBy ? clearAgentHold(tx, userId, heldBy, storyId) : null;

    return {story: hydrate(tx, userId, {...existing, ...patch}), update: storyUpdate, agent};
  });

  hub.publish(userId, {type: 'story.moved', story});
  if (update) {
    hub.publish(userId, {type: 'story.update', storyId, update});
  }
  if (agent) {
    hub.publish(userId, {type: 'agent.updated', agent});
  }
  return story;
}

/**
 * Records how far along a story is. `progressPct` must be an integer in 0..100 — anything
 * else is a `ZodError`, never a silent clamp. An omitted `label` leaves the current one in
 * place; `''` clears it. When `agentId` is given it must be one of `userId`'s agents, and
 * it must hold the claim. Appends a `progress` update and publishes `story.progress` plus
 * `story.update` after the transaction commits.
 */
export function postProgress(db: Database, hub: EventHub, input: PostProgressInput): Story {
  const {userId, storyId, agentId} = input;
  // Re-validated here rather than only in the route: the MCP server calls this directly.
  const {progressPct, label} = progressSchema.parse({progressPct: input.progressPct, label: input.label});

  const {story, update} = db.transaction(tx => {
    const existing = requireOwnedStory(tx, userId, storyId);
    if (agentId) {
      requireOwnedAgent(tx, userId, agentId);
      if (existing.claimedByAgentId !== agentId) {
        throw new TransitionError('Agents can only report progress on stories they have claimed.');
      }
    }

    // No label means "the bar moved", not "the bar lost its caption": an agent posting a
    // bare percentage keeps whatever it last said it was doing.
    const progressLabel = label ?? existing.progressLabel;
    const patch = {progressPct, progressLabel, updatedAt: Date.now()};
    tx.update(stories)
      .set(patch)
      .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
      .run();

    const storyUpdate = insertUpdate(tx, {
      storyId,
      authorType: agentId ? 'agent' : 'user',
      authorId: agentId ?? userId,
      kind: 'progress',
      body: progressLabel,
      progressPct,
    });

    return {story: hydrate(tx, userId, {...existing, ...patch}), update: storyUpdate};
  });

  hub.publish(userId, {type: 'story.progress', id: storyId, progressPct, progressLabel: story.progressLabel});
  hub.publish(userId, {type: 'story.update', storyId, update});
  return story;
}

/**
 * Appends one entry to a story's timeline — a human remark, an agent note, an error.
 * Publishes `story.update` after the transaction commits.
 */
export function addUpdate(db: Database, hub: EventHub, input: AddUpdateInput): StoryUpdate {
  const {userId, storyId, kind, authorType, authorId} = input;
  const {body} = remarkSchema.parse({body: input.body});

  const update = db.transaction(tx => {
    requireOwnedStory(tx, userId, storyId);
    return insertUpdate(tx, {storyId, authorType, authorId, kind, body, progressPct: null});
  });

  hub.publish(userId, {type: 'story.update', storyId, update});
  return update;
}

/** Sets `stopRequested`/`playRequestedAt` and publishes the resulting story. */
function setRunFlags(
  db: Database,
  hub: EventHub,
  userId: string,
  storyId: string,
  flags: {stopRequested?: boolean; playRequestedAt?: number | null},
): Story {
  const story = db.transaction(tx => {
    const existing = requireOwnedStory(tx, userId, storyId);
    const patch = {...flags, updatedAt: Date.now()};
    tx.update(stories)
      .set(patch)
      .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
      .run();
    return hydrate(tx, userId, {...existing, ...patch});
  });

  hub.publish(userId, {type: 'story.updated', story});
  return story;
}

/**
 * Queues a story for an agent. Also lifts any pending stop request — asking for the story
 * to run and asking it to stop cannot both be true, and the newer request wins.
 * Publishes `story.updated`, which is what wakes a parked `wait_for_work` long-poll.
 */
export function requestPlay(db: Database, hub: EventHub, userId: string, storyId: string): Story {
  return setRunFlags(db, hub, userId, storyId, {playRequestedAt: Date.now(), stopRequested: false});
}

/**
 * Asks the agent working on a story to stop. The flag is advisory: it reaches the agent in
 * the `control` block of its next MCP tool result, and the agent releases the story itself.
 */
export function requestStop(db: Database, hub: EventHub, userId: string, storyId: string): Story {
  return setRunFlags(db, hub, userId, storyId, {stopRequested: true});
}

/**
 * Deletes a story with its timeline and every dependency edge touching it (in either
 * direction, so stories that depended on it simply stop being blocked). Publishes
 * `story.deleted` after the transaction commits.
 */
export function deleteStory(db: Database, hub: EventHub, userId: string, storyId: string): void {
  db.transaction(tx => {
    requireOwnedStory(tx, userId, storyId);
    tx.delete(storyUpdates).where(eq(storyUpdates.storyId, storyId)).run();
    tx.delete(storyDependencies)
      .where(or(eq(storyDependencies.storyId, storyId), eq(storyDependencies.dependsOnStoryId, storyId)))
      .run();
    tx.delete(stories)
      .where(and(eq(stories.id, storyId), eq(stories.userId, userId)))
      .run();
  });

  hub.publish(userId, {type: 'story.deleted', id: storyId});
}
