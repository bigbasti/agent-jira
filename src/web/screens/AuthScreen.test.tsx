import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AuthScreen} from './AuthScreen.js';
import {deferred, jsonResponse, mockFetch, renderWithClient} from '../testing/render.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const USER = {id: 'u1', email: 'dev@example.com', createdAt: 1};

async function fillCredentials(user: ReturnType<typeof userEvent.setup>, password = 'correct-horse-battery') {
  await user.type(screen.getByLabelText('Email'), 'dev@example.com');
  await user.type(screen.getByLabelText('Password'), password);
}

describe('AuthScreen', () => {
  it('switches between sign in and create account', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithClient(<AuthScreen />);

    expect(screen.getByRole('heading', {name: 'Sign in'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Sign in'})).toBeInTheDocument();

    await user.click(screen.getByRole('tab', {name: 'Create account'}));

    expect(screen.getByRole('heading', {name: 'Create account'})).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Create account'})).toBeInTheDocument();
    expect(screen.getByRole('tab', {name: 'Create account'})).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', {name: 'Sign in'}));

    expect(screen.getByRole('heading', {name: 'Sign in'})).toBeInTheDocument();
  });

  it('states the password rule before anything is submitted', async () => {
    const user = userEvent.setup();
    mockFetch();
    renderWithClient(<AuthScreen />);

    await user.click(screen.getByRole('tab', {name: 'Create account'}));

    const hint = screen.getByText('At least 12 characters.');
    expect(hint).toBeVisible();
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('At least 12 characters.');
  });

  it('marks the field that failed validation and moves focus to it', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderWithClient(<AuthScreen />);

    await user.click(screen.getByRole('tab', {name: 'Create account'}));
    await fillCredentials(user, 'tooshort');
    await user.click(screen.getByRole('button', {name: 'Create account'}));

    const passwordField = screen.getByLabelText('Password');
    expect(passwordField).toHaveAttribute('aria-invalid', 'true');
    expect(passwordField).toHaveAccessibleDescription(
      'At least 12 characters. Passwords need at least 12 characters.',
    );
    expect(passwordField).toHaveFocus();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a server error message', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(401, {error: 'invalid_credentials'}));
    renderWithClient(<AuthScreen />);

    await fillCredentials(user);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("That email and password don't match an account.");
    expect(screen.queryByText(/invalid_credentials/)).toBeNull();
  });

  it('explains a taken email when creating an account', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(409, {error: 'conflict'}));
    renderWithClient(<AuthScreen />);

    await user.click(screen.getByRole('tab', {name: 'Create account'}));
    await fillCredentials(user);
    await user.click(screen.getByRole('button', {name: 'Create account'}));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email is already registered. Sign in instead.',
    );
  });

  it('disables submit while the request is in flight', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const {client} = renderWithClient(<AuthScreen />);

    await fillCredentials(user);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));

    const submit = await screen.findByRole('button', {name: /signing in/i});
    expect(submit).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(jsonResponse(200, USER));

    await waitFor(() => expect(client.getQueryData(['me'])).toEqual(USER));
  });

  it('sends the credentials to the login endpoint', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(200, USER));
    renderWithClient(<AuthScreen />);

    await fillCredentials(user, 'correct-horse-battery');
    await user.click(screen.getByRole('button', {name: 'Sign in'}));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/auth/login');
    expect(init.body).toBe(
      JSON.stringify({email: 'dev@example.com', password: 'correct-horse-battery'}),
    );
  });

  it('registers against the register endpoint', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(201, USER));
    renderWithClient(<AuthScreen />);

    await user.click(screen.getByRole('tab', {name: 'Create account'}));
    await fillCredentials(user);
    await user.click(screen.getByRole('button', {name: 'Create account'}));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/register');
  });
});
