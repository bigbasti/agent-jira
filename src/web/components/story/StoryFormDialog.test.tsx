import {screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {StoryFormDialog} from './StoryFormDialog.js';
import {makeBoard, makeProject, makeStory} from '../../testing/fixtures.js';
import {createTestQueryClient, jsonResponse, mockFetch, renderWithClient} from '../../testing/render.js';
import {BOARD_KEY} from '../../lib/board-queries.js';
import type {BoardSnapshot} from '../../../shared/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const BOARD = makeBoard({
  projects: [makeProject({id: 'p1', name: 'agent-jira'}), makeProject({id: 'p2', name: 'other-repo'})],
  stories: [
    makeStory({id: 's1', title: 'Wire the board', status: 'todo'}),
    makeStory({id: 's2', title: 'Ship the CLI', status: 'finished'}),
  ],
});

/**
 * Seeds a client with the board already loaded and routes the endpoints the dialog can
 * call. `client.setQueryData` means the dialog's own `useBoard()` paints synchronously
 * from the seed; the mock still answers the background refetch React Query fires on
 * mount, and the mutation endpoints named in `handlers`.
 */
function renderDialog(
  ui: Parameters<typeof renderWithClient>[0],
  {board = BOARD, handlers = {}}: {board?: BoardSnapshot; handlers?: Record<string, () => Promise<Response>>} = {},
) {
  const client = createTestQueryClient();
  client.setQueryData(BOARD_KEY, board);

  const fetchMock = mockFetch();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/board') return jsonResponse(200, board);
    const handler = handlers[`${method} ${path}`] ?? handlers[path];
    if (handler) return handler();
    throw new Error(`unexpected request: ${method} ${path}`);
  });

  return {...renderWithClient(ui, client), client, fetchMock};
}

async function openSelect(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', {name}));
  return user;
}

describe('StoryFormDialog — create', () => {
  it('defaults the model select to Claude Opus 5', () => {
    renderDialog(<StoryFormDialog mode="create" open onOpenChange={() => {}} />);

    expect(screen.getByRole('combobox', {name: 'Model'})).toHaveTextContent('Claude Opus 5');
  });

  it('groups models by provider', async () => {
    renderDialog(<StoryFormDialog mode="create" open onOpenChange={() => {}} />);

    await openSelect('Model');

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Anthropic')).toBeInTheDocument();
    expect(within(listbox).getByText('OpenAI')).toBeInTheDocument();
    // Groups actually contain the models they claim to.
    const anthropicGroup = within(listbox).getByText('Anthropic').closest('[role="group"]');
    expect(anthropicGroup).not.toBeNull();
    expect(within(anthropicGroup as HTMLElement).getByText('Claude Opus 5')).toBeInTheDocument();
  });

  it('requires a title and a project', async () => {
    const user = userEvent.setup();
    const {fetchMock} = renderDialog(<StoryFormDialog mode="create" open onOpenChange={() => {}} />);

    await user.click(screen.getByRole('button', {name: 'Add to draft'}));

    expect(await screen.findByText('Give the story a title.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/stories', expect.anything());

    await user.type(screen.getByLabelText('Title'), 'New story');
    await user.click(screen.getByRole('button', {name: 'Add to draft'}));

    expect(await screen.findByText('Choose a project for this story.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', {name: 'Project'})).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/stories', expect.anything());
  });

  it('creates a project inline and selects it', async () => {
    const created = makeProject({id: 'p3', name: 'brand-new'});
    const user = userEvent.setup();
    const {client} = renderDialog(<StoryFormDialog mode="create" open onOpenChange={() => {}} />, {
      handlers: {
        'POST /api/projects': async () => jsonResponse(201, created),
      },
    });

    await user.click(screen.getByRole('combobox', {name: 'Project'}));
    await user.click(await screen.findByRole('option', {name: '+ New project'}));

    await user.type(screen.getByLabelText('Project name'), 'brand-new');
    await user.type(screen.getByLabelText('Absolute path'), '/srv/brand-new');
    await user.click(screen.getByRole('button', {name: 'Create project'}));

    await waitFor(() => expect(screen.getByRole('combobox', {name: 'Project'})).toHaveTextContent('brand-new'));
    // The inline form is gone; the Select is back.
    expect(screen.queryByLabelText('Project name')).not.toBeInTheDocument();
    // And the new project actually landed in the shared board cache.
    expect(client.getQueryData<BoardSnapshot>(BOARD_KEY)?.projects.map(p => p.id)).toContain('p3');
  });

  it('submits the full payload', async () => {
    const created = makeStory({id: 's9', title: 'Add logging', projectId: 'p2', model: 'gpt-5.1'});
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const {fetchMock} = renderDialog(<StoryFormDialog mode="create" open onOpenChange={onOpenChange} />, {
      handlers: {
        'POST /api/stories': async () => jsonResponse(201, created),
      },
    });

    await user.type(screen.getByLabelText('Title'), 'Add logging');

    await user.click(screen.getByRole('combobox', {name: 'Project'}));
    await user.click(await screen.findByRole('option', {name: 'other-repo'}));

    await user.click(screen.getByRole('combobox', {name: 'Model'}));
    await user.click(await screen.findByRole('option', {name: 'GPT-5.1'}));

    await user.type(screen.getByLabelText('Description'), 'Add structured logging.');

    const dependencyGroup = screen.getByRole('group', {name: 'Dependencies'});
    await user.click(within(dependencyGroup).getByRole('checkbox', {name: /Wire the board/}));

    await user.click(screen.getByRole('button', {name: 'Add to draft'}));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    const call = fetchMock.mock.calls.find(call => String(call[0]) === '/api/stories');
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'Add logging',
      projectId: 'p2',
      model: 'gpt-5.1',
      description: 'Add structured logging.',
      dependsOn: ['s1'],
    });
  });
});

