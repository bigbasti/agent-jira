import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {DEFAULT_MODEL_ID, MODELS, PROVIDER_LABELS} from '../../../shared/models.js';
import type {Project, Story} from '../../../shared/types.js';
import {ApiError} from '../../lib/api.js';
import {useBoard, useCreateStory, useUpdateStory, type StoryFormInput} from '../../lib/board-queries.js';
import {Button} from '../ui/Button.js';
import {Dialog} from '../ui/Dialog.js';
import {Input} from '../ui/Input.js';
import {Select, type SelectOption} from '../ui/Select.js';
import {DependencyPicker} from './DependencyPicker.js';
import {ProjectCreateInline} from './ProjectCreateInline.js';

export interface StoryFormDialogProps {
  mode: 'create' | 'edit';
  /** Required in edit mode; ignored in create mode. */
  story?: Story;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NEW_PROJECT = '__new_project__';

type Field = 'title' | 'project';

const MODEL_OPTIONS: SelectOption[] = MODELS.map(model => ({
  value: model.id,
  label: model.label,
  group: PROVIDER_LABELS[model.provider],
}));

function emptyForm(story: Story | undefined): StoryFormInput {
  return {
    title: story?.title ?? '',
    projectId: story?.projectId ?? '',
    model: story?.model ?? DEFAULT_MODEL_ID,
    description: story?.description ?? '',
    // `blockedBy` is the only dependency data the client can see: the server only ever
    // reports a story's *unresolved* dependencies. A dependency that has since finished
    // does not appear here and, if the form is saved unchanged, drops off the edge set —
    // a real gap in what `Story` exposes today, not something this dialog can close.
    dependsOn: story?.blockedBy ?? [],
  };
}

export function StoryFormDialog({mode, story, open, onOpenChange}: StoryFormDialogProps) {
  const board = useBoard();
  const createStory = useCreateStory();
  const updateStory = useUpdateStory();
  const mutation = mode === 'create' ? createStory : updateStory;

  const [form, setForm] = useState<StoryFormInput>(() => emptyForm(story));
  const [creatingProject, setCreatingProject] = useState(false);
  const [fieldError, setFieldError] = useState<{field: Field; message: string} | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const projectSelectRef = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const descriptionId = `${formId}-description`;

  const storyId = story?.id;

  // Every open — including switching which story is being edited — starts from a clean
  // slate rather than carrying over whatever the previous open left in the fields.
  useEffect(() => {
    if (!open) return;
    setForm(emptyForm(story));
    setCreatingProject(false);
    setFieldError(null);
    createStory.reset();
    updateStory.reset();
    // Deliberately keyed on `open`/`storyId`, not the mutation objects (new identities
    // every render) or `story` itself (a new object on every board refetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, storyId]);

  const projects = board.data?.projects ?? [];
  const otherStories = (board.data?.stories ?? []).filter(candidate => candidate.id !== storyId);
  const projectOptions: SelectOption[] = projects.map(project => ({value: project.id, label: project.name}));

  function patch(fields: Partial<StoryFormInput>) {
    setForm(current => ({...current, ...fields}));
  }

  function handleProjectChange(value: string) {
    if (value === NEW_PROJECT) {
      setCreatingProject(true);
      return;
    }
    setFieldError(current => (current?.field === 'project' ? null : current));
    patch({projectId: value});
  }

  function handleProjectCreated(project: Project) {
    setCreatingProject(false);
    setFieldError(current => (current?.field === 'project' ? null : current));
    patch({projectId: project.id});
  }

  function reject(field: Field, message: string) {
    setFieldError({field, message});
    if (field === 'title') titleRef.current?.focus();
    else if (field === 'project') projectSelectRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;

    const title = form.title.trim();
    if (!title) {
      reject('title', 'Give the story a title.');
      return;
    }
    if (!form.projectId) {
      reject('project', 'Choose a project for this story.');
      return;
    }

    setFieldError(null);
    const payload: StoryFormInput = {...form, title};

    if (mode === 'create') {
      createStory.mutate(payload, {onSuccess: () => onOpenChange(false)});
    } else if (storyId) {
      updateStory.mutate({id: storyId, ...payload}, {onSuccess: () => onOpenChange(false)});
    }
  }

  const serverError =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'create' ? 'New story' : 'Edit story'}
      description="Describe the work for an agent to pick up."
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Input
          ref={titleRef}
          label="Title"
          autoFocus
          value={form.title}
          onChange={event => patch({title: event.target.value})}
          error={fieldError?.field === 'title' ? fieldError.message : undefined}
        />

        <div className="flex flex-col gap-1.5">
          {creatingProject ? (
            <ProjectCreateInline onCreated={handleProjectCreated} onCancel={() => setCreatingProject(false)} />
          ) : (
            <Select
              ref={projectSelectRef}
              label="Project"
              value={form.projectId}
              onValueChange={handleProjectChange}
              options={projectOptions}
              pinnedOption={{value: NEW_PROJECT, label: '+ New project'}}
              placeholder="Choose a project"
            />
          )}
          {fieldError?.field === 'project' && !creatingProject && (
            <p className="text-label text-rose">{fieldError.message}</p>
          )}
        </div>

        <Select label="Model" value={form.model} onValueChange={value => patch({model: value})} options={MODEL_OPTIONS} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor={descriptionId} className="text-label font-medium text-muted">
            Description
          </label>
          <AutoGrowTextarea
            id={descriptionId}
            value={form.description}
            onChange={value => patch({description: value})}
          />
        </div>

        <DependencyPicker candidates={otherStories} value={form.dependsOn} onChange={ids => patch({dependsOn: ids})} />

        {serverError && (
          <p role="alert" className="rounded-well border border-rose/35 bg-rose-wash px-3 py-2 text-label text-rose">
            {serverError}
          </p>
        )}

        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : mode === 'create' ? 'Add to draft' : 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A textarea that grows with its content instead of scrolling internally, 4 rows min. */
function AutoGrowTextarea({id, value, onChange}: {id: string; value: string; onChange: (value: string) => void}) {
  function resize(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  return (
    <textarea
      id={id}
      ref={resize}
      rows={4}
      value={value}
      onChange={event => {
        onChange(event.target.value);
        resize(event.target);
      }}
      className="w-full resize-none overflow-hidden rounded-well border border-hairline bg-well px-3 py-2 text-body text-text placeholder:text-muted/70 transition-colors duration-150 ease-console hover:border-hairline-strong"
      placeholder="What should the agent do?"
    />
  );
}
