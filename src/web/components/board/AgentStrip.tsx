import clsx from 'clsx';
import type {Agent, AgentStatus, Story} from '../../../shared/types.js';
import {Button} from '../ui/Button.js';

/**
 * Presence only — one pill per connected agent. Task 14 adds the autonomous switch and
 * the connect dialog behind `onConnectAgent`.
 */
export interface AgentStripProps {
  agents: Agent[];
  stories: Story[];
  onConnectAgent: () => void;
}

// Working agents are the one thing besides progress and primary actions that may wear
// the accent; everything quieter stays in the neutral ramp or a status hue.
const DOTS: Record<AgentStatus, string> = {
  working: 'bg-accent agent-pulse',
  waiting: 'bg-amber',
  idle: 'bg-muted',
  offline: 'bg-hairline-strong',
};

export function AgentStrip({agents, stories, onConnectAgent}: AgentStripProps) {
  return (
    <section
      aria-label="Agents"
      className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline px-4"
    >
      {agents.length === 0 ? (
        <>
          <span className="text-label text-muted">No agents connected —</span>
          <Button variant="ghost" size="sm" onClick={onConnectAgent}>
            Connect an agent
          </Button>
        </>
      ) : (
        agents.map(agent => (
          <AgentPill
            key={agent.id}
            agent={agent}
            currentStory={stories.find(story => story.id === agent.currentStoryId)}
          />
        ))
      )}
    </section>
  );
}

function AgentPill({agent, currentStory}: {agent: Agent; currentStory?: Story}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 rounded-chip border border-hairline bg-surface pr-2.5 pl-2">
      <span className={clsx('size-1.5 shrink-0 rounded-full', DOTS[agent.status])} aria-hidden="true" />
      <span className="font-mono text-micro text-text">{agent.name}</span>
      <span className="text-micro text-muted">{agent.status}</span>
      {currentStory && (
        <span className="max-w-44 truncate border-l border-hairline pl-2 text-micro text-muted">
          {currentStory.title}
        </span>
      )}
    </div>
  );
}
