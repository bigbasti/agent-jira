import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import type {Database} from '../db/index.js';
import type {EventHub} from '../events/hub.js';
import {getBoard} from '../services/board.js';
import {NotFoundError, listProjects} from '../services/projects.js';
import {
  TransitionError,
  ValidationError,
  addUpdate,
  getStory,
  listStories,
  listUpdates,
  moveStory,
  postProgress,
} from '../services/stories.js';
import {controlBlock, findOwnedAgent, updateAgent, type ControlBlock} from './control.js';
import {STATUSES} from '../../shared/status.js';
import type {Project, ServerEvent, Story} from '../../shared/types.js';

/** Everything a tool needs: the database, the hub, and who is calling. */
export interface McpContext {
  db: Database;
  hub: EventHub;
  /** The owner of the board, taken from the bearer token — never from an argument. */
  userId: string;
  /** The agent the bearer token belongs to. */
  agentId: string;
}

/**
 * The longest a `wait_for_work` long-poll may park. Kept under a minute so the HTTP
 * response comes back before the typical client, proxy or load balancer idle timeout
 * decides the request is dead.
 */
export const MAX_WAIT_SECONDS = 55;

/** Clamps a requested long-poll timeout into 1..55 seconds; the default is the maximum. */
export function clampTimeoutSeconds(seconds?: number): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return MAX_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.floor(seconds)));
}

/** What a tool handler produces: the payload, and which story the control block is about. */
interface ToolOutcome {
  payload: Record<string, unknown>;
  storyId?: string | null;
}

/**
 * Maps the service layer's typed errors onto a small, stable vocabulary. Anything else is
 * rethrown, so an unexpected failure is not dressed up as a clean refusal.
 */
