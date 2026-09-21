import {screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {StoryDetailDialog} from './StoryDetailDialog.js';
import {makeBoard, makeProject, makeStory, makeUpdate} from '../../testing/fixtures.js';
import {createTestQueryClient, jsonResponse, mockFetch, renderWithClient} from '../../testing/render.js';
import {BOARD_KEY, storyUpdatesKey} from '../../lib/board-queries.js';
import type {BoardSnapshot, StoryUpdate} from '../../../shared/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STORY = makeStory({
  id: 's1',
  title: 'Wire the board',
  status: 'in_progress',
  projectId: 'p1',
  model: 'gpt-5.1',
  progressPct: 42,
  progressLabel: 'Writing tests',
});

const BOARD = makeBoard({
  projects: [makeProject({id: 'p1', name: 'agent-kanban', path: '/srv/agent-kanban'})],
  stories: [STORY],
});

function renderDetail(
  updates: StoryUpdate[],
  {handlers = {}}: {handlers?: Record<string, () => Promise<Response>>} = {},
) {
  const client = createTestQueryClient();
  client.setQueryData(BOARD_KEY, BOARD);
  client.setQueryData(storyUpdatesKey('s1'), updates);

  const fetchMock = mockFetch();
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path === '/api/board') return jsonResponse(200, BOARD);
    if (method === 'GET' && path === '/api/stories/s1/updates') return jsonResponse(200, updates);
    const handler = handlers[`${method} ${path}`] ?? handlers[path];
    if (handler) return handler();
    throw new Error(`unexpected request: ${method} ${path}`);
  });

  return {
    ...renderWithClient(<StoryDetailDialog storyId="s1" open onOpenChange={() => {}} />, client),
    client,
    fetchMock,
  };
}

describe('StoryDetailDialog', () => {
  it('renders the progress bar with its label', () => {
    renderDetail([]);

    const bar = screen.getByRole('progressbar', {name: 'Writing tests'});
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('shows the project path in monospace', () => {
    renderDetail([]);

    const path = screen.getByText('/srv/agent-kanban');
    expect(path).toHaveClass('font-mono');
  });

  it('renders the update timeline newest last, marking agent vs human authors', async () => {
    const updates = [
      makeUpdate({id: 'u1', storyId: 's1', authorType: 'user', kind: 'remark', body: 'Please add a README.', createdAt: 1}),
      makeUpdate({id: 'u2', storyId: 's1', authorType: 'agent', kind: 'note', body: 'Starting now.', createdAt: 2}),
    ];
    renderDetail(updates);

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Oldest first, newest last.
    expect(rows[0]).toHaveTextContent('Please add a README.');
    expect(rows[1]).toHaveTextContent('Starting now.');
    // Distinguished by more than colour: each entry carries a visible author label.
    expect(within(rows[0] as HTMLElement).getByText('You')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Agent')).toBeInTheDocument();
  });

  it('renders a progress update compactly as percent and label', async () => {
    const updates = [
      makeUpdate({id: 'u1', storyId: 's1', authorType: 'agent', kind: 'progress', body: 'Writing tests', progressPct: 42, createdAt: 1}),
    ];
    renderDetail(updates);

    expect(await screen.findByText('42% · Writing tests')).toBeInTheDocument();
  });

  it('posts a remark and clears the composer', async () => {
    const posted = makeUpdate({id: 'u9', storyId: 's1', authorType: 'user', kind: 'remark', body: 'Looks good.', createdAt: 99});
    const user = userEvent.setup();
    const {fetchMock} = renderDetail([], {
      handlers: {'POST /api/stories/s1/updates': async () => jsonResponse(201, posted)},
    });

    const composer = screen.getByLabelText('Add a remark');
    await user.type(composer, 'Looks good.');
    await user.click(screen.getByRole('button', {name: 'Post'}));

    await waitFor(() => expect(composer).toHaveValue(''));
    expect(await screen.findByText('Looks good.')).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(
      call => String(call[0]) === '/api/stories/s1/updates' && (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({body: 'Looks good.'});
  });
});
