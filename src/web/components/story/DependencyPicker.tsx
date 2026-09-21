import {useId, useState} from 'react';
import {STATUS_LABELS} from '../../../shared/status.js';
import type {Story} from '../../../shared/types.js';
import {statusTone} from '../../lib/status-tone.js';
import {Chip} from '../ui/Chip.js';

export interface DependencyPickerProps {
  /** Stories that may be depended on. The caller excludes the story being edited. */
  candidates: Story[];
  value: string[];
  onChange: (ids: string[]) => void;
}

/**
 * A searchable checklist rather than a dropdown: dependencies are usually picked a few at
 * a time while looking at what is already finished, and a list that stays open reads
 * better for that than a menu that closes after each pick.
 */
export function DependencyPicker({candidates, value, onChange}: DependencyPickerProps) {
  const [search, setSearch] = useState('');
  const groupId = useId();
  const searchId = `${groupId}-search`;

  const filtered = candidates.filter(candidate =>
    candidate.title.toLowerCase().includes(search.trim().toLowerCase()),
  );

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter(candidate => candidate !== id) : [...value, id]);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={searchId} className="text-label font-medium text-muted">
          Dependencies
        </label>
        {value.length > 0 && (
          <span className="text-micro text-muted">
            {value.length} selected
          </span>
        )}
      </div>

      <input
        id={searchId}
        type="text"
        value={search}
        onChange={event => setSearch(event.target.value)}
        placeholder="Search stories…"
        disabled={candidates.length === 0}
        className="h-9 w-full rounded-well border border-hairline bg-well px-3 text-body text-text placeholder:text-muted/70 transition-colors duration-150 ease-console hover:border-hairline-strong disabled:opacity-45"
      />

      <div
        role="group"
        aria-label="Dependencies"
        className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-well border border-hairline bg-well p-1"
      >
        {candidates.length === 0 && (
          <p className="px-2 py-1.5 text-label text-muted">There are no other stories to depend on yet.</p>
        )}
        {candidates.length > 0 && filtered.length === 0 && (
          <p className="px-2 py-1.5 text-label text-muted">No stories match "{search}".</p>
        )}
        {filtered.map(candidate => {
          const checkboxId = `${groupId}-${candidate.id}`;
          return (
            <label
              key={candidate.id}
              htmlFor={checkboxId}
              className="flex cursor-pointer items-center gap-2 rounded-chip px-2 py-1.5 text-body text-text transition-colors duration-150 ease-console hover:bg-raised"
            >
              <input
                id={checkboxId}
                type="checkbox"
                checked={value.includes(candidate.id)}
                onChange={() => toggle(candidate.id)}
                className="size-3.5 shrink-0 accent-[var(--accent-solid)]"
              />
              <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
              <Chip tone={statusTone(candidate.status)}>{STATUS_LABELS[candidate.status]}</Chip>
            </label>
          );
        })}
      </div>
    </div>
  );
}
