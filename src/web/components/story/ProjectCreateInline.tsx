import {useRef, useState, type KeyboardEvent} from 'react';
import type {Project} from '../../../shared/types.js';
import {ApiError} from '../../lib/api.js';
import {useCreateProject} from '../../lib/board-queries.js';
import {Button} from '../ui/Button.js';
import {Input} from '../ui/Input.js';

export interface ProjectCreateInlineProps {
  onCreated: (project: Project) => void;
  onCancel: () => void;
}

type Field = 'name' | 'path';

// Mirrors the server's rule (`absolutePath` in services/projects.ts) so an obviously bad
// path is rejected here rather than round-tripping to find out.
function isAbsolutePath(path: string): boolean {
  return /^\/[^/]/.test(path) || /^[A-Za-z]:\\[^\\]/.test(path);
}

/**
 * Swaps in for the project `Select` when its pinned "+ New project" item is chosen. A
 * name and an absolute path, nothing else — the same two fields `createProjectSchema`
 * asks for.
 *
 * This is never rendered on its own: it always sits inside `StoryFormDialog`'s `<form>`,
 * so it has no `<form>` of its own (nesting one would be invalid HTML and would let an
 * Enter keystroke here submit the outer story form instead of creating the project).
 * Enter is handled directly on the field group.
 */
export function ProjectCreateInline({onCreated, onCancel}: ProjectCreateInlineProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [fieldError, setFieldError] = useState<{field: Field; message: string} | null>(null);
  const fields = {
    name: useRef<HTMLInputElement>(null),
    path: useRef<HTMLInputElement>(null),
  };

  const createProject = useCreateProject();

  function reject(field: Field, message: string) {
    setFieldError({field, message});
    fields[field].current?.focus();
  }

  function submit() {
    if (createProject.isPending) return;

    const trimmedName = name.trim();
    const trimmedPath = path.trim();

    if (!trimmedName) {
      reject('name', 'Give the project a name.');
      return;
    }
    if (!isAbsolutePath(trimmedPath)) {
      reject('path', 'Enter an absolute path, such as /srv/my-project.');
      return;
    }

    setFieldError(null);
    createProject.mutate({name: trimmedName, path: trimmedPath}, {onSuccess: onCreated});
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submit();
  }

  const serverError =
    createProject.error instanceof ApiError
      ? createProject.error.message
      : createProject.error
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <div
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 rounded-well border border-hairline-strong bg-well/50 p-3"
    >
      <Input
        ref={fields.name}
        label="Project name"
        autoFocus
        value={name}
        onChange={event => setName(event.target.value)}
        error={fieldError?.field === 'name' ? fieldError.message : undefined}
      />
      <Input
        ref={fields.path}
        label="Absolute path"
        hint="Where an agent will check the project out, e.g. /srv/my-project."
        spellCheck={false}
        value={path}
        onChange={event => setPath(event.target.value)}
        error={fieldError?.field === 'path' ? fieldError.message : undefined}
      />

      {serverError && (
        <p role="alert" className="text-label text-rose">
          {serverError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={createProject.isPending} onClick={submit}>
          {createProject.isPending ? 'Creating…' : 'Create project'}
        </Button>
      </div>
    </div>
  );
}
