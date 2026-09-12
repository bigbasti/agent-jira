export const STATUSES = ['draft', 'todo', 'in_progress', 'in_test', 'finished', 'accepted'] as const;
export type Status = typeof STATUSES[number];
export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Draft', todo: 'To do', in_progress: 'In progress',
  in_test: 'In test', finished: 'Finished', accepted: 'Accepted',
};
