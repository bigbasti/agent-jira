import clsx from 'clsx';
import type {ComponentPropsWithRef} from 'react';
import {findModel} from '../../../shared/models.js';
import type {Story} from '../../../shared/types.js';
import {Button} from '../ui/Button.js';
import {Chip} from '../ui/Chip.js';
import {ProgressBar} from '../ui/ProgressBar.js';

/**
 * The five things a card can ask of the rest of the app. Tasks 10 and 14 fill the
 * handlers in; the buttons and the rules about which column shows which are here.
 */
export interface StoryActions {
  onOpen: (story: Story) => void;
  onEdit: (story: Story) => void;
  onDelete: (story: Story) => void;
  onPlay: (story: Story) => void;
  onStop: (story: Story) => void;
}

export interface StoryCardProps {
  story: Story;
  projectName?: string;
  /** The agent holding the claim, when there is one. */
  agentName?: string;
  /** The stories `story.blockedBy` names, resolved by the board. Never recomputed here. */
  blockers: Story[];
  actions: StoryActions;
  /**
   * Drag activator props from the sortable wrapper. They land on the title button, which
   * makes one element per card both the way in to the story and the keyboard drag handle.
   */
  titleProps?: ComponentPropsWithRef<'button'>;
  /** The copy that follows the pointer in the drag overlay. */
  dragging?: boolean;
}

function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M11.2 2.6l2.2 2.2-7.5 7.5-2.9.7.7-2.9 7.5-7.5z" strokeLinejoin="round" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
      <path d="M5.5 3.4l7 4.6-7 4.6V3.4z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4.5 7V5.5a3.5 3.5 0 117 0V7" strokeLinecap="round" />
      <rect x="3.5" y="7" width="9" height="6" rx="1.5" />
    </svg>
  );
}

export function StoryCard({
  story,
  projectName,
  agentName,
  blockers,
  actions,
  titleProps,
  dragging = false,
}: StoryCardProps) {
  const agentOwned = story.claimedByAgentId !== null;
  const blocked = story.blockedBy.length > 0;
  const blockedReason = blocked
    ? `Blocked by ${(blockers.length > 0 ? blockers.map(blocker => blocker.title) : story.blockedBy).join(', ')}`
    : undefined;
  const model = findModel(story.model)?.label ?? story.model;

  const editable = story.status === 'draft';
  const startable = story.status === 'todo';
  const stoppable = story.status === 'in_progress' || story.status === 'in_test';
  const actionCount = editable ? 2 : startable || stoppable ? 1 : 0;

  const {className: titleClassName, ...restTitleProps} = titleProps ?? {};

  return (
    <article
      data-story-id={story.id}
      data-agent-owned={String(agentOwned)}
      className={clsx(
        'group relative flex flex-col gap-2 rounded-card border bg-surface p-3',
        'transition-colors duration-150 ease-console',
        agentOwned && 'agent-edge',
        dragging ? 'border-hairline-strong bg-raised' : 'border-hairline hover:border-hairline-strong',
      )}
    >
      {actionCount > 0 && (
        <div className="absolute top-2 right-2 z-10 flex gap-0.5 opacity-0 transition-opacity duration-150 ease-console group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          {editable && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5"
                aria-label={`Edit ${story.title}`}
                onClick={() => actions.onEdit(story)}
              >
                <EditIcon />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="px-1.5 hover:text-rose"
                aria-label={`Delete ${story.title}`}
                onClick={() => actions.onDelete(story)}
              >
                <DeleteIcon />
              </Button>
            </>
          )}
          {startable && (
            <Button
              variant="ghost"
              size="sm"
              className="px-1.5"
              aria-label={`Start ${story.title}`}
              disabled={blocked}
              onClick={() => actions.onPlay(story)}
            >
              <PlayIcon />
            </Button>
          )}
          {stoppable && (
            <Button
              variant="ghost"
              size="sm"
              className="px-1.5"
              aria-label={`Stop ${story.title}`}
              onClick={() => actions.onStop(story)}
            >
              <StopIcon />
            </Button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => actions.onOpen(story)}
        {...restTitleProps}
        className={clsx(
          // The pseudo-element makes the whole card the target without nesting the action
          // buttons inside another button.
          "line-clamp-2 text-left text-body font-medium text-text after:absolute after:inset-0 after:content-['']",
          actionCount === 2 ? 'pr-16' : actionCount === 1 ? 'pr-9' : '',
          titleClassName,
        )}
      >
        {story.title}
      </button>

      <div className="flex flex-wrap items-center gap-1.5">
        {projectName && <Chip>{projectName}</Chip>}
        <Chip className="font-mono">{model}</Chip>
        {agentName && <Chip tone="accent">{agentName}</Chip>}
        {blockedReason && (
          <Chip tone="amber" title={blockedReason}>
            <LockIcon />
            Blocked
          </Chip>
        )}
      </div>

      {story.progressPct > 0 && (
        <ProgressBar value={story.progressPct} label={story.progressLabel || undefined} />
      )}
    </article>
  );
}
