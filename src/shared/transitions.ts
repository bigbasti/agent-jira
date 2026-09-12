import type {Status} from './status.js';

export type Actor = 'user' | 'agent';

export type TransitionResult = {ok: true} | {ok: false; reason: string};

const ALLOWED: Record<Status, Partial<Record<Status, Actor[]>>> = {
  draft: {todo: ['user']},
  todo: {draft: ['user'], in_progress: ['user', 'agent']},
  in_progress: {in_test: ['user', 'agent'], todo: ['user', 'agent'], draft: ['user']},
  in_test: {in_progress: ['user', 'agent'], finished: ['user', 'agent'], todo: ['user', 'agent']},
  finished: {accepted: ['user'], todo: ['user'], in_progress: ['user', 'agent']},
  accepted: {todo: ['user'], finished: ['user']},
};

export function canTransition(from: Status, to: Status, actor: Actor): TransitionResult {
  if (from === to) {
    // Same-status moves are reordering within a column — always allowed.
    return {ok: true};
  }

  const allowedActors = ALLOWED[from]?.[to];
  if (allowedActors?.includes(actor)) {
    return {ok: true};
  }

  if (to === 'accepted' && actor === 'agent') {
    return {ok: false, reason: 'Agents cannot accept stories — only a human can.'};
  }

  return {ok: false, reason: `Cannot move a story from ${from} to ${to}.`};
}
