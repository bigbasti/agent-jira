import {useMemo} from 'react';
import type {User} from '../../shared/types.js';
import {AgentStrip} from '../components/board/AgentStrip.js';
import {Board} from '../components/board/Board.js';
import type {StoryActions} from '../components/board/StoryCard.js';
import {TopBar} from '../components/board/TopBar.js';
import {Button} from '../components/ui/Button.js';
import {useBoard, useMoveStory} from '../lib/board-queries.js';
import {useLogout} from '../lib/queries.js';

/** Tasks 10 and 14 replace these with the story dialogs and the play/stop mutations. */
function notWiredYet() {}

export function BoardScreen({user}: {user: User}) {
  const board = useBoard();
  const move = useMoveStory();
  const logout = useLogout();

  const actions = useMemo<StoryActions>(
    () => ({
      onOpen: notWiredYet,
      onEdit: notWiredYet,
      onDelete: notWiredYet,
      onPlay: notWiredYet,
      onStop: notWiredYet,
    }),
    [],
  );

  const stories = board.data?.stories ?? [];

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar
        email={user.email}
        status={board.isPending ? 'Loading the board…' : ''}
        onNewStory={notWiredYet}
        onConnectAgent={notWiredYet}
        onLogout={() => logout.mutate()}
        loggingOut={logout.isPending}
      />
      <AgentStrip agents={board.data?.agents ?? []} stories={stories} onConnectAgent={notWiredYet} />

      <main className="min-h-0 flex-1 pt-4">
        {board.isError ? (
          <BoardUnavailable message={board.error.message} onRetry={() => void board.refetch()} />
        ) : (
          <Board
            stories={stories}
            projects={board.data?.projects ?? []}
            agents={board.data?.agents ?? []}
            actions={actions}
            onMove={request => move.mutate(request)}
          />
        )}
      </main>

      {move.isError && <MoveErrorToast message={move.error.message} onDismiss={() => move.reset()} />}
    </div>
  );
}

function BoardUnavailable({message, onRetry}: {message: string; onRetry: () => void}) {
  return (
    <div className="flex h-full items-start justify-center px-4">
      <div role="alert" className="max-w-sm rounded-card border border-hairline bg-surface p-5 text-center">
        <h1 className="text-lede font-semibold text-text">The board didn't load</h1>
        <p className="mt-2 text-body text-muted">{message}</p>
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

/**
 * A refused drag. The card has already snapped back by the time this appears, so the
 * toast's whole job is to say why, in the server's own words. It stays until it is
 * dismissed or replaced — a rule the human just ran into is worth reading.
 */
export function MoveErrorToast({message, onDismiss}: {message: string; onDismiss: () => void}) {
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-card border border-rose/40 bg-surface py-2 pr-2 pl-3"
    >
      <span className="min-w-0 text-label text-text">{message}</span>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
