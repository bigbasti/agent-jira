import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {rankBetween} from '../../shared/rank.js';
import type {Status} from '../../shared/status.js';
import type {Agent, BoardSnapshot, Project, Story, StoryUpdate} from '../../shared/types.js';
import type {ApiError} from './api.js';
import {api} from './api.js';

/**
 * The board lives under one cache key. Task 11's WebSocket hook patches this same entry,
 * which is why every mutation here edits the snapshot in place rather than keeping a
 * second copy of the stories anywhere.
 */
export const BOARD_KEY = ['board'] as const;

export interface MoveRequest {
  storyId: string;
  status: Status;
  /** The card the story lands directly below, or `null` for the top of the column. */
  beforeId: string | null;
  /** The card it lands directly above, or `null` for the bottom of the column. */
  afterId: string | null;
}

/**
 * Ranks are base-62 fractional indices, so plain string comparison orders a column.
 * Never `localeCompare` — its collation folds case and would mis-order `B` against `a`.
 */
export function byRank(a: Story, b: Story): number {
  if (a.rank === b.rank) return 0;
  return a.rank < b.rank ? -1 : 1;
}

export function useBoard() {
  return useQuery<BoardSnapshot, ApiError>({
    queryKey: BOARD_KEY,
    queryFn: () => api.get<BoardSnapshot>('/api/board'),
  });
}

/**
 * The rank the moved story takes while the request is in flight — the same rule the
 * server applies, so the optimistic order matches the one that comes back: between the
 * named neighbours, or at the end of the column when neither is still there.
 */
function optimisticRank(stories: Story[], move: MoveRequest): string | null {
  const column = stories
    .filter(story => story.status === move.status && story.id !== move.storyId)
    .sort(byRank);
  const before = column.find(story => story.id === move.beforeId);
  const after = column.find(story => story.id === move.afterId);
  const lower = before?.rank ?? (after ? null : (column.at(-1)?.rank ?? null));

  try {
    return rankBetween(lower, after?.rank ?? null);
  } catch {
    // The one empty range `rankBetween` refuses. The settle refetch sorts it out.
    return null;
  }
}

/**
 * Status and rank only. Everything else a move implies — releasing a claim, clearing a
 * pending play — is the server's rule, and guessing at it here is how a client drifts
 * out of step with the guard it does not own.
 */
function applyMove(board: BoardSnapshot, move: MoveRequest): BoardSnapshot {
  const rank = optimisticRank(board.stories, move);
  return {
    ...board,
    stories: board.stories.map(story =>
      story.id === move.storyId ? {...story, status: move.status, rank: rank ?? story.rank} : story,
    ),
  };
}

/** What a refused move needs to put back — nothing more, so nothing else is disturbed. */
interface MoveRollback {
  storyId: string;
  status: Status;
  rank: string;
}

/**
 * Optimistic: the card lands in its new column on the frame the drag ends. A refusal rolls
 * back only the moved story's `status`/`rank`, leaving the rest of the cache — including
 * whatever a second, still-in-flight drag (or, from Task 11, a WebSocket event) has since
 * written — untouched. Rolling back the whole snapshot instead would clobber that
 * concurrent write with a copy of the board that predates it.
 *
 * The reason a refusal failed lands on `error.message`, which is the sentence the board
 * puts in its toast.
 */
export function useMoveStory() {
  const client = useQueryClient();

  return useMutation<Story, ApiError, MoveRequest, MoveRollback | undefined>({
    mutationFn: ({storyId, status, beforeId, afterId}) =>
      api.post<Story>(`/api/stories/${encodeURIComponent(storyId)}/move`, {status, beforeId, afterId}),
    onMutate: async move => {
      // Stop an in-flight board load from landing on top of the patch we are about to make.
      await client.cancelQueries({queryKey: BOARD_KEY});
      const board = client.getQueryData<BoardSnapshot>(BOARD_KEY);
      const story = board?.stories.find(candidate => candidate.id === move.storyId);
      if (board) client.setQueryData(BOARD_KEY, applyMove(board, move));
      return story && {storyId: story.id, status: story.status, rank: story.rank};
    },
    onError: (_error, _move, rollback) => {
      if (!rollback) return;
      client.setQueryData<BoardSnapshot>(BOARD_KEY, board =>
        board
          ? {
              ...board,
              stories: board.stories.map(story =>
                story.id === rollback.storyId ? {...story, status: rollback.status, rank: rollback.rank} : story,
              ),
            }
          : board,
      );
    },
    // A move can change what blocks other stories, so the whole snapshot is refetched
    // rather than only the story the server echoed back.
    onSettled: () => client.invalidateQueries({queryKey: BOARD_KEY}),
  });
}

/**
 * Asks for a story to be picked up next: `POST /api/stories/:id/play`. The server sets
 * `playRequestedAt` and publishes `story.updated`; the card reads that field itself to
 * show a "queued" state until an agent claims the story (or the server clears it again).
 */
