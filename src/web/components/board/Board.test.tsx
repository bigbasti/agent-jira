import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import {Board, planMove} from './Board.js';
import type {StoryActions} from './StoryCard.js';
import {makeAgent, makeProject, makeStory} from '../../testing/fixtures.js';
import type {Story} from '../../../shared/types.js';

const COLUMN_NAMES = ['Draft', 'To do', 'In progress', 'In test', 'Finished', 'Accepted'];

const storySpy = () => vi.fn<(story: Story) => void>();

function noopActions(): StoryActions {
  return {onOpen: storySpy(), onEdit: storySpy(), onDelete: storySpy(), onPlay: storySpy(), onStop: storySpy()};
}

function renderBoard(stories: Story[], overrides: Partial<Parameters<typeof Board>[0]> = {}) {
  const onMove = vi.fn();
  const actions = overrides.actions ?? noopActions();
  render(
    <Board
      stories={stories}
      projects={[makeProject({id: 'p1', name: 'agent-kanban'})]}
      agents={[makeAgent({id: 'a1', name: 'claude-code-1'})]}
      onMove={onMove}
      {...overrides}
      actions={actions}
    />,
  );
  return {onMove, actions};
}

/** The `<section>` a column renders, addressed by its heading. */
function column(name: string): HTMLElement {
  return screen.getByRole('region', {name: new RegExp(name)});
}

function cardIdsIn(name: string): (string | null)[] {
  return within(column(name))
    .getAllByRole('article')
    .map(card => card.getAttribute('data-story-id'));
}