function describeError(err: unknown): {error: string; message: string} {
  if (err instanceof z.ZodError) {
    const issues = err.issues.map(issue => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
    return {error: 'invalid_request', message: issues.join('; ')};
  }
  if (err instanceof ValidationError) return {error: 'invalid_request', message: err.message};
  if (err instanceof NotFoundError) return {error: 'not_found', message: err.message};
  if (err instanceof TransitionError) return {error: 'transition_refused', message: err.message};
  throw err;
}

function textResult(payload: Record<string, unknown>, control: ControlBlock, isError: boolean): CallToolResult {
  return {content: [{type: 'text', text: JSON.stringify({...payload, control})}], isError};
}

/**
 * Runs one tool and wraps the answer.
 *
 * The control block is attached to failures too: a stop request or a remark must still
 * reach the agent when the call it was attached to was refused, otherwise a stopping
 * agent that happens to make one bad call keeps working.
 */
async function respond(
  ctx: McpContext,
  fallbackStoryId: string | undefined,
  work: () => ToolOutcome | Promise<ToolOutcome>,
): Promise<CallToolResult> {
  try {
    const outcome = await work();
    const storyId = outcome.storyId === undefined ? fallbackStoryId : outcome.storyId;
    return textResult(outcome.payload, controlBlock(ctx.db, {...identity(ctx), storyId}), false);
  } catch (err) {
    const described = describeError(err);
    return textResult(described, controlBlock(ctx.db, {...identity(ctx), storyId: fallbackStoryId}), true);
  }
}

function identity(ctx: McpContext): {userId: string; agentId: string} {
  return {userId: ctx.userId, agentId: ctx.agentId};
}

function projectOf(ctx: McpContext, story: Story): Project | undefined {
  return listProjects(ctx.db, ctx.userId).find(project => project.id === story.projectId);
}

/**
 * The stories an agent may claim right now: waiting in `todo`, not blocked by an
 * unfinished dependency, and not held by another agent. Rank order, so the first one is
 * the top card of the column — the one the human put at the top on purpose.
 */
function claimableStories(ctx: McpContext): Story[] {
  return listStories(ctx.db, ctx.userId).filter(
    story =>
      story.status === 'todo' &&
      story.blockedBy.length === 0 &&
      (story.claimedByAgentId === null || story.claimedByAgentId === ctx.agentId),
  );
}

function nextClaimable(ctx: McpContext): Story | undefined {
  return claimableStories(ctx)[0];
}

/** Events that can change whether there is work to pick up. */
function isWorkEvent(event: ServerEvent): boolean {
  return event.type === 'story.moved' || event.type === 'story.updated';
}

/** Puts the agent back into the status its held story implies once a wait is over. */
function restoreAgentStatus(ctx: McpContext): void {
  const agent = findOwnedAgent(ctx.db, ctx.userId, ctx.agentId);
  if (!agent) return;
  updateAgent(ctx.db, ctx.hub, identity(ctx), {status: agent.currentStoryId ? 'working' : 'idle'});
}

/**
 * Releases the agent's hold on a story when a move gave it up — a move into `todo`
 * clears the claim in the service, and the agent strip must not keep showing the agent
 * as working on a card it no longer owns.
 */
function syncClaim(ctx: McpContext, story: Story): void {
  const agent = findOwnedAgent(ctx.db, ctx.userId, ctx.agentId);
  if (!agent || agent.currentStoryId !== story.id) return;
  if (story.claimedByAgentId === ctx.agentId) return;
  updateAgent(ctx.db, ctx.hub, identity(ctx), {currentStoryId: null, status: 'idle'});
}

const storyIdArg = z.string().trim().min(1).describe('The id of the story.');

/** Registers every tool an agent may call. This list is the whole agent-facing API. */
export function registerTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'get_board',
    {
      title: 'Get the board',
      description:
        'Returns the whole board: the six columns in order, every story with its status, rank, progress and blockers, the projects, and the agents. Read-only. Like every tool, the result carries a `control` block — check `control.stop_requested` and `control.remarks` on every call.',
      inputSchema: {},
    },
    async () => respond(ctx, undefined, () => ({payload: {board: getBoard(ctx.db, ctx.userId)}})),
  );

  server.registerTool(
    'get_story',
    {
      title: 'Get a story',
      description:
        'Returns one story with the project it belongs to (including the `project.path` you must work inside) and its full timeline of updates — progress, notes, status changes and the human’s remarks.',
      inputSchema: {storyId: storyIdArg},
    },
    async ({storyId}) =>
      respond(ctx, storyId, () => {
        const story = getStory(ctx.db, ctx.userId, storyId);
        return {
          payload: {
            story,
            project: projectOf(ctx, story) ?? null,
            updates: listUpdates(ctx.db, ctx.userId, storyId),
          },
          storyId,
        };
      }),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'Lists your human’s projects and their absolute paths. You may only work inside the `path` of the project belonging to the story you have claimed.',
      inputSchema: {},
    },
    async () => respond(ctx, undefined, () => ({payload: {projects: listProjects(ctx.db, ctx.userId)}})),
  );

  server.registerTool(
    'wait_for_work',
    {
      title: 'Wait for work',
      description:
        'Parks until a story is waiting for you in `todo`, then returns it — call this when you have nothing to do instead of polling. Returns immediately if a story is already waiting. `timeoutSeconds` is clamped to 55; when it expires the result is `{work: false}` and you may simply call it again. Claim the story it returns with `claim_next_story`.',
      inputSchema: {
        timeoutSeconds: z
          .number()
          .int()
          .optional()
          .describe('How long to wait, in seconds. Clamped to 1..55. Defaults to 55.'),
      },
    },
    async ({timeoutSeconds}) => respond(ctx, undefined, () => waitForWork(ctx, timeoutSeconds)),
  );

  server.registerTool(
    'claim_next_story',
    {
      title: 'Claim the next story',
      description:
        'Claims a story and moves it to `in_progress`. With no argument it takes the top unblocked story in `todo`, skipping blocked ones; with `storyId` it claims that story, which is refused if it is blocked or already held by another agent. The result carries the story and its project: work only inside that `project.path`. Between two stories, clear your context with `/clear` first — and only claim another story unattended when `control.autonomous` is true.',
      inputSchema: {
        storyId: z.string().trim().min(1).optional().describe('Claim this story instead of the next one in `todo`.'),
      },
    },
    async ({storyId}) => respond(ctx, storyId, () => claimStory(ctx, storyId)),
  );

  server.registerTool(
    'move_story',
    {
      title: 'Move a story',
      description:
        'Moves a story you hold to another column and records why. Move through every state and never skip one: `in_progress` while you build, `in_test` while you verify, back to `in_progress` when a test fails, `finished` only once verification passed. Never move a story to `accepted` — only your human accepts work. The `reason` is required and is read by a person: it is your status report.',
      inputSchema: {
        storyId: storyIdArg,
        status: z.enum(STATUSES).describe('The column to move the story into. `accepted` is refused.'),
        reason: z
          .string()
          .trim()
          .min(1)
          .describe('Why you are making this move, in one or two human-readable sentences.'),
      },
    },
    async ({storyId, status, reason}) =>
      respond(ctx, storyId, () => {
        const story = moveStory(ctx.db, ctx.hub, {
          userId: ctx.userId,
          storyId,
          status,
          actor: 'agent',
          agentId: ctx.agentId,
        });
        addUpdate(ctx.db, ctx.hub, {
          userId: ctx.userId,
          storyId,
          body: reason,
          kind: 'note',
          authorType: 'agent',
          authorId: ctx.agentId,
        });
        syncClaim(ctx, story);
        return {payload: {story}, storyId};
      }),
  );

  server.registerTool(
    'post_progress',
    {
      title: 'Post progress',
      description:
        'Updates the story’s progress bar. Call this at every meaningful step with an honest percentage and a short human-readable label such as "writing the failing test" — the label and the bar are what your human watches instead of your terminal.',
      inputSchema: {
        storyId: storyIdArg,
        progressPct: z.number().int().min(0).max(100).describe('How far along the story is, 0..100.'),
        label: z.string().trim().min(1).describe('A short human-readable label for what you are doing right now.'),
      },
    },
    async ({storyId, progressPct, label}) =>
      respond(ctx, storyId, () => ({
        payload: {
          story: postProgress(ctx.db, ctx.hub, {
            userId: ctx.userId,
            storyId,
            progressPct,
            label,
            agentId: ctx.agentId,
          }),
        },
        storyId,
      })),
  );

  server.registerTool(
    'post_update',
    {
      title: 'Post an update',
      description:
        'Appends a note to the story’s timeline — a decision you took, something you found, a problem you hit, or what you had completed when you were asked to stop. Use `kind: "error"` for a failure. This is how you talk to your human; it does not move the story.',
      inputSchema: {
        storyId: storyIdArg,
        body: z.string().trim().min(1).describe('What you want to tell your human.'),
        kind: z.enum(['note', 'error']).optional().describe('`note` (default) or `error` for a failure.'),
      },
    },
    async ({storyId, body, kind}) =>
      respond(ctx, storyId, () => ({
        payload: {
          update: addUpdate(ctx.db, ctx.hub, {
            userId: ctx.userId,
            storyId,
            body,
            kind: kind ?? 'note',
            authorType: 'agent',
            authorId: ctx.agentId,
          }),
        },
        storyId,
      })),
  );

  server.registerTool(
    'release_story',
    {
      title: 'Release a story',
      description:
        'Gives a story back: it returns to `todo`, unclaimed, keeping its timeline. Call this when `control.stop_requested` is true — post what you completed first, then release and stop — or when you genuinely cannot continue. The `reason` is required and is recorded on the story.',
      inputSchema: {
        storyId: storyIdArg,
        reason: z.string().trim().min(1).describe('Why you are giving the story back.'),
      },
    },
    async ({storyId, reason}) =>
      respond(ctx, storyId, () => {
        addUpdate(ctx.db, ctx.hub, {
          userId: ctx.userId,
          storyId,
          body: reason,
          kind: 'note',
          authorType: 'agent',
          authorId: ctx.agentId,
        });
        const story = moveStory(ctx.db, ctx.hub, {
          userId: ctx.userId,
          storyId,
          status: 'todo',
          actor: 'agent',
          agentId: ctx.agentId,
        });
        updateAgent(ctx.db, ctx.hub, identity(ctx), {currentStoryId: null, status: 'idle'});
        return {payload: {story}, storyId};
      }),
  );

  server.registerTool(
    'set_agent_mode',
    {
      title: 'Set agent mode',
      description:
        'Turns autonomous mode on or off for you. Autonomous means you may claim the next story yourself after a `/clear`; otherwise you ask your human first. The current value is in `control.autonomous` on every tool result. Only change this when your human asks you to.',
      inputSchema: {autonomous: z.boolean().describe('True to claim work unattended, false to ask first.')},
    },
    async ({autonomous}) =>
      respond(ctx, undefined, () => {
        const agent = updateAgent(ctx.db, ctx.hub, identity(ctx), {autonomous});
        if (!agent) throw new NotFoundError('Agent not found');
        return {payload: {agent}};
      }),
  );
}

