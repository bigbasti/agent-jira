import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import {StoryCard} from './StoryCard.js';
import {makeStory} from '../../testing/fixtures.js';
import type {Story} from '../../../shared/types.js';

const storySpy = () => vi.fn<(story: Story) => void>();

function spyActions() {
  return {onOpen: storySpy(), onEdit: storySpy(), onDelete: storySpy(), onPlay: storySpy(), onStop: storySpy()};
}

function renderCard(story: Story, extra: {projectName?: string; agentName?: string; blockers?: Story[]} = {}) {
  const actions = spyActions();
  render(
    <StoryCard
      story={story}
      projectName={extra.projectName}
      agentName={extra.agentName}
      blockers={extra.blockers ?? []}
      actions={actions}
    />,
  );
  return actions;
}

describe('StoryCard', () => {
  it('shows title, model and project', () => {
    renderCard(makeStory({id: 's1', title: 'Wire the board', model: 'claude-opus-5'}), {
      projectName: 'agent-jira',
    });

    expect(screen.getByText('Wire the board')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 5')).toBeInTheDocument();
    expect(screen.getByText('agent-jira')).toBeInTheDocument();
  });

  it('falls back to the raw model id when the model is not one we know', () => {
    renderCard(makeStory({id: 's1', model: 'some-local-llm'}));

    expect(screen.getByText('some-local-llm')).toBeInTheDocument();
  });

  it('shows edit and delete only in draft', async () => {
    const user = userEvent.setup();
    const actions = renderCard(makeStory({id: 's1', title: 'Draft one', status: 'draft'}));

    await user.click(screen.getByRole('button', {name: 'Edit Draft one'}));
    await user.click(screen.getByRole('button', {name: 'Delete Draft one'}));

    expect(actions.onEdit).toHaveBeenCalledWith(expect.objectContaining({id: 's1'}));
    expect(actions.onDelete).toHaveBeenCalledWith(expect.objectContaining({id: 's1'}));
    expect(screen.queryByRole('button', {name: /^Start/})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /^Stop/})).not.toBeInTheDocument();
  });

  it('hides edit and delete outside draft', () => {
    renderCard(makeStory({id: 's1', title: 'Queued one', status: 'todo'}));

    expect(screen.queryByRole('button', {name: /^Edit/})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /^Delete/})).not.toBeInTheDocument();
  });

  it('shows play only in todo, and disables it when blocked', async () => {
    const user = userEvent.setup();
    const actions = renderCard(makeStory({id: 's1', title: 'Queued one', status: 'todo'}));

    const play = screen.getByRole('button', {name: 'Start Queued one'});
    expect(play).toBeEnabled();
    await user.click(play);
    expect(actions.onPlay).toHaveBeenCalledWith(expect.objectContaining({id: 's1'}));
  });

  it('disables play while the story is blocked', () => {
    const blocker = makeStory({id: 's9', title: 'Design the schema'});
    renderCard(makeStory({id: 's1', title: 'Queued one', status: 'todo', blockedBy: ['s9']}), {
      blockers: [blocker],
    });

    expect(screen.getByRole('button', {name: 'Start Queued one'})).toBeDisabled();
  });

  it('shows no play button outside todo', () => {
    renderCard(makeStory({id: 's1', title: 'Running one', status: 'in_progress'}));

    expect(screen.queryByRole('button', {name: /^Start/})).not.toBeInTheDocument();
  });

  it('shows stop in in_progress and in_test', async () => {
    const user = userEvent.setup();

    const running = renderCard(makeStory({id: 's1', title: 'Running one', status: 'in_progress'}));
    await user.click(screen.getByRole('button', {name: 'Stop Running one'}));
    expect(running.onStop).toHaveBeenCalledWith(expect.objectContaining({id: 's1'}));

    renderCard(makeStory({id: 's2', title: 'Testing one', status: 'in_test'}));
    expect(screen.getByRole('button', {name: 'Stop Testing one'})).toBeInTheDocument();
  });

  it('shows no stop button in the columns the human owns', () => {
    renderCard(makeStory({id: 's1', title: 'Done one', status: 'finished'}));

    expect(screen.queryByRole('button', {name: /^Stop/})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: /^Start/})).not.toBeInTheDocument();
  });

  it('renders the progress bar only when progress > 0', () => {
    const {unmount} = render(
      <StoryCard story={makeStory({id: 's1', progressPct: 0})} blockers={[]} actions={spyActions()} />,
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    unmount();

    renderCard(
      makeStory({id: 's1', status: 'in_progress', progressPct: 42, progressLabel: 'Writing tests'}),
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAccessibleName('Writing tests');
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('lists blocking story titles in the blocked chip tooltip', () => {
    const blockers = [
      makeStory({id: 's8', title: 'Design the schema'}),
      makeStory({id: 's9', title: 'Ship the API'}),
    ];
    renderCard(makeStory({id: 's1', status: 'todo', blockedBy: ['s8', 's9']}), {blockers});

    const chip = screen.getByText('Blocked');
    expect(chip).toHaveAccessibleDescription('Blocked by Design the schema, Ship the API');
    expect(chip).toHaveAttribute('title', 'Blocked by Design the schema, Ship the API');
  });

  it('shows no blocked chip when nothing blocks the story', () => {
    renderCard(makeStory({id: 's1', status: 'todo'}));

    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
  });

  it('opens the story when the card title is activated', async () => {
    const user = userEvent.setup();
    const actions = renderCard(makeStory({id: 's1', title: 'Wire the board'}));

    await user.click(screen.getByRole('button', {name: 'Wire the board'}));

    expect(actions.onOpen).toHaveBeenCalledWith(expect.objectContaining({id: 's1'}));
  });

  it('does not open the story when an action button is pressed', async () => {
    const user = userEvent.setup();
    const actions = renderCard(makeStory({id: 's1', title: 'Draft one', status: 'draft'}));

    await user.click(screen.getByRole('button', {name: 'Edit Draft one'}));

    expect(actions.onOpen).not.toHaveBeenCalled();
  });

  it('marks a card an agent has claimed, and names the agent', () => {
    renderCard(makeStory({id: 's1', status: 'in_progress', claimedByAgentId: 'a1'}), {
      agentName: 'claude-code-1',
    });

    expect(screen.getByRole('article')).toHaveAttribute('data-agent-owned', 'true');
    expect(screen.getByText('claude-code-1')).toBeInTheDocument();
  });

  it('leaves an unclaimed card unmarked', () => {
    renderCard(makeStory({id: 's1', status: 'todo'}));

    expect(screen.getByRole('article')).toHaveAttribute('data-agent-owned', 'false');
  });

  it('spreads the drag activator props onto the title button', () => {
    render(
      <StoryCard
        story={makeStory({id: 's1', title: 'Wire the board'})}
        blockers={[]}
        actions={spyActions()}
        titleProps={{'aria-roledescription': 'sortable', tabIndex: 0}}
      />,
    );

    expect(screen.getByRole('button', {name: 'Wire the board'})).toHaveAttribute(
      'aria-roledescription',
      'sortable',
    );
  });
});
