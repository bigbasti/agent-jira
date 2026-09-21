import {useEffect} from 'react';
import {Wordmark} from './components/Wordmark.js';
import {safeNextPath} from './lib/next-path.js';
import {useMe} from './lib/queries.js';
import {AuthScreen} from './screens/AuthScreen.js';
import {BoardScreen} from './screens/BoardScreen.js';
import {ConsentScreen} from './screens/ConsentScreen.js';

/**
 * No router by design: the app is a single screen tree plus one standalone path. The
 * OAuth consent view is that path — it is reached only by a redirect from
 * `GET /oauth/authorize`, and it must never share a frame with the board.
 */
export function App() {
  if (window.location.pathname === '/consent') return <ConsentScreen />;

  return <Session />;
}

function Session() {
  const me = useMe();
  const signedIn = Boolean(me.data);

  // `GET /oauth/authorize` sends an unauthenticated browser here with the request it
  // interrupted parked in `next`. Once there is a session, hand it back — a full page
  // load, because the destination is a server route, not a screen in this tree.
  useEffect(() => {
    if (!signedIn) return;
    const next = safeNextPath(window.location.search);
    if (next) window.location.assign(next);
  }, [signedIn]);

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
