import {useEffect, useMemo, useState} from 'react';
import type {Story, User} from '../../shared/types.js';
import {AgentStrip} from '../components/board/AgentStrip.js';
import {Board} from '../components/board/Board.js';
import type {StoryActions} from '../components/board/StoryCard.js';
import {TopBar} from '../components/board/TopBar.js';
import {Button} from '../components/ui/Button.js';
import {ConnectAgentDialog} from '../components/agent/ConnectAgentDialog.js';
import {StoryDetailDialog} from '../components/story/StoryDetailDialog.js';
import {StoryFormDialog} from '../components/story/StoryFormDialog.js';
import {useConfig} from '../lib/agent-queries.js';
import {useBoard, useDeleteStory, useMoveStory, usePlayStory, useStopStory} from '../lib/board-queries.js';
import {useLiveBoard} from '../lib/useLiveBoard.js';
import {useLogout} from '../lib/queries.js';

export function BoardScreen({user}: {user: User}) {
  const board = useBoard();
  const move = useMoveStory();
  const deleteStory = useDeleteStory();
  const playStory = usePlayStory();
  const stopStory = useStopStory();
  const logout = useLogout();
  const live = useLiveBoard();

  const [creatingStory, setCreatingStory] = useState(false);
  const [editingStory, setEditingStory] = useState<Story | null>(null);
  const [openStoryId, setOpenStoryId] = useState<string | null>(null);
  const [connectingAgent, setConnectingAgent] = useState(false);

  // Fetched only once the dialog is actually opened — no reason to pay a config round
  // trip on every board load for a dialog most visits never open.
  const config = useConfig(connectingAgent);

  // "Reconnecting…" only means something once a first connection has actually happened —
  // without this, the socket's brief moment of not-yet-open on mount would flash the same
  // label the board shows after a real drop.
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (live.connected) setEverConnected(true);
  }, [live.connected]);

  const actions = useMemo<StoryActions>(
    () => ({
      onOpen: story => setOpenStoryId(story.id),
      onEdit: story => setEditingStory(story),
      onDelete: story => deleteStory.mutate(story.id),
      onPlay: story => playStory.mutate(story.id),
      onStop: story => stopStory.mutate(story.id),
    }),
    [deleteStory, playStory, stopStory],
  );

  const stories = board.data?.stories ?? [];
  const openConnectAgent = () => setConnectingAgent(true);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar
        email={user.email}
        status={
          board.isPending ? 'Loading the board…' : everConnected && !live.connected ? 'Reconnecting…' : ''
        }
        onNewStory={() => setCreatingStory(true)}
        onConnectAgent={openConnectAgent}
        onLogout={() => logout.mutate()}
        loggingOut={logout.isPending}
      />
      <AgentStrip agents={board.data?.agents ?? []} stories={stories} onConnectAgent={openConnectAgent} />

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
      {deleteStory.isError && (
        <MoveErrorToast message={deleteStory.error.message} onDismiss={() => deleteStory.reset()} />
      )}
      {playStory.isError && (
        <MoveErrorToast message={playStory.error.message} onDismiss={() => playStory.reset()} />
      )}
      {stopStory.isError && (
        <MoveErrorToast message={stopStory.error.message} onDismiss={() => stopStory.reset()} />
      )}

      <StoryFormDialog mode="create" open={creatingStory} onOpenChange={setCreatingStory} />
      <StoryFormDialog
        mode="edit"
        story={editingStory ?? undefined}
        open={editingStory !== null}
        onOpenChange={open => !open && setEditingStory(null)}
      />
      {openStoryId && (
        <StoryDetailDialog
          storyId={openStoryId}
          open={true}
          onOpenChange={open => !open && setOpenStoryId(null)}
        />
      )}
      <ConnectAgentDialog
        open={connectingAgent}
        onOpenChange={setConnectingAgent}
        config={config.data}
        configError={config.isError}
        onRetryConfig={() => void config.refetch()}
        agents={board.data?.agents ?? []}
      />
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
