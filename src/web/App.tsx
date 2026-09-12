import {Wordmark} from './components/Wordmark.js';
import {useMe} from './lib/queries.js';
import {AuthScreen} from './screens/AuthScreen.js';
import {BoardScreen} from './screens/BoardScreen.js';

/**
 * No router by design: the app is a single screen tree plus one standalone path. Task 12
 * adds the OAuth consent view as the other branch of this switch:
 *
 *   if (window.location.pathname === '/consent') return <ConsentScreen />;
 */
export function App() {
  return <Session />;
}

function Session() {
  const me = useMe();

  if (me.isPending) return <Booting />;
  if (me.isError) return <SessionUnavailable />;

  return me.data ? <BoardScreen user={me.data} /> : <AuthScreen />;
}

/** The first paint while `/api/me` is in flight: the wordmark, and nothing else. */
function Booting() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Wordmark size="hero" className="opacity-40" />
    </div>
  );
}

function SessionUnavailable() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-sm rounded-card border border-hairline bg-surface p-5 text-center">
        <h1 className="text-lede font-semibold text-text">Can't reach the server</h1>
        <p className="mt-2 text-body text-muted">
          The board is offline or the connection dropped. Reload once it is back.
        </p>
      </div>
    </main>
  );
}