/** `claim_next_story`: takes the named story, or the top unblocked card in `todo`. */
function claimStory(ctx: McpContext, storyId?: string): ToolOutcome {
  const targetId = storyId ?? nextClaimable(ctx)?.id;
  if (!targetId) {
    return {
      payload: {
        claimed: false,
        story: null,
        reason: 'No unblocked story is waiting in todo. Call wait_for_work to park until one is.',
      },
      storyId: null,
    };
  }

  const story = moveStory(ctx.db, ctx.hub, {
    userId: ctx.userId,
    storyId: targetId,
    status: 'in_progress',
    actor: 'agent',
    agentId: ctx.agentId,
  });
  updateAgent(ctx.db, ctx.hub, identity(ctx), {currentStoryId: story.id, status: 'working'});

  return {payload: {claimed: true, story, project: projectOf(ctx, story) ?? null}, storyId: story.id};
}

/**
 * `wait_for_work`: the long-poll.
 *
 * Checks for a claimable story first, so an agent that asks while work is already waiting
 * is answered immediately rather than after a full timeout. Otherwise it parks on the
 * hub, and re-checks on each event: a board event does not necessarily mean *this* agent
 * has something to do (the story may be blocked, or someone else's), so a wake-up that
 * finds nothing goes back to waiting for what is left of the timeout rather than
 * returning "no work" early.
 *
 * The agent shows as `waiting` on the board for as long as it is parked, and goes back to
 * `working` or `idle` afterwards however the wait ended — including when the hub is
 * closed on shutdown, which resolves the wait with no event.
 */
async function waitForWork(ctx: McpContext, timeoutSeconds?: number): Promise<ToolOutcome> {
  const seconds = clampTimeoutSeconds(timeoutSeconds);
  const found = (story: Story): ToolOutcome => ({
    payload: {work: true, story, project: projectOf(ctx, story) ?? null},
    storyId: story.id,
  });

  const ready = nextClaimable(ctx);
  if (ready) return found(ready);

  const deadline = Date.now() + seconds * 1000;
  updateAgent(ctx.db, ctx.hub, identity(ctx), {status: 'waiting'});
  try {
    let remaining = deadline - Date.now();
    while (remaining > 0) {
      const event = await ctx.hub.waitFor(ctx.userId, isWorkEvent, remaining);
      if (!event) break;

      const story = nextClaimable(ctx);
      if (story) return found(story);
      remaining = deadline - Date.now();
    }

    return {
      payload: {
        work: false,
        story: null,
        reason: `No story became claimable within ${seconds} seconds. Call wait_for_work again to keep waiting.`,
      },
      storyId: null,
    };
  } finally {
    restoreAgentStatus(ctx);
  }
}