describe('StoryFormDialog — edit', () => {
  it('excludes the edited story from its own dependency options', () => {
    const editing = makeStory({id: 's1', title: 'Wire the board', status: 'todo', projectId: 'p1'});
    renderDialog(<StoryFormDialog mode="edit" story={editing} open onOpenChange={() => {}} />);

    const dependencyGroup = screen.getByRole('group', {name: 'Dependencies'});
    expect(within(dependencyGroup).queryByText('Wire the board')).not.toBeInTheDocument();
    expect(within(dependencyGroup).getByText('Ship the CLI')).toBeInTheDocument();
  });

  it('labels its primary button Save and pre-fills the story', () => {
    const editing = makeStory({
      id: 's1',
      title: 'Wire the board',
      status: 'todo',
      projectId: 'p1',
      description: 'Hook up drag and drop.',
    });
    renderDialog(<StoryFormDialog mode="edit" story={editing} open onOpenChange={() => {}} />);

    expect(screen.getByRole('button', {name: 'Save'})).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Wire the board');
    expect(screen.getByLabelText('Description')).toHaveValue('Hook up drag and drop.');
    expect(screen.getByRole('combobox', {name: 'Project'})).toHaveTextContent('agent-jira');
  });

  it('sends a PATCH with the edited fields', async () => {
    const editing = makeStory({id: 's1', title: 'Wire the board', status: 'todo', projectId: 'p1'});
    const updated = {...editing, title: 'Wire up the board'};
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const {fetchMock} = renderDialog(
      <StoryFormDialog mode="edit" story={editing} open onOpenChange={onOpenChange} />,
      {handlers: {'PATCH /api/stories/s1': async () => jsonResponse(200, updated)}},
    );

    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Wire up the board');
    await user.click(screen.getByRole('button', {name: 'Save'}));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const call = fetchMock.mock.calls.find(call => String(call[0]) === '/api/stories/s1');
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toMatchObject({title: 'Wire up the board', projectId: 'p1'});
  });
});
