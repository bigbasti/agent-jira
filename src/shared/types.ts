import type {Status} from './status.js';

export interface Project {
  id: string;
  userId: string;
  name: string;
  path: string;
  createdAt: number;
  archivedAt: number | null;
}

export interface Story {
  id: string;
  userId: string;
  projectId: string;
  title: string;
  description: string;
  model: string;
  status: Status;
  rank: string;
  progressPct: number;
  progressLabel: string;
  claimedByAgentId: string | null;
  stopRequested: boolean;
  playRequestedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Computed from story_dependencies — ids of stories that block this one from being claimed. */
  blockedBy: string[];
}

export type StoryUpdateAuthorType = 'user' | 'agent' | 'system';
export type StoryUpdateKind = 'progress' | 'note' | 'status_change' | 'remark' | 'error';

export interface StoryUpdate {
  id: string;
  storyId: string;
  authorType: StoryUpdateAuthorType;
  authorId: string;
  kind: StoryUpdateKind;
  body: string;
  progressPct: number | null;
  createdAt: number;
}

export type AgentStatus = 'offline' | 'idle' | 'waiting' | 'working';

export interface Agent {
  id: string;
  userId: string;
  name: string;
  autonomous: boolean;
  status: AgentStatus;
  currentStoryId: string | null;
  lastSeenAt: number | null;
  createdAt: number;
}

export interface BoardSnapshot {
  columns: Status[];
  stories: Story[];
  agents: Agent[];
}

export type ServerEvent =
  | {type: 'story.created' | 'story.updated' | 'story.moved'; story: Story}
  | {type: 'story.deleted'; id: string}
  | {type: 'story.progress'; id: string; progressPct: number; progressLabel: string}
  | {type: 'story.update'; storyId: string; update: StoryUpdate}
  | {type: 'agent.updated'; agent: Agent}
  | {type: 'project.changed'};
