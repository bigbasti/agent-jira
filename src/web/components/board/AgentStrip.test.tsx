import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AgentStrip} from './AgentStrip.js';
import {makeAgent, makeStory} from '../../testing/fixtures.js';
import {jsonResponse, mockFetch, renderWithClient} from '../../testing/render.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentStrip', () => {
  it('renders an empty state when no agents are connected', () => {
    mockFetch();
    const onConnectAgent = vi.fn();
    renderWithClient(<AgentStrip agents={[]} stories={[]} onConnectAgent={onConnectAgent} />);

    expect(screen.getByText(/No agents connected/)).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Connect an agent'})).toBeInTheDocument();
  });

  it("shows each agent's status and current story", () => {
    mockFetch();
    const story = makeStory({id: 's1', title: 'Wire the board'});
    const agent = makeAgent({id: 'a1', name: 'Night shift', status: 'working', currentStoryId: 's1'});

    renderWithClient(<AgentStrip agents={[agent]} stories={[story]} onConnectAgent={() => {}} />);

    expect(screen.getByText('Night shift')).toBeInTheDocument();
    expect(screen.getByText('working')).toBeInTheDocument();
    expect(screen.getByText('Wire the board')).toBeInTheDocument();
  });

  it('shows no current-story caption for an idle agent holding nothing', () => {
    mockFetch();
    const agent = makeAgent({id: 'a1', name: 'Night shift', status: 'idle', currentStoryId: null});

    renderWithClient(<AgentStrip agents={[agent]} stories={[]} onConnectAgent={() => {}} />);

    expect(screen.getByText('Night shift')).toBeInTheDocument();
    expect(screen.queryByText('Wire the board')).not.toBeInTheDocument();
  });

  it('toggles autonomous mode', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === 'PATCH' && path === '/api/agents/a1') {
        expect(init.body).toBe(JSON.stringify({autonomous: true}));
        return jsonResponse(200, makeAgent({id: 'a1', autonomous: true}));
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const user = userEvent.setup();
    const agent = makeAgent({id: 'a1', name: 'Night shift', autonomous: false});

    renderWithClient(<AgentStrip agents={[agent]} stories={[]} onConnectAgent={() => {}} />);

    const toggle = screen.getByRole('switch', {name: 'Autonomous'});
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1', expect.objectContaining({method: 'PATCH'})),
    );
  });

  it('says so when the autonomous switch could not be saved', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(500, {error: 'internal_error', message: 'The board server is down.'}));
    const user = userEvent.setup();
    const agent = makeAgent({id: 'a1', name: 'Night shift', autonomous: false});

    renderWithClient(<AgentStrip agents={[agent]} stories={[]} onConnectAgent={() => {}} />);
    await user.click(screen.getByRole('switch', {name: 'Autonomous'}));

    // Without this the switch just flips back and the human is told nothing.
    expect(await screen.findByRole('alert')).toHaveTextContent(/autonomous/i);
    expect(screen.getByRole('switch', {name: 'Autonomous'})).not.toBeChecked();
  });

  it('opens the connect dialog from the empty state', async () => {
    mockFetch();
    const user = userEvent.setup();
    const onConnectAgent = vi.fn();

    renderWithClient(<AgentStrip agents={[]} stories={[]} onConnectAgent={onConnectAgent} />);

    await user.click(screen.getByRole('button', {name: 'Connect an agent'}));

    expect(onConnectAgent).toHaveBeenCalledTimes(1);
  });
});
