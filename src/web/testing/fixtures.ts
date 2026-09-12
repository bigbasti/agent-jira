import {DEFAULT_MODEL_ID} from '../../shared/models.js';
import {STATUSES} from '../../shared/status.js';
import type {Agent, BoardSnapshot, Project, Story} from '../../shared/types.js';

/**
 * Board fixtures for the web tests. Every builder takes the id it is identified by, so a
 * test reads as a list of the few fields it actually cares about.
 */

export function makeStory(story: Partial<Story> & Pick<Story, 'id'>): Story {
  return {
    userId: 'u1',
    projectId: 'p1',
    title: `Story ${story.id}`,
    description: '',
    model: DEFAULT_MODEL_ID,
    status: 'draft',
    rank: 'U',
    progressPct: 0,
    progressLabel: '',
    claimedByAgentId: null,
    stopRequested: false,
    playRequestedAt: null,
    createdAt: 1,
    updatedAt: 1,
    blockedBy: [],
    ...story,
  };
}

export function makeProject(project: Partial<Project> & Pick<Project, 'id'>): Project {
  return {
    userId: 'u1',
    name: `Project ${project.id}`,
    path: `/srv/${project.id}`,
    createdAt: 1,
    archivedAt: null,
    ...project,
  };
}

export function makeAgent(agent: Partial<Agent> & Pick<Agent, 'id'>): Agent {
  return {
    userId: 'u1',
    name: `Agent ${agent.id}`,
    autonomous: false,
    status: 'idle',
    currentStoryId: null,
    lastSeenAt: null,
    createdAt: 1,
    ...agent,
  };
}

export function makeBoard(board: Partial<Omit<BoardSnapshot, 'columns'>> = {}): BoardSnapshot {
  return {
    columns: [...STATUSES],
    stories: [],
    projects: [],
    agents: [],
    ...board,
  };
}
