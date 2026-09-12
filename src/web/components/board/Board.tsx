import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {sortableKeyboardCoordinates} from '@dnd-kit/sortable';
import {useMemo, useState} from 'react';
import type {Status} from '../../../shared/status.js';
import {STATUSES} from '../../../shared/status.js';
import type {Agent, Project, Story} from '../../../shared/types.js';
import {byRank, type MoveRequest} from '../../lib/board-queries.js';
import {Column, type BoardLookup} from './Column.js';
import {StoryCard, type StoryActions} from './StoryCard.js';

export interface BoardProps {
  stories: Story[];
  projects: Project[];
  agents: Agent[];
  actions: StoryActions;
  onMove: (move: MoveRequest) => void;
}

export interface MovePlanInput {
  stories: Story[];
  activeId: string;
  /** What the card was dropped on: another card's id, or a column's status. */
  overId: string;
}

function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * Turns a drop into the neighbour pair the move endpoint wants.
 *
 * The target column is read from whatever the card landed on, and the dragged card is
 * removed from that column before the neighbours are picked, so a card can never be
 * asked to sort itself against itself. Dropping onto the column rather than a card means
 * the end of it. Returns `null` when the drop changes nothing — no request, no flicker.
 */
export function planMove({stories, activeId, overId}: MovePlanInput): MoveRequest | null {
  if (activeId === overId) return null;

  const active = stories.find(story => story.id === activeId);
  if (!active) return null;

  const over = stories.find(story => story.id === overId);
  const status = isStatus(overId) ? overId : over?.status;
  if (!status) return null;

  const column = stories.filter(story => story.status === status && story.id !== activeId).sort(byRank);
  let insertAt = column.length;
  if (over) {
    const overIndex = column.findIndex(story => story.id === overId);
    // Within one column a card that started above the card it was dropped on has passed
    // it, and belongs below it; everything else lands above the card it was dropped on.
    insertAt = over.status === active.status && active.rank < over.rank ? overIndex + 1 : overIndex;
  }

  const beforeId = column[insertAt - 1]?.id ?? null;
  const afterId = column[insertAt]?.id ?? null;

  if (status === active.status) {
    const current = stories.filter(story => story.status === status).sort(byRank);
    const at = current.findIndex(story => story.id === activeId);
    if ((current[at - 1]?.id ?? null) === beforeId && (current[at + 1]?.id ?? null) === afterId) return null;
  }

  return {storyId: activeId, status, beforeId, afterId};
}

export function Board({stories, projects, agents, actions, onMove}: BoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sensors = useSensors(
    // 8 px of travel before a drag starts, so a click still opens the story.
    useSensor(PointerSensor, {activationConstraint: {distance: 8}}),
    useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}),
  );

  const columns = useMemo(() => {
    const grouped = new Map<Status, Story[]>(STATUSES.map(status => [status, []]));
    for (const story of stories) grouped.get(story.status)?.push(story);
    for (const column of grouped.values()) column.sort(byRank);
    return grouped;
  }, [stories]);

  const lookup = useMemo<BoardLookup>(() => {
    const projectNames = new Map(projects.map(project => [project.id, project.name]));
    const agentNames = new Map(agents.map(agent => [agent.id, agent.name]));
    const titles = new Map(stories.map(story => [story.id, story]));
    return {
      projectName: projectId => projectNames.get(projectId),
      agentName: agentId => (agentId === null ? undefined : agentNames.get(agentId)),
      // `blockedBy` is the server's answer; this only turns its ids into cards.
      blockers: story =>
        story.blockedBy.map(id => titles.get(id)).filter((blocker): blocker is Story => blocker !== undefined),
    };
  }, [stories, projects, agents]);

  const dragging = draggingId === null ? undefined : stories.find(story => story.id === draggingId);

  function handleDragEnd({active, over}: DragEndEvent) {
    setDraggingId(null);
    if (!over) return;
    const move = planMove({stories, activeId: String(active.id), overId: String(over.id)});
    if (move) onMove(move);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={({active}: DragStartEvent) => setDraggingId(String(active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingId(null)}
    >
      <div className="flex h-full snap-x snap-proximity scroll-px-4 gap-4 overflow-x-auto px-4 pb-4">
        {STATUSES.map(status => (
          <Column key={status} status={status} stories={columns.get(status) ?? []} lookup={lookup} actions={actions} />
        ))}
      </div>

      {/* Portalled out of the columns, which scroll and would otherwise clip the card. */}
      <DragOverlay>
        {dragging && (
          <StoryCard
            story={dragging}
            projectName={lookup.projectName(dragging.projectId)}
            agentName={lookup.agentName(dragging.claimedByAgentId)}
            blockers={lookup.blockers(dragging)}
            actions={actions}
            dragging
          />
        )}
      </DragOverlay>
    </DndContext>
  );
}
