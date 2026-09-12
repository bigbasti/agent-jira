import type {User} from '../../shared/types.js';
import {ThemeToggle} from '../components/ThemeToggle.js';
import {Wordmark} from '../components/Wordmark.js';
import {Button} from '../components/ui/Button.js';
import {useLogout} from '../lib/queries.js';

/**
 * Placeholder shell. Task 9 replaces the body with the board; the header and the session
 * controls here are what the rest of the app hangs off.
 */
export function BoardScreen({user}: {user: User}) {
  const logout = useLogout();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-13 shrink-0 items-center gap-3 border-b border-hairline px-4">
        <Wordmark />
        <span className="ml-auto min-w-0 truncate font-mono text-micro text-muted">{user.email}</span>
        <ThemeToggle />
        <Button size="sm" variant="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Log out
        </Button>
      </header>

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md rounded-card border border-dashed border-hairline px-6 py-10 text-center">
          <h1 className="text-title text-text">Board</h1>
          <p className="mt-2 text-body text-muted">
            Nothing here yet. Columns, stories and agent lanes arrive in the next build.
          </p>
          {logout.isError && (
            <p role="alert" className="mt-4 text-label text-rose">
              Logging out failed. Try again.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
