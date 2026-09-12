import {useDroppable} from '@dnd-kit/core';
import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import clsx from 'clsx';
import {useId, type KeyboardEventHandler, type PointerEventHandler} from 'react';
import type {Status} from '../../../shared/status.js';
import {STATUS_LABELS} from '../../../shared/status.js';
import type {Story} from '../../../shared/types.js';
import {StoryCard, type StoryActions} from './StoryCard.js';

/** What a card needs from the rest of the board, resolved once per render by `Board`. */
export interface BoardLookup {
  projectName: (projectId: string) => string | undefined;
  agentName: (agentId: string | null) => string | undefined;
  blockers: (story: Story) => Story[];
}

/**
 * Who is expected to move a card out of each column. The two agent lanes are drawn
 * differently — dashed rule, tinted well, an `agents` caption — so the board reads as two
 * halves at a glance. Nothing here enforces anything: the server owns the guard, and a
 * human is free to drag a card straight into a lane the agents normally run.
 */
const LANES: Record<Status, 'human' | 'agent'> = {
  draft: 'human',
  todo: 'human',
  in_progress: 'agent',
  in_test: 'agent',
  finished: 'human',
  accepted: 'human',
};

const HINTS: Record<Status, string> = {
  draft: 'Nothing drafted yet. New story starts here.',
  todo: 'Drag a story here to queue it for an agent.',
  in_progress: 'Agents move stories here when they pick one up.',
  in_test: 'Agents move stories here to verify their own work.',
  finished: 'Finished work lands here for your review.',
  accepted: 'Stories you have signed off stay here.',
};

export interface ColumnProps {
  status: Status;
  /** Already ordered by rank. */
  stories: Story[];
  lookup: BoardLookup;
  actions: StoryActions;
}

export function Column({status, stories, lookup, actions}: ColumnProps) {
  const headingId = useId();
  const lane = LANES[status];
  // The column itself is a drop target so an empty lane — and the gap below the last
  // card — still accepts a card.
  const {setNodeRef, isOver} = useDroppable({id: status});

  return (
    <section
      aria-labelledby={headingId}
      data-lane={lane}
      className="flex h-full w-[19rem] max-w-[calc(100vw-2.5rem)] shrink-0 snap-start flex-col gap-2"
    >
      <header
        className={clsx(
          'flex shrink-0 items-center gap-2 border-b pb-2',
          lane === 'agent' ? 'border-dashed border-hairline-strong' : 'border-hairline',
        )}
      >
        <h2 id={headingId} className="text-label font-medium text-text">
          {STATUS_LABELS[status]}{' '}
          <span className="ml-0.5 font-mono text-micro tabular-nums text-muted">{stories.length}</span>
        </h2>
        <span className="ml-auto font-mono text-micro text-muted">{lane === 'agent' ? 'agents' : 'you'}</span>
      </header>

      <ul
        ref={setNodeRef}
        className={clsx(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-card border border-transparent p-1',
          'transition-colors duration-150 ease-console',
          lane === 'agent' && 'bg-surface/50',
          isOver && 'border-hairline-strong bg-raised/40',
        )}
      >
        <SortableContext items={stories.map(story => story.id)} strategy={verticalListSortingStrategy}>
          {stories.map(story => (
            <SortableStory key={story.id} story={story} lookup={lookup} actions={actions} />
          ))}
        </SortableContext>
        {stories.length === 0 && (
          <li className="m-1 rounded-card border border-dashed border-hairline px-3 py-6 text-center text-label text-muted">
            {HINTS[status]}
          </li>
        )}
      </ul>
    </section>
  );
}

function SortableStory({story, lookup, actions}: {story: Story; lookup: BoardLookup; actions: StoryActions}) {
  const {attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging} = useSortable({
    id: story.id,
    attributes: {roleDescription: 'story card'},
  });
  // dnd-kit hands back one listener per sensor, untyped. The pointer one belongs to the
  // whole card so a drag can start anywhere on it; the keyboard one belongs to the title,
  // which is the card's single focusable entry point.
  const onPointerDown = listeners?.onPointerDown as PointerEventHandler<HTMLLIElement> | undefined;
  const onKeyDown = listeners?.onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined;

  return (
    <li
      ref={setNodeRef}
      onPointerDown={onPointerDown}
      style={{
        transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={clsx('touch-manipulation', isDragging && 'opacity-35')}
    >
      <StoryCard
        story={story}
        projectName={lookup.projectName(story.projectId)}
        agentName={lookup.agentName(story.claimedByAgentId)}
        blockers={lookup.blockers(story)}
        actions={actions}
        titleProps={{...attributes, onKeyDown, ref: setActivatorNodeRef}}
      />
    </li>
  );
}
