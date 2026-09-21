import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ConsentScreen} from './ConsentScreen.js';
import {jsonResponse, mockFetch, renderWithClient} from '../testing/render.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SEARCH =
  '?response_type=code&client_id=cid-123&redirect_uri=http%3A%2F%2F127.0.0.1%3A41234%2Fcallback' +
  '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=xyz';

function consentBody(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'cid-123',
    clientName: 'Claude Code',
    redirectUri: 'http://127.0.0.1:41234/callback',
    permissions: [
      {id: 'board:read', label: 'Read your board'},
      {id: 'board:write', label: 'Create and move stories'},
      {id: 'updates:write', label: 'Post progress updates'},
    ],
    defaultAgentName: 'Claude Code',
    maxAgentNameLength: 60,
    ...overrides,
  };
}

/** Routes the screen's two requests: the description, then the decision. */
function routeFetch(options: {description?: () => Response; decision?: () => Response} = {}) {
  const fetchMock = mockFetch();
  fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/oauth/consent')) {
      return (options.description ?? (() => jsonResponse(200, consentBody())))();
    }
    if (path === '/oauth/authorize' && init?.method === 'POST') {
      return (
        options.decision ?? (() => jsonResponse(200, {redirectTo: 'http://127.0.0.1:41234/callback?code=abc&state=xyz'}))
      )();
    }
    throw new Error(`unexpected request: ${path}`);
  });
  return fetchMock;
}

function renderConsent(navigate = vi.fn()) {
  renderWithClient(<ConsentScreen search={SEARCH} navigate={navigate} />);
  return navigate;
}

describe('ConsentScreen', () => {
  it('states who is asking, for what, and offers both answers', async () => {
    routeFetch();
    renderConsent();

    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Read your board')).toBeInTheDocument();
    expect(screen.getByText('Create and move stories')).toBeInTheDocument();
    expect(screen.getByText('Post progress updates')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Allow'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Deny'})).toBeInTheDocument();
    // The callback the code would be handed to is on screen, not hidden.
    expect(screen.getByText('http://127.0.0.1:41234/callback')).toBeInTheDocument();
  });

  it('defaults the agent name to Claude Code and lets it be edited', async () => {
    const user = userEvent.setup();
    routeFetch();
    renderConsent();

    const field = (await screen.findByLabelText('Agent name')) as HTMLInputElement;
    expect(field.value).toBe('Claude Code');

    await user.clear(field);
    await user.type(field, 'Night shift');
    expect(field.value).toBe('Night shift');
  });

  it('renders a hostile client name as text, never as markup', async () => {
    const hostile = '<img src=x onerror="alert(1)">agent-jira official';
    routeFetch({description: () => jsonResponse(200, consentBody({clientName: hostile}))});
    renderConsent();

    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('keeps a long client name from breaking out of its own box', async () => {
    const long = `${'Definitely-Not-Evil-'.repeat(5)}Client`;
    routeFetch({description: () => jsonResponse(200, consentBody({clientName: long}))});
    renderConsent();

    const name = await screen.findByText(long);
    // Wraps inside its container instead of pushing the buttons off screen.
    expect(name.className).toMatch(/break-/);
    expect(screen.getByRole('button', {name: 'Allow'})).toBeInTheDocument();
  });

  it('sends the decision and the agent name when Allow is pressed', async () => {
    const user = userEvent.setup();
    const fetchMock = routeFetch();
    const navigate = renderConsent();

    const field = await screen.findByLabelText('Agent name');
    await user.clear(field);
    await user.type(field, 'Night shift');
    await user.click(screen.getByRole('button', {name: 'Allow'}));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('http://127.0.0.1:41234/callback?code=abc&state=xyz'));

    const call = fetchMock.mock.calls.find((call: unknown[]) => call[0] === '/oauth/authorize');
    expect(call).toBeTruthy();
    const sent = JSON.parse((call![1] as RequestInit).body as string);
    expect(sent.decision).toBe('allow');
    expect(sent.agent_name).toBe('Night shift');
    expect(sent.client_id).toBe('cid-123');
    expect(sent.redirect_uri).toBe('http://127.0.0.1:41234/callback');
    expect(sent.code_challenge_method).toBe('S256');
    expect(sent.state).toBe('xyz');
    // JSON only — a cross-origin form can never produce this content type.
    expect((call![1] as {headers: Record<string, string>}).headers['Content-Type']).toBe('application/json');
  });

  it('sends a refusal when Deny is pressed', async () => {
    const user = userEvent.setup();
    const fetchMock = routeFetch({
      decision: () => jsonResponse(200, {redirectTo: 'http://127.0.0.1:41234/callback?error=access_denied&state=xyz'}),
    });
    const navigate = renderConsent();

    await user.click(await screen.findByRole('button', {name: 'Deny'}));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('http://127.0.0.1:41234/callback?error=access_denied&state=xyz'),
    );
    const call = fetchMock.mock.calls.find((call: unknown[]) => call[0] === '/oauth/authorize');
    expect(JSON.parse((call![1] as RequestInit).body as string).decision).toBe('deny');
  });

  it('offers nothing to approve while the request is still being checked', () => {
    routeFetch();
    renderConsent();

    expect(screen.queryByRole('button', {name: 'Allow'})).toBeNull();
  });

  it('refuses to show a consent form for an invalid request', async () => {
    routeFetch({
      description: () =>
        jsonResponse(400, {error: 'invalid_request', error_description: 'The authorization request is invalid.'}),
    });
    renderConsent();

    expect(await screen.findByRole('heading', {name: /can.t authorize/i})).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Allow'})).toBeNull();
    expect(screen.queryByLabelText('Agent name')).toBeNull();
  });

  it('sends an expired session back to sign in and returns here', async () => {
    routeFetch({description: () => jsonResponse(401, {error: 'unauthorized'})});
    const navigate = renderConsent();

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/?next=${encodeURIComponent(`/consent${SEARCH}`)}`));
  });

  it('keeps the form on screen and explains itself when the decision fails', async () => {
    const user = userEvent.setup();
    routeFetch({decision: () => jsonResponse(400, {error: 'invalid_request'})});
    const navigate = renderConsent();

    await user.click(await screen.findByRole('button', {name: 'Allow'}));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', {name: 'Allow'})).toBeInTheDocument();
  });
});
