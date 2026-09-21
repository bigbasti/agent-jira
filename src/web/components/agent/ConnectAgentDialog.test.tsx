import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ConnectAgentDialog} from './ConnectAgentDialog.js';
import {makeAgent} from '../../testing/fixtures.js';
import {jsonResponse, mockFetch, renderWithClient} from '../../testing/render.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const MCP_URL = 'https://board.example/mcp';

function renderDialog(agents = [] as ReturnType<typeof makeAgent>[]) {
  mockFetch();
  return renderWithClient(
    <ConnectAgentDialog open onOpenChange={() => {}} config={{mcpUrl: MCP_URL}} agents={agents} />,
  );
}

describe('ConnectAgentDialog', () => {
  it('shows the full mcp url from server config', () => {
    renderDialog();

    expect(screen.getByText(MCP_URL)).toBeInTheDocument();
  });

  it('shows the copyable claude mcp add command', () => {
    renderDialog();

    expect(screen.getByText(`claude mcp add --transport http agent-jira ${MCP_URL}`)).toBeInTheDocument();
  });

  it('copies the command to the clipboard', async () => {
    // `userEvent.setup()` installs its own clipboard stub on `navigator.clipboard` for its
    // copy/paste emulation, so the mock must be installed *after* setup or it gets
    // overwritten.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
    renderDialog();

    await user.click(screen.getByRole('button', {name: 'Copy'}));

    expect(writeText).toHaveBeenCalledWith(`claude mcp add --transport http agent-jira ${MCP_URL}`);
    expect(await screen.findByRole('button', {name: 'Copied'})).toBeInTheDocument();
  });

  it('lists connected agents with a revoke button', () => {
    renderDialog([makeAgent({id: 'a1', name: 'Night shift'})]);

    expect(screen.getByText('Night shift')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Revoke Night shift'})).toBeInTheDocument();
  });

  it('shows an empty state when no agents are connected yet', () => {
    renderDialog([]);

    expect(screen.getByText(/no agents connected/i)).toBeInTheDocument();
  });

  it('explains the consent step', () => {
    renderDialog();

    const steps = screen.getByText(/browser/i).closest('section') ?? document.body;
    expect(steps.textContent).toMatch(/browser/i);
    expect(steps.textContent).toMatch(/Allow/);
  });

  it('revokes an agent when Revoke is pressed', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === 'DELETE' && path === '/api/agents/a1') return jsonResponse(204);
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    const user = userEvent.setup();
    renderWithClient(
      <ConnectAgentDialog
        open
        onOpenChange={() => {}}
        config={{mcpUrl: MCP_URL}}
        agents={[makeAgent({id: 'a1', name: 'Night shift'})]}
      />,
    );

    await user.click(screen.getByRole('button', {name: 'Revoke Night shift'}));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1', expect.objectContaining({method: 'DELETE'})),
    );
  });

  it('shows a loading placeholder rather than an empty string before config has loaded', () => {
    mockFetch();
    renderWithClient(<ConnectAgentDialog open onOpenChange={() => {}} agents={[]} />);

    expect(screen.queryByText(/claude mcp add --transport http agent-jira\s*$/)).not.toBeInTheDocument();
  });
});
