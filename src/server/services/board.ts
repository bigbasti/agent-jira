import {eq} from 'drizzle-orm';
import type {Database} from '../db/index.js';
import {agents} from '../db/schema.js';
import {listProjects} from './projects.js';
import {listStories} from './stories.js';
import {STATUSES} from '../../shared/status.js';
import type {Agent, BoardSnapshot} from '../../shared/types.js';

// The agents service does not exist yet (it arrives with agent management), so the board
// reads the table directly for now. When that service lands this becomes a call into it.
function listAgents(db: Database, userId: string): Agent[] {
  return db
    .select()
    .from(agents)
    .where(eq(agents.userId, userId))
    .all()
    .map(row => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      autonomous: row.autonomous,
      status: row.status,
      currentStoryId: row.currentStoryId,
      lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt,
    }));
}

/**
 * Everything the board screen needs in one read: the six columns in board order, and
 * `userId`'s stories (rank-ordered, each carrying its computed `blockedBy`), projects and
 * agents. Nothing belonging to another user can appear here — every part is filtered by
 * `userId` at the query.
 */
export function getBoard(db: Database, userId: string): BoardSnapshot {
  return {
    columns: [...STATUSES],
    stories: listStories(db, userId),
    projects: listProjects(db, userId),
    agents: listAgents(db, userId),
  };
}
