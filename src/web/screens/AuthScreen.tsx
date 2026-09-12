import {useId, useRef, useState, type FormEvent, type KeyboardEvent} from 'react';
import clsx from 'clsx';
import {ThemeToggle} from '../components/ThemeToggle.js';
import {Wordmark} from '../components/Wordmark.js';
import {Button} from '../components/ui/Button.js';
import {Input} from '../components/ui/Input.js';
import {ApiError} from '../lib/api.js';
import {useLogin, useRegister} from '../lib/queries.js';

type Mode = 'signin' | 'register';

const MODES: {id: Mode; label: string; pendingLabel: string}[] = [
  {id: 'signin', label: 'Sign in', pendingLabel: 'Signing in…'},
  {id: 'register', label: 'Create account', pendingLabel: 'Creating account…'},
];

const MIN_PASSWORD_LENGTH = 12;

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const tablist = useRef<HTMLDivElement>(null);

  const headingId = useId();
  const formId = useId();

  const login = useLogin();
  const register = useRegister();
  const active = mode === 'signin' ? login : register;
  const copy = MODES.find(entry => entry.id === mode) ?? MODES[0]!;

  const serverError =
    active.error instanceof ApiError
      ? active.error.message
      : active.error
        ? 'Something went wrong. Try again.'
        : null;
  const message = formError ?? serverError;

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setFormError(null);
    login.reset();
    register.reset();
  }

  function onTablistKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();

    const index = MODES.findIndex(entry => entry.id === mode);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? MODES.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length;

    switchMode(MODES[next]!.id);
    tablist.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();

    if (!address.includes('@')) {
      setFormError('Enter the email address for your account.');
      return;
    }
    if (mode === 'register' && password.length < MIN_PASSWORD_LENGTH) {
      setFormError(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setFormError(null);
    active.mutate({email: address, password});
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div aria-hidden="true" className="drafting-grid pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-[23rem]">
        <header className="mb-7 px-1">
          <h1>
            <Wordmark size="hero" caret />
          </h1>
          <p className="mt-2 text-body text-muted">
            Write the stories. Your agents claim the work.
          </p>
        </header>

        <section className="rounded-card border border-hairline bg-surface p-5">
          <h2 id={headingId} className="sr-only">
            {copy.label}
          </h2>

          <div
            ref={tablist}
            role="tablist"
            aria-label="Account"
            onKeyDown={onTablistKeyDown}
            className="grid grid-cols-2 gap-1 rounded-well border border-hairline bg-well p-1"
          >
            {MODES.map(entry => {
              const selected = entry.id === mode;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`${headingId}-${entry.id}`}
                  aria-selected={selected}
                  aria-controls={formId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => switchMode(entry.id)}
                  className={clsx(
                    'h-8 rounded-chip text-label font-medium transition-colors duration-150 ease-console',
                    selected ? 'bg-raised text-text' : 'text-muted hover:text-text',
                  )}
                >
                  {entry.label}
                </button>
              );
            })}
          </div>

          <form
            id={formId}
            role="tabpanel"
            aria-labelledby={headingId}
            onSubmit={onSubmit}
            noValidate
            className="mt-5 flex flex-col gap-4"
          >
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              autoFocus
              spellCheck={false}
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
            <Input
              label="Password"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              // The rule is on screen before the first keystroke, not after a rejection.
              hint={mode === 'register' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
              value={password}
              onChange={event => setPassword(event.target.value)}
            />

            {message && (
              <p
                role="alert"
                className="rounded-well border border-rose/35 bg-rose-wash px-3 py-2 text-label text-rose"
              >
                {message}
              </p>
            )}

            <Button type="submit" variant="primary" disabled={active.isPending} className="mt-1 w-full">
              {active.isPending ? copy.pendingLabel : copy.label}
            </Button>
          </form>
        </section>

        <div className="mt-4 flex justify-end px-1">
          <ThemeToggle />
        </div>
      </div>
    </main>
  );
}
