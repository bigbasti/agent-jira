import type {Status} from '../../shared/status.js';
import type {ChipTone} from '../components/ui/Chip.js';

/**
 * The tone a status reads as on a chip. `accent` is reserved for progress, active agents
 * and primary actions, so a status — draft or accepted alike — never wears it: the two
 * columns an agent works from get the amber "in flight" tone, the two a human closes out
 * get emerald, and the two before any of that stay neutral.
 */
const STATUS_TONES: Record<Status, ChipTone> = {
  draft: 'neutral',
  todo: 'neutral',
  in_progress: 'amber',
  in_test: 'amber',
  finished: 'emerald',
  accepted: 'emerald',
};

export function statusTone(status: Status): ChipTone {
  return STATUS_TONES[status];
}
