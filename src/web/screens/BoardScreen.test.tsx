import {screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {BoardScreen, MoveErrorToast} from './BoardScreen.js';
import {makeAgent, makeBoard, makeStory} from '../testing/fixtures.js';
import {jsonResponse, mockFetch, renderWithClient} from '../testing/render.js';
import type {BoardSnapshot} from '../../shared/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = {id: 'u1', email: 'dev@example.com', createdAt: 1};

function serveBoard(board: BoardSnapshot) {
  const fetchMock = mockFetch();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/board') return jsonResponse(200, board);
    if (path === '/api/auth/logout') return jsonResponse(204);
    if (path === '/api/config') return jsonResponse(200, {publicUrl: 'https://board.example', mcpUrl: 'https://board.example/mcp'});
    throw new Error(`unexpected request: ${path}`);
  });
  return fetchMock;
}

describe('BoardScreen', () => {
  it('renders the six columns and the stories the board returned', async () => {
    serveBoard(makeBoard({stories: [makeStory({id: 's1', status: 'todo', title: 'Queued one'})]}));
    renderWithClient(<BoardScreen user={USER} />);

    expect(await screen.findByText('Queued one')).toBeInTheDocument();
    expect(screen.getAllByRole('region', {name: /Draft|To do|In progress|In test|Finished|Accepted/})).toHaveLength(6);
  });

  it('shows the column frame while the board is still loading', () => {
    serveBoard(makeBoard());
    renderWithClient(<BoardScreen user={USER} />);

    expect(screen.getByRole('status', {name: 'Board status'})).toHaveTextContent('Loading the board');
    expect(screen.getByRole('heading', {name: /Draft/})).toBeInTheDocument();
  });

  it('offers a retry when the board cannot be loaded', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(500, {error: 'unknown'}));
    renderWithClient(<BoardScreen user={USER} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Try again.');

    const user = userEvent.setup();
    fetchMock.mockClear();
    await user.click(screen.getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/board', expect.anything()));
  });

  it('names the signed-in account and logs out from the account menu', async () => {
    const user = userEvent.setup();
    const fetchMock = serveBoard(makeBoard());
    const {client} = renderWithClient(<BoardScreen user={USER} />);
    await screen.findByRole('heading', {name: /Draft/});

    await user.click(screen.getByRole('button', {name: 'Account'}));
    expect(await screen.findByText('dev@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', {name: 'Log out'}));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.anything()));
    await waitFor(() => expect(client.getQueryData(['me'])).toBeNull());
  });

  it('invites connecting an agent while none are connected', async () => {
    serveBoard(makeBoard());
    renderWithClient(<BoardScreen user={USER} />);

    const strip = await screen.findByRole('region', {name: 'Agents'});
    expect(within(strip).getByText(/No agents connected/)).toBeInTheDocument();
  });

  it('lists each connected agent with its status and current story', async () => {
    serveBoard(
      makeBoard({
        agents: [makeAgent({id: 'a1', name: 'claude-code-1', status: 'working', currentStoryId: 's1'})],
        stories: [makeStory({id: 's1', status: 'in_progress', title: 'Build the thing'})],
      }),
    );
    renderWithClient(<BoardScreen user={USER} />);

    const strip = await screen.findByRole('region', {name: 'Agents'});
    expect(await within(strip).findByText('claude-code-1')).toBeInTheDocument();
    expect(within(strip).getByText('working')).toBeInTheDocument();
    expect(within(strip).getByText('Build the thing')).toBeInTheDocument();
  });
});

describe('BoardScreen — connecting an agent', () => {
  it('opens the connect-agent dialog from the empty strip, showing the real mcp url', async () => {
    const user = userEvent.setup();
    serveBoard(makeBoard());
    renderWithClient(<BoardScreen user={USER} />);
    const strip = await screen.findByRole('region', {name: 'Agents'});

    await user.click(within(strip).getByRole('button', {name: 'Connect an agent'}));

    const dialog = await screen.findByRole('dialog', {name: 'Connect an agent'});
    expect(await within(dialog).findByText('https://board.example/mcp')).toBeInTheDocument();
  });

  it('opens the connect-agent dialog from the account menu', async () => {
    const user = userEvent.setup();
    serveBoard(makeBoard());
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByRole('heading', {name: /Draft/});

    await user.click(screen.getByRole('button', {name: 'Account'}));
    await user.click(screen.getByRole('menuitem', {name: 'Connect agent'}));

    expect(await screen.findByRole('dialog', {name: 'Connect an agent'})).toBeInTheDocument();
  });
});