export function usePlayStory() {
  const client = useQueryClient();
  return useMutation<Story, ApiError, string>({
    mutationFn: id => api.post<Story>(`/api/stories/${encodeURIComponent(id)}/play`),
    onSuccess: story => upsertStory(client, story),
  });
}

/**
 * Asks the agent working on a story to stop: `POST /api/stories/:id/stop`. The server
 * sets `stopRequested`; the card shows "stopping…" until the agent releases or moves the
 * story on, both of which clear the flag server-side and arrive back through this same
 * patch (here, or over the live socket for another tab).
 */
export function useStopStory() {
  const client = useQueryClient();
  return useMutation<Story, ApiError, string>({
    mutationFn: id => api.post<Story>(`/api/stories/${encodeURIComponent(id)}/stop`),
    onSuccess: story => upsertStory(client, story),
  });
}

export interface StoryFormInput {
  title: string;
  projectId: string;
  model: string;
  description: string;
  dependsOn: string[];
}

/**
 * Patches one story into the cached board snapshot, replacing it if already present.
 * Exported so `useLiveBoard` (Task 11) can apply `story.created`/`story.updated`/
 * `story.moved` events through the exact same surgical patch the mutations use.
 */
export function upsertStory(client: ReturnType<typeof useQueryClient>, story: Story): void {
  client.setQueryData<BoardSnapshot>(BOARD_KEY, board => {
    if (!board) return board;
    const exists = board.stories.some(candidate => candidate.id === story.id);
    return {
      ...board,
      stories: exists
        ? board.stories.map(candidate => (candidate.id === story.id ? story : candidate))
        : [...board.stories, story],
    };
  });
}

/**
 * Patches one agent into the cached board snapshot, replacing it if already present.
 * Exported so both `useLiveBoard` (`agent.updated`) and agent-management mutations apply
 * the exact same surgical patch.
 */
export function upsertAgent(client: ReturnType<typeof useQueryClient>, agent: Agent): void {
  client.setQueryData<BoardSnapshot>(BOARD_KEY, board => {
    if (!board) return board;
    const exists = board.agents.some(candidate => candidate.id === agent.id);
    return {
      ...board,
      agents: exists
        ? board.agents.map(candidate => (candidate.id === agent.id ? agent : candidate))
        : [...board.agents, agent],
    };
  });
}

/** Creates a story (always landing in `draft`) and adds it to the cached board. */
export function useCreateStory() {
  const client = useQueryClient();
  return useMutation<Story, ApiError, StoryFormInput>({
    mutationFn: input => api.post<Story>('/api/stories', input),
    onSuccess: story => upsertStory(client, story),
  });
}

/** Saves a story's editable fields and updates it in the cached board. */
export function useUpdateStory() {
  const client = useQueryClient();
  return useMutation<Story, ApiError, StoryFormInput & {id: string}>({
    mutationFn: ({id, ...patch}) => api.patch<Story>(`/api/stories/${encodeURIComponent(id)}`, patch),
    onSuccess: story => upsertStory(client, story),
  });
}

/** Deletes a story and drops it from the cached board. */
export function useDeleteStory() {
  const client = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: id => api.del(`/api/stories/${encodeURIComponent(id)}`),
    onSuccess: (_result, id) => {
      client.setQueryData<BoardSnapshot>(BOARD_KEY, board =>
        board ? {...board, stories: board.stories.filter(story => story.id !== id)} : board,
      );
    },
  });
}

export interface CreateProjectInput {
  name: string;
  path: string;
}

/** Creates a project and adds it to the cached board's project list. */
export function useCreateProject() {
  const client = useQueryClient();
  return useMutation<Project, ApiError, CreateProjectInput>({
    mutationFn: input => api.post<Project>('/api/projects', input),
    onSuccess: project => {
      client.setQueryData<BoardSnapshot>(BOARD_KEY, board =>
        board ? {...board, projects: [...board.projects, project]} : board,
      );
    },
  });
}

export const storyUpdatesKey = (storyId: string) => ['storyUpdates', storyId] as const;

/** A story's timeline, oldest first — exactly what the server returns, unsorted again here. */
export function useStoryUpdates(storyId: string, enabled = true) {
  return useQuery<StoryUpdate[], ApiError>({
    queryKey: storyUpdatesKey(storyId),
    queryFn: () => api.get<StoryUpdate[]>(`/api/stories/${encodeURIComponent(storyId)}/updates`),
    enabled,
  });
}

/** Posts a human remark and appends it to that story's cached timeline. */
export function useAddRemark(storyId: string) {
  const client = useQueryClient();
  return useMutation<StoryUpdate, ApiError, string>({
    mutationFn: body => api.post<StoryUpdate>(`/api/stories/${encodeURIComponent(storyId)}/updates`, {body}),
    onSuccess: update => {
      client.setQueryData<StoryUpdate[]>(storyUpdatesKey(storyId), (updates = []) => [...updates, update]);
    },
  });
}
