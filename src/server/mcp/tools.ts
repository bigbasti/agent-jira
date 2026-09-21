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
import {controlBlock, emptyControl, findOwnedAgent, updateAgent, type ControlBlock} from './control.js';
import {STATUSES} from '../../shared/status.js';
import type {Project, ServerEvent, Story} from '../../shared/types.js';

/** The shape of the server log a tool needs — satisfied by Fastify's logger. */
export interface McpLogger {
  error(payload: {err: unknown}, message: string): void;
}

/** Everything a tool needs: the database, the hub, and who is calling. */
export interface McpContext {
  db: Database;
  hub: EventHub;
  /** The owner of the board, taken from the bearer token — never from an argument. */
  userId: string;
  /** The agent the bearer token belongs to. */
  agentId: string;
  /** Where an unexpected failure is recorded, since the agent is told nothing about it. */
  log?: McpLogger;
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
 * Maps a failure onto a small, stable vocabulary the agent can act on.
 *
 * Anything the service layer does not model — a locked database, a constraint nobody
 * expected — becomes one `internal_error` with a fixed sentence, and the real error goes
 * to the server log. An agent can do nothing useful with `SQLITE_BUSY: database is
 * locked`, and a raw driver message is exactly the kind of text that carries table names
 * and paths into a transcript.
 */
function describeError(err: unknown, log?: McpLogger): {error: string; message: string} {
  if (err instanceof z.ZodError) {
    const issues = err.issues.map(issue =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    );
    return {error: 'invalid_request', message: issues.join('; ')};
  }
  if (err instanceof ValidationError) return {error: 'invalid_request', message: err.message};
  if (err instanceof NotFoundError) return {error: 'not_found', message: err.message};
  if (err instanceof TransitionError) return {error: 'transition_refused', message: err.message};

  log?.error({err}, 'mcp tool failed unexpectedly');
  return {error: 'internal_error', message: 'Something went wrong on the board server. Try again.'};
}

function textResult(payload: Record<string, unknown>, control: ControlBlock, isError: boolean): CallToolResult {
  return {content: [{type: 'text', text: JSON.stringify({...payload, control})}], isError};
}

/**
 * Runs one tool and wraps the answer.
 *
 * The control block is attached to failures too: a stop request or a remark must still
 * reach the agent when the call it was attached to was refused, otherwise a stopping
 * agent that happens to make one bad call keeps working. That is also why the advertised
 * `inputSchema` marks every field optional and the real contract is the `*Args` schema
 * parsed inside `work()`: the SDK validates `inputSchema` *before* the handler runs and
 * answers a violation with a plain-text error of its own, which would never reach this
 * function and could not carry a control block — nor be parsed as JSON by an agent that
 * every other result has taught to parse.
 */
async function respond(
  ctx: McpContext,
  fallbackStoryId: string | undefined,
  work: () => ToolOutcome | Promise<ToolOutcome>,
): Promise<CallToolResult> {
  try {
    const outcome = await work();
    const storyId = outcome.storyId === undefined ? fallbackStoryId : outcome.storyId;
    return textResult(outcome.payload, safeControl(ctx, storyId), false);
  } catch (err) {
    const described = describeError(err, ctx.log);
    return textResult(described, safeControl(ctx, fallbackStoryId), true);
  }
}

/**
 * The control block, or an empty one if building it fails.
 *
 * Reading the control block touches the database, so it can fail for the same reasons the
 * tool itself can. Letting that escape would take the whole result with it — the agent
 * would get a raw driver message instead of JSON, on the success path even though the
 * mutation had already happened. The failure goes to the log; the agent gets a result it
 * can parse.
 */
function safeControl(ctx: McpContext, storyId: string | null | undefined): ControlBlock {
  try {
    return controlBlock(ctx.db, {...identity(ctx), storyId});
  } catch (err) {
    ctx.log?.error({err}, 'mcp control block could not be built');
    return emptyControl();
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

/**
 * Resolves as soon as `promise` settles or `signal` aborts, whichever comes first.
 *
 * On an abort the answer is `null` — the same "nothing happened" a timeout produces, so
 * the caller unwinds through its normal path. The underlying wait is left to finish on
 * its own (the hub has no cancellation, and it cleans itself up on every exit), but
 * nothing is blocked on it any more.
 */
function untilAborted<T>(promise: Promise<T | null>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);

  return new Promise(resolve => {
    const onAbort = (): void => resolve(null);
    signal.addEventListener('abort', onAbort, {once: true});
    void promise
      .then(value => resolve(value))
      .catch(() => resolve(null))
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
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

/*
 * Two layers, on purpose.
 *
 * `advertised*` is what the client sees as the tool's JSON schema: the right types, so an
 * agent knows what to send, but every field `.optional().catch(undefined)` so that a
 * missing, empty or wrongly-typed one is refused by the handler rather than by the SDK's
 * pre-handler validation — which cannot carry a control block (see `respond`). `.catch`
 * does not change the advertised type (the JSON schema still says `integer`, `string`,
 * enum); it only means a value that does not match is handed on as absent, so the `*Args`
 * schema below — the real contract — is what answers. Required-ness is stated in every
 * description and enforced there.
 */
const advertisedStoryId = z.string().optional().catch(undefined).describe('Required. The id of the story.');

/**
 * Says what an *absent* field should say, while leaving every other issue on that field to
 * its own message. (A bare string as Zod's first argument would claim "reason is required"
 * about a reason that was supplied but empty, and "progressPct is required" about a
 * progressPct of 150 — the agent would then fix the wrong thing.)
 *
 * These messages also have to work for a value of the wrong type: `.catch(undefined)` on
 * the advertised schema turns one into an absent field (see below), so each says what to
 * send rather than only that something is missing.
 */
const absent = (message: string) => ({
  error: (issue: {input: unknown}) => (issue.input === undefined ? message : undefined),
});

const requiredStoryId = z
  .string(absent('storyId is required, as the id of the story.'))
  .trim()
  .min(1, 'storyId must not be empty.');

const getStoryArgs = z.object({storyId: requiredStoryId});
const claimArgs = z.object({storyId: z.string().trim().min(1).optional()});
const waitArgs = z.object({timeoutSeconds: z.number().int().optional()});
const moveArgs = z.object({
  storyId: requiredStoryId,
  status: z.enum(STATUSES, absent(`status is required, and must be one of: ${STATUSES.join(', ')}.`)),
  reason: z
    .string(absent('A reason is required, as a string: the human reads these transitions as your status report.'))
    .trim()
    .min(1, 'The reason must not be empty: the human reads these transitions as your status report.'),
});
const progressArgs = z.object({
  storyId: requiredStoryId,
  progressPct: z
    .number(absent('progressPct is required, as a whole number between 0 and 100.'))
    .int('progressPct must be a whole number between 0 and 100.')
    .min(0, 'progressPct must be between 0 and 100.')
    .max(100, 'progressPct must be between 0 and 100.'),
  label: z
    .string(absent('A label is required, as a short string: it is the caption on the progress bar.'))
    .trim()
    .min(1, 'The label must not be empty: it is the caption on the progress bar.'),
});
const updateArgs = z.object({
  storyId: requiredStoryId,
  body: z
    .string(absent('A body is required, as a string: what you want to tell your human.'))
    .trim()
    .min(1, 'The body must not be empty.'),
  kind: z.enum(['note', 'error']).optional(),
});
const releaseArgs = z.object({
  storyId: requiredStoryId,
  reason: z
    .string(absent('A reason is required: it is recorded on the story.'))
    .trim()
    .min(1, 'The reason must not be empty: it is recorded on the story.'),
});
const modeArgs = z.object({autonomous: z.boolean(absent('autonomous is required: true or false.'))});

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
      inputSchema: {storyId: advertisedStoryId},
    },
    async args =>
      respond(ctx, args.storyId, () => {
        const {storyId} = getStoryArgs.parse(args);
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
          .catch(undefined)
          .describe('How long to wait, in seconds. Clamped to 1..55. Defaults to 55.'),
      },
    },
    async (args, extra) =>
      respond(ctx, undefined, () => waitForWork(ctx, waitArgs.parse(args).timeoutSeconds, extra.signal)),
  );

  server.registerTool(
    'claim_next_story',
    {
      title: 'Claim the next story',
      description:
        'Claims a story and moves it to `in_progress`. With no argument it takes the top unblocked story in `todo`, skipping blocked ones; with `storyId` it claims that story, which is refused if it is blocked or already held by another agent. The result carries the story and its project: work only inside that `project.path`. You may hold only one story at a time — finish or `release_story` the one you have first. Between two stories, clear your context with `/clear` — and only claim another story unattended when `control.autonomous` is true.',
      inputSchema: {
        storyId: z
          .string()
          .optional()
          .catch(undefined)
          .describe('Claim this story instead of the next one in `todo`.'),
      },
    },
    async args => respond(ctx, args.storyId, () => claimStory(ctx, claimArgs.parse(args).storyId)),
  );

  server.registerTool(
    'move_story',
    {
      title: 'Move a story',
      description:
        'Moves a story you hold to another column and records why. Move through every state and never skip one: `in_progress` while you build, `in_test` while you verify, back to `in_progress` when a test fails, `finished` only once verification passed. Never move a story to `accepted` — only your human accepts work. The `reason` is required and is read by a person: it is your status report.',
      inputSchema: {
        storyId: advertisedStoryId,
        status: z
          .enum(STATUSES)
          .optional()
          .catch(undefined)
          .describe('Required. The column to move the story into. `accepted` is refused.'),
        reason: z
          .string()
          .optional()
          .catch(undefined)
          .describe('Required. Why you are making this move, in one or two human-readable sentences.'),
      },
    },
    async args =>
      respond(ctx, args.storyId, () => {
        const {storyId, status, reason} = moveArgs.parse(args);
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
        storyId: advertisedStoryId,
        progressPct: z
          .number()
          .int()
          .optional()
          .catch(undefined)
          .describe('Required. How far along the story is, 0..100.'),
        label: z
          .string()
          .optional()
          .catch(undefined)
          .describe('Required. A short human-readable label for what you are doing right now.'),
      },
    },
    async args =>
      respond(ctx, args.storyId, () => {
        const {storyId, progressPct, label} = progressArgs.parse(args);
        return {
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
        };
      }),
  );

  server.registerTool(
    'post_update',
    {
      title: 'Post an update',
      description:
        'Appends a note to the story’s timeline — a decision you took, something you found, a problem you hit, or what you had completed when you were asked to stop. Use `kind: "error"` for a failure. This is how you talk to your human; it does not move the story.',
      inputSchema: {
        storyId: advertisedStoryId,
        body: z.string().optional().catch(undefined).describe('Required. What you want to tell your human.'),
        kind: z
          .enum(['note', 'error'])
          .optional()
          .catch(undefined)
          .describe('`note` (default) or `error` for a failure.'),
      },
    },
    async args =>
      respond(ctx, args.storyId, () => {
        const {storyId, body, kind} = updateArgs.parse(args);
        return {
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
        };
      }),
  );

  server.registerTool(
    'release_story',
    {
      title: 'Release a story',
      description:
        'Gives a story back: it returns to `todo`, unclaimed, keeping its timeline. Call this when `control.stop_requested` is true — post what you completed first, then release and stop — or when you genuinely cannot continue. The `reason` is required and is recorded on the story.',
      inputSchema: {
        storyId: advertisedStoryId,
        reason: z.string().optional().catch(undefined).describe('Required. Why you are giving the story back.'),
      },
    },
    async args =>
      respond(ctx, args.storyId, () => {
        const {storyId, reason} = releaseArgs.parse(args);
        // The move goes first: a release the service refuses must not leave a note
        // behind on a story this agent does not hold.
        const story = moveStory(ctx.db, ctx.hub, {
          userId: ctx.userId,
          storyId,
          status: 'todo',
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
      inputSchema: {
        autonomous: z
          .boolean()
          .optional()
          .catch(undefined)
          .describe('Required. True to claim work unattended, false to ask first.'),
      },
    },
    async args =>
      respond(ctx, undefined, () => {
        const {autonomous} = modeArgs.parse(args);
        const agent = updateAgent(ctx.db, ctx.hub, identity(ctx), {autonomous});
        if (!agent) throw new NotFoundError('Agent not found');
        return {payload: {agent}};
      }),
  );
}

/**
 * The story this agent is actually mid-way through, if any — still held by it and still
 * in a working column. A story it left in `finished` does not count: handing work over
 * for review is exactly when an autonomous agent goes looking for the next story.
 */
function storyInHand(ctx: McpContext): Story | undefined {
  const agent = findOwnedAgent(ctx.db, ctx.userId, ctx.agentId);
  if (!agent?.currentStoryId) return undefined;

  const story = listStories(ctx.db, ctx.userId).find(candidate => candidate.id === agent.currentStoryId);
  if (!story || story.claimedByAgentId !== ctx.agentId) return undefined;
  return story.status === 'in_progress' || story.status === 'in_test' ? story : undefined;
}

/** `claim_next_story`: takes the named story, or the top unblocked card in `todo`. */
function claimStory(ctx: McpContext, storyId?: string): ToolOutcome {
  // Claiming a second story would quietly abandon the first one: it would sit in
  // `in_progress` with nobody working on it, and the human would have no way to tell.
  const inHand = storyInHand(ctx);
  if (inHand && inHand.id !== storyId) {
    throw new TransitionError(
      `You are already working on "${inHand.title}" (${inHand.id}, ${inHand.status}). Finish it or call release_story before claiming another story.`,
    );
  }

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
 * `working` or `idle` afterwards however the wait ended — the hub closing on shutdown, the
 * timeout, or the client hanging up. That last one is `signal`: the SDK aborts in-flight
 * handlers when the connection closes, and without honouring it the agent would keep
 * showing as `waiting` for the rest of the timeout after nobody was listening any more.
 */
async function waitForWork(ctx: McpContext, timeoutSeconds?: number, signal?: AbortSignal): Promise<ToolOutcome> {
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
    while (remaining > 0 && !signal?.aborted) {
      const event = await untilAborted(ctx.hub.waitFor(ctx.userId, isWorkEvent, remaining), signal);
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
