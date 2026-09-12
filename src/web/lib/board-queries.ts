import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {rankBetween} from '../../shared/rank.js';
import type {Status} from '../../shared/status.js';
import type {BoardSnapshot, Story} from '../../shared/types.js';
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

/**
 * Optimistic: the card lands in its new column on the frame the drag ends. A refusal
 * rolls the whole snapshot back and leaves the server's reason on `error.message`, which
 * is the sentence the board puts in its toast.
 */
export function useMoveStory() {
  const client = useQueryClient();

  return useMutation<Story, ApiError, MoveRequest, {previous: BoardSnapshot | undefined}>({
    mutationFn: ({storyId, status, beforeId, afterId}) =>
      api.post<Story>(`/api/stories/${encodeURIComponent(storyId)}/move`, {status, beforeId, afterId}),
    onMutate: async move => {
      // Stop an in-flight board load from landing on top of the patch we are about to make.
      await client.cancelQueries({queryKey: BOARD_KEY});
      const previous = client.getQueryData<BoardSnapshot>(BOARD_KEY);
      if (previous) client.setQueryData(BOARD_KEY, applyMove(previous, move));
      return {previous};
    },
    onError: (_error, _move, context) => {
      if (context?.previous) client.setQueryData(BOARD_KEY, context.previous);
    },
    // A move can change what blocks other stories, so the whole snapshot is refetched
    // rather than only the story the server echoed back.
    onSettled: () => client.invalidateQueries({queryKey: BOARD_KEY}),
  });
}
