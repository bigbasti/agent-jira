import type {Database} from '../db/index.js';
import {listAgents} from './agents.js';
import {listProjects} from './projects.js';
import {listStories} from './stories.js';
import {STATUSES} from '../../shared/status.js';
import type {BoardSnapshot} from '../../shared/types.js';

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