describe('Board', () => {
  it('renders all six columns with counts', () => {
    renderBoard([
      makeStory({id: 's1', status: 'todo', rank: 'A'}),
      makeStory({id: 's2', status: 'todo', rank: 'B'}),
      makeStory({id: 's3', status: 'accepted', rank: 'A'}),
    ]);

    COLUMN_NAMES.forEach(name => {
      expect(screen.getByRole('heading', {name: new RegExp(name)})).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', {name: 'To do 2'})).toBeInTheDocument();
    expect(screen.getByRole('heading', {name: 'Draft 0'})).toBeInTheDocument();
    expect(screen.getByRole('heading', {name: 'Accepted 1'})).toBeInTheDocument();
  });

  it('places each story in its status column', () => {
    renderBoard([
      makeStory({id: 's1', status: 'draft', title: 'Sketch the idea'}),
      makeStory({id: 's2', status: 'in_progress', title: 'Build the thing'}),
      makeStory({id: 's3', status: 'accepted', title: 'Shipped it'}),
    ]);

    expect(within(column('Draft')).getByText('Sketch the idea')).toBeInTheDocument();
    expect(within(column('In progress')).getByText('Build the thing')).toBeInTheDocument();
    expect(within(column('Accepted')).getByText('Shipped it')).toBeInTheDocument();
    expect(within(column('To do')).queryByRole('article')).not.toBeInTheDocument();
  });

  it('orders stories within a column by rank', () => {
    renderBoard([
      makeStory({id: 'last', status: 'todo', rank: 'c'}),
      makeStory({id: 'first', status: 'todo', rank: 'A'}),
      makeStory({id: 'middle', status: 'todo', rank: 'B'}),
    ]);

    expect(cardIdsIn('To do')).toEqual(['first', 'middle', 'last']);
  });

  it('shows an empty-column hint in draft', () => {
    renderBoard([]);

    expect(within(column('Draft')).getByText(/New story starts here/)).toBeInTheDocument();
  });

  it('drops the hint once the column has a card', () => {
    renderBoard([makeStory({id: 's1', status: 'draft'})]);

    expect(within(column('Draft')).queryByText(/New story starts here/)).not.toBeInTheDocument();
  });

  it('separates the lanes the human owns from the lanes the agents work in', () => {
    renderBoard([]);

    expect(column('Draft')).toHaveAttribute('data-lane', 'human');
    expect(column('To do')).toHaveAttribute('data-lane', 'human');
    expect(column('In progress')).toHaveAttribute('data-lane', 'agent');
    expect(column('In test')).toHaveAttribute('data-lane', 'agent');
    expect(column('Finished')).toHaveAttribute('data-lane', 'human');
    expect(column('Accepted')).toHaveAttribute('data-lane', 'human');
    expect(within(column('In progress')).getByText('agents')).toBeInTheDocument();
    expect(within(column('Draft')).getByText('you')).toBeInTheDocument();
  });

  it('resolves each card to its project and claiming agent', () => {
    renderBoard([makeStory({id: 's1', status: 'in_progress', projectId: 'p1', claimedByAgentId: 'a1'})]);

    const card = within(column('In progress')).getByRole('article');
    expect(within(card).getByText('agent-kanban')).toBeInTheDocument();
    expect(within(card).getByText('claude-code-1')).toBeInTheDocument();
  });

  it('resolves blocking ids to the titles the card names', () => {
    renderBoard([
      makeStory({id: 's1', status: 'todo', rank: 'A', title: 'Blocked one', blockedBy: ['s2']}),
      makeStory({id: 's2', status: 'todo', rank: 'B', title: 'The blocker'}),
    ]);

    expect(screen.getByText('Blocked')).toHaveAccessibleDescription('Blocked by The blocker');
  });

  it('makes every card keyboard draggable from its title', () => {
    renderBoard([makeStory({id: 's1', status: 'todo', title: 'Queued one'})]);

    const title = screen.getByRole('button', {name: 'Queued one'});
    expect(title).toHaveAttribute('aria-roledescription', 'story card');
    expect(title).toHaveAttribute('tabindex', '0');
  });

  // Through Board, a card's <li> carries the sortable drag activator's onPointerDown —
  // StoryCard rendered on its own (see StoryCard.test.tsx) never wires that up, so this is
  // the only place a click on an action button is exercised against the real listener a
  // pointer-based drag would also fire on.
  it('does not open the story when an action button is clicked on a sortable card', async () => {
    const user = userEvent.setup();
    const {actions} = renderBoard([makeStory({id: 's1', title: 'Draft one', status: 'draft'})]);

    await user.click(screen.getByRole('button', {name: 'Edit Draft one'}));

    expect(actions.onEdit).toHaveBeenCalledWith(expect.objectContaining({id: 's1'}));
    expect(actions.onOpen).not.toHaveBeenCalled();
  });
});

describe('planMove', () => {
  const stories = [
    makeStory({id: 'd1', status: 'draft', rank: 'A'}),
    makeStory({id: 't1', status: 'todo', rank: 'A'}),
    makeStory({id: 't2', status: 'todo', rank: 'B'}),
    makeStory({id: 't3', status: 'todo', rank: 'C'}),
  ];

  it('drops a card from another column above the card it was dropped on', () => {
    expect(planMove({stories, activeId: 'd1', overId: 't2'})).toEqual({
      storyId: 'd1',
      status: 'todo',
      beforeId: 't1',
      afterId: 't2',
    });
  });

  it('appends to the end when the drop lands on the column itself', () => {
    expect(planMove({stories, activeId: 'd1', overId: 'todo'})).toEqual({
      storyId: 'd1',
      status: 'todo',
      beforeId: 't3',
      afterId: null,
    });
  });

  it('puts the first card of an empty column between no neighbours', () => {
    expect(planMove({stories, activeId: 't1', overId: 'finished'})).toEqual({
      storyId: 't1',
      status: 'finished',
      beforeId: null,
      afterId: null,
    });
  });

  it('moves a card down within its own column, landing below the card it passed', () => {
    expect(planMove({stories, activeId: 't1', overId: 't3'})).toEqual({
      storyId: 't1',
      status: 'todo',
      beforeId: 't3',
      afterId: null,
    });
  });

  it('moves a card up within its own column, landing above the card it passed', () => {
    expect(planMove({stories, activeId: 't3', overId: 't1'})).toEqual({
      storyId: 't3',
      status: 'todo',
      beforeId: null,
      afterId: 't1',
    });
  });

  it('never names the dragged card as its own neighbour', () => {
    const plan = planMove({stories, activeId: 't2', overId: 't3'});

    expect(plan).not.toBeNull();
    expect(plan?.beforeId).not.toBe('t2');
    expect(plan?.afterId).not.toBe('t2');
  });

  it('returns null when the card is dropped on itself', () => {
    expect(planMove({stories, activeId: 't2', overId: 't2'})).toBeNull();
  });

  it('returns null when the drop leaves the card exactly where it was', () => {
    expect(planMove({stories, activeId: 't1', overId: 'todo'})).not.toBeNull();
    expect(planMove({stories, activeId: 't3', overId: 'todo'})).toBeNull();
  });

  it('returns null when the drag target is not on the board', () => {
    expect(planMove({stories, activeId: 't1', overId: 'nowhere'})).toBeNull();
    expect(planMove({stories, activeId: 'gone', overId: 'todo'})).toBeNull();
  });
});
