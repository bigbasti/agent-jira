import clsx from 'clsx';
import {useId, useState, type FormEvent} from 'react';
import {findModel} from '../../../shared/models.js';
import {STATUS_LABELS} from '../../../shared/status.js';
import type {StoryUpdate} from '../../../shared/types.js';
import {ApiError} from '../../lib/api.js';
import {useAddRemark, useBoard, useStoryUpdates} from '../../lib/board-queries.js';
import {statusTone} from '../../lib/status-tone.js';
import {Button} from '../ui/Button.js';
import {Chip} from '../ui/Chip.js';
import {Dialog} from '../ui/Dialog.js';
import {ProgressBar} from '../ui/ProgressBar.js';

export interface StoryDetailDialogProps {
  storyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function StoryDetailDialog({storyId, open, onOpenChange}: StoryDetailDialogProps) {
  const board = useBoard();
  const story = board.data?.stories.find(candidate => candidate.id === storyId);
  const project = story ? board.data?.projects.find(candidate => candidate.id === story.projectId) : undefined;
  const updatesQuery = useStoryUpdates(storyId, open);
  const addRemark = useAddRemark(storyId);
  const [remark, setRemark] = useState('');
  const composerId = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = remark.trim();
    if (!body || addRemark.isPending) return;
    addRemark.mutate(body, {onSuccess: () => setRemark('')});
  }

  const model = story ? (findModel(story.model)?.label ?? story.model) : undefined;
  const remarkError =
    addRemark.error instanceof ApiError
      ? addRemark.error.message
      : addRemark.error
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={story?.title ?? 'Story'} className="flex max-h-[85dvh] flex-col">
      {!story ? (
        <p className="text-body text-muted">Loading…</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <header className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone={statusTone(story.status)}>{STATUS_LABELS[story.status]}</Chip>
              <Chip className="font-mono">{model}</Chip>
            </div>
            {project && (
              <p className="truncate font-mono text-label text-muted" title={project.path}>
                {project.path}
              </p>
            )}
            <ProgressBar value={story.progressPct} label={story.progressLabel || undefined} />
          </header>

          <ol aria-label="Story timeline" aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto border-t border-hairline pt-2">
            {updatesQuery.isPending && <li className="px-1 py-2 text-label text-muted">Loading updates…</li>}
            {updatesQuery.data?.length === 0 && (
              <li className="px-1 py-2 text-label text-muted">No updates yet.</li>
            )}
            {updatesQuery.data?.map(update => <UpdateRow key={update.id} update={update} />)}
          </ol>

          <form onSubmit={handleSubmit} className="sticky bottom-0 flex flex-col gap-1.5 border-t border-hairline bg-surface pt-3">
            <label htmlFor={composerId} className="sr-only">
              Add a remark
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id={composerId}
                value={remark}
                onChange={event => setRemark(event.target.value)}
                rows={1}
                placeholder="Add a remark…"
                className="h-9 min-h-9 w-full flex-1 resize-none rounded-well border border-hairline bg-well px-3 py-2 text-body text-text placeholder:text-muted/70 transition-colors duration-150 ease-console hover:border-hairline-strong"
              />
              <Button type="submit" variant="primary" size="md" disabled={!remark.trim() || addRemark.isPending}>
                {addRemark.isPending ? 'Posting…' : 'Post'}
              </Button>
            </div>
            {remarkError && (
              <p role="alert" className="text-label text-rose">
                {remarkError}
              </p>
            )}
          </form>
        </div>
      )}
    </Dialog>
  );
}

function AgentGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-2.5" aria-hidden="true">
      <path d="M8 1.5L14.5 8L8 14.5L1.5 8z" fill="currentColor" />
    </svg>
  );
}

function HumanGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-2.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}

function authorLabel(update: StoryUpdate): string {
  if (update.authorType === 'agent') return 'Agent';
  if (update.authorType === 'system') return 'System';
  return 'You';
}

function updateBody(update: StoryUpdate): string {
  if (update.kind === 'progress') {
    const percent = Math.round(Math.min(100, Math.max(0, update.progressPct ?? 0)));
    return update.body ? `${percent}% · ${update.body}` : `${percent}%`;
  }
  return update.body;
}

function UpdateRow({update}: {update: StoryUpdate}) {
  const isAgent = update.authorType === 'agent';

  return (
    <li className="flex gap-2 px-1 py-1.5">
      <span
        aria-hidden="true"
        className={clsx(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full',
          isAgent ? 'bg-accent-wash text-accent-text' : 'bg-raised text-muted',
        )}
      >
        {isAgent ? <AgentGlyph /> : <HumanGlyph />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-label font-medium text-text">{authorLabel(update)}</span>
          <time dateTime={new Date(update.createdAt).toISOString()} className="text-micro text-muted">
            {timeFormatter.format(update.createdAt)}
          </time>
        </div>
        <p
          className={clsx(
            'break-words text-body text-text',
            update.kind === 'progress' && 'font-mono text-label text-muted',
          )}
        >
          {updateBody(update)}
        </p>
      </div>
    </li>
  );
}