describe('BoardScreen — play and stop', () => {
  it('queues a story for pickup when Start is pressed', async () => {
    const user = userEvent.setup();
    const fetchMock = serveBoard(makeBoard({stories: [makeStory({id: 's1', status: 'todo', title: 'Queued one'})]}));
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/board') {
        return jsonResponse(200, makeBoard({stories: [makeStory({id: 's1', status: 'todo', title: 'Queued one'})]}));
      }
      if (path === '/api/stories/s1/play' && init?.method === 'POST') {
        return jsonResponse(200, makeStory({id: 's1', status: 'todo', title: 'Queued one', playRequestedAt: 1}));
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByText('Queued one');

    await user.click(screen.getByRole('button', {name: 'Start Queued one'}));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/stories/s1/play', expect.objectContaining({method: 'POST'})),
    );
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('asks a running story to stop when Stop is pressed', async () => {
    const user = userEvent.setup();
    const fetchMock = serveBoard(
      makeBoard({stories: [makeStory({id: 's1', status: 'in_progress', title: 'Running one'})]}),
    );
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/board') {
        return jsonResponse(200, makeBoard({stories: [makeStory({id: 's1', status: 'in_progress', title: 'Running one'})]}));
      }
      if (path === '/api/stories/s1/stop' && init?.method === 'POST') {
        return jsonResponse(200, makeStory({id: 's1', status: 'in_progress', title: 'Running one', stopRequested: true}));
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByText('Running one');

    await user.click(screen.getByRole('button', {name: 'Stop Running one'}));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/stories/s1/stop', expect.objectContaining({method: 'POST'})),
    );
    expect(await screen.findByText('Stopping…')).toBeInTheDocument();
  });

  it('shows a refused play as a dismissable toast', async () => {
    const user = userEvent.setup();
    const fetchMock = serveBoard(makeBoard({stories: [makeStory({id: 's1', status: 'todo', title: 'Blocked one'})]}));
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/board') {
        return jsonResponse(200, makeBoard({stories: [makeStory({id: 's1', status: 'todo', title: 'Blocked one'})]}));
      }
      if (path === '/api/stories/s1/play' && init?.method === 'POST') {
        return jsonResponse(404, {error: 'not_found'});
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByText('Blocked one');

    await user.click(screen.getByRole('button', {name: 'Start Blocked one'}));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That is no longer there — it may have been deleted.");
  });
});

describe('BoardScreen — story dialogs', () => {
  it('opens the create dialog from "New story"', async () => {
    const user = userEvent.setup();
    serveBoard(makeBoard());
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByRole('heading', {name: /Draft/});

    await user.click(screen.getByRole('button', {name: 'New story'}));

    expect(await screen.findByRole('dialog', {name: 'New story'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Add to draft'})).toBeInTheDocument();
  });

  it('opens the edit dialog, pre-filled, from a draft card', async () => {
    const user = userEvent.setup();
    serveBoard(makeBoard({stories: [makeStory({id: 's1', status: 'draft', title: 'Sketch it'})]}));
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByText('Sketch it');

    await user.click(screen.getByRole('button', {name: 'Edit Sketch it'}));

    const dialog = await screen.findByRole('dialog', {name: 'Edit story'});
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Sketch it');
  });

  it('opens the detail dialog from a card', async () => {
    const user = userEvent.setup();
    const board = makeBoard({
      stories: [makeStory({id: 's1', status: 'todo', title: 'Queued one', progressPct: 10, progressLabel: 'Reading'})],
    });
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/board') return jsonResponse(200, board);
      if (path === '/api/stories/s1/updates') return jsonResponse(200, []);
      throw new Error(`unexpected request: ${path}`);
    });
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByText('Queued one');

    await user.click(screen.getByRole('button', {name: 'Queued one'}));

    expect(await screen.findByRole('dialog', {name: 'Queued one'})).toBeInTheDocument();
  });

  it('deletes a draft story from its card', async () => {
    const user = userEvent.setup();
    const fetchMock = serveBoard(makeBoard({stories: [makeStory({id: 's1', status: 'draft', title: 'Sketch it'})]}));
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/board') return jsonResponse(200, makeBoard({stories: [makeStory({id: 's1', status: 'draft', title: 'Sketch it'})]}));
      if (path === '/api/stories/s1' && init?.method === 'DELETE') return jsonResponse(204);
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    renderWithClient(<BoardScreen user={USER} />);
    await screen.findByText('Sketch it');

    await user.click(screen.getByRole('button', {name: 'Delete Sketch it'}));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/stories/s1', expect.objectContaining({method: 'DELETE'})),
    );
    await waitFor(() => expect(screen.queryByText('Sketch it')).not.toBeInTheDocument());
  });
});

describe('MoveErrorToast', () => {
  it('names the reason the move was refused and can be dismissed', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderWithClient(
      <MoveErrorToast message="Agents cannot accept stories — only a human can." onDismiss={onDismiss} />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Agents cannot accept stories — only a human can.');

    await user.click(within(alert).getByRole('button', {name: 'Dismiss'}));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
