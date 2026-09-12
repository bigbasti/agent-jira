import type {Status} from './status.js';

const SATISFIED: ReadonlySet<Status> = new Set(['finished', 'accepted']);

/**
 * Returns the ids of `storyId`'s dependencies that are not yet satisfied
 * (i.e. not `finished` or `accepted`).
 */
export function blockedBy(
  storyId: string,
  deps: Map<string, string[]>,
  statusOf: Map<string, Status>,
): string[] {
  const dependencyIds = deps.get(storyId) ?? [];
  return dependencyIds.filter((id) => {
    const status = statusOf.get(id);
    return status === undefined || !SATISFIED.has(status);
  });
}

/**
 * Returns true if adding a dependency edge `storyId -> dependsOnId` (i.e.
 * "storyId depends on dependsOnId") would create a cycle — which happens
 * exactly when `dependsOnId` can already (transitively) reach `storyId`
 * through the existing dependency graph.
 */
export function wouldCycle(
  storyId: string,
  dependsOnId: string,
  deps: Map<string, string[]>,
): boolean {
  if (storyId === dependsOnId) return true;

  const visited = new Set<string>();
  const stack = [dependsOnId];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === storyId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const next = deps.get(current) ?? [];
    for (const id of next) {
      if (!visited.has(id)) stack.push(id);
    }
  }

  return false;
}
