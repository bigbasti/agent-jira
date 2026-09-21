import {describe, it, expect} from 'vitest';
import {INSTRUCTIONS} from './instructions.js';
import {STATUSES} from '../../shared/status.js';

/**
 * The instructions string is a deliverable, not documentation: it is the only briefing an
 * agent gets before it starts driving the board. These tests pin the rules that, if they
 * went missing, would show up as an agent doing the wrong thing on a human's machine —
 * skipping columns, accepting its own work, ignoring a stop request, or carrying one
 * story's context into the next.
 */
describe('instructions', () => {
  /** Index of the first occurrence of `needle`, asserted to exist. */
  function at(needle: string | RegExp): number {
    const index = typeof needle === 'string' ? INSTRUCTIONS.indexOf(needle) : INSTRUCTIONS.search(needle);
    expect(index, `expected the instructions to mention ${String(needle)}`).toBeGreaterThanOrEqual(0);
    return index;
  }

  it('names every column', () => {
    for (const status of STATUSES) {
      expect(INSTRUCTIONS).toContain(status);
    }
  });

  it('names every column in board order on one line', () => {
    const line = INSTRUCTIONS.split('\n').find(candidate => STATUSES.every(status => candidate.includes(status)));
    expect(line, 'expected one line listing the whole column order').toBeDefined();

    const positions = STATUSES.map(status => line!.indexOf(status));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('tells the agent it is a worker and must never invent work', () => {
    expect(INSTRUCTIONS).toMatch(/never invent work/i);
    expect(INSTRUCTIONS).toMatch(/kanban board/i);
  });

  it('lets the agent put a directly-given task on the board, and only that', () => {
    expect(INSTRUCTIONS).toContain('start_story');
    expect(INSTRUCTIONS).toMatch(/directly/i);
    expect(INSTRUCTIONS).toMatch(/own initiative/i);
    // The story goes on the board before any work starts, not after.
    expect(INSTRUCTIONS).toMatch(/before (you )?(write|touch|change) any/i);
  });

  it('tells the agent to use the superpowers skills, naming each one', () => {
    expect(INSTRUCTIONS).toMatch(/superpowers/i);
    expect(INSTRUCTIONS).toMatch(/test-driven-development|TDD/i);
    expect(INSTRUCTIONS).toContain('brainstorming');
    expect(INSTRUCTIONS).toContain('test-driven-development');
    expect(INSTRUCTIONS).toContain('systematic-debugging');
    expect(INSTRUCTIONS).toContain('verification-before-completion');
  });

  it('confines the agent to the claimed story’s project path', () => {
    expect(INSTRUCTIONS).toContain('project.path');
    expect(INSTRUCTIONS).toMatch(/only (inside|in) /i);
  });

  it('forbids skipping a state and says why the transitions matter', () => {
    expect(INSTRUCTIONS).toMatch(/never skip/i);
    expect(INSTRUCTIONS).toMatch(/status report/i);
    // Failing a test sends the story back to in_progress rather than leaving it in in_test.
    expect(INSTRUCTIONS).toMatch(/back to `?in_progress`?/i);
  });

  it('requires a progress call at every meaningful step', () => {
    expect(INSTRUCTIONS).toContain('post_progress');
    expect(INSTRUCTIONS).toMatch(/every meaningful step/i);
    expect(INSTRUCTIONS).toMatch(/progress bar/i);
  });

  it('documents the control block and the stop protocol', () => {
    expect(INSTRUCTIONS).toContain('control');
    expect(INSTRUCTIONS).toContain('control.stop_requested');
    expect(INSTRUCTIONS).toContain('release_story');
    expect(INSTRUCTIONS).toMatch(/stop (immediately|at once)/i);
    expect(INSTRUCTIONS).toMatch(/every tool result/i);
  });

  it('documents human remarks as feedback to act on', () => {
    expect(INSTRUCTIONS).toContain('control.remarks');
    expect(INSTRUCTIONS).toMatch(/feedback/i);
  });

  it('forbids accepting stories', () => {
    expect(INSTRUCTIONS).toMatch(/never .*accepted/i);
    expect(INSTRUCTIONS).toMatch(/only (the|a) human/i);
  });

  it('documents clearing context between stories', () => {
    expect(INSTRUCTIONS).toMatch(/\/clear/);
    expect(INSTRUCTIONS).toContain('control.autonomous');
    expect(INSTRUCTIONS).toContain('claim_next_story');
    expect(INSTRUCTIONS).toMatch(/ask (your )?human/i);
  });

  it('says the human owns the move into todo', () => {
    expect(INSTRUCTIONS).toMatch(/your human owns the first move/i);
    expect(INSTRUCTIONS).toMatch(/drag(s)? it to `?todo`?/i);
  });

  it('says a stop and a remark only arrive in a tool result', () => {
    expect(INSTRUCTIONS).toMatch(/only reach you \*?in the result of a tool call/i);
    expect(INSTRUCTIONS).toMatch(/heads-down|long stretch/i);
  });

  it('says a release takes a reason', () => {
    expect(INSTRUCTIONS).toMatch(/`release_story` with a reason/);
  });

  it('says a remark may be about a story the agent is not holding', () => {
    expect(INSTRUCTIONS).toContain('story_id');
    expect(INSTRUCTIONS).toContain('story_title');
    expect(INSTRUCTIONS).toMatch(/may also be about another story/i);
    expect(INSTRUCTIONS).toMatch(/act on it when you claim that story/i);
  });

  it('names the tools it tells the agent to call', () => {
    for (const tool of ['wait_for_work', 'claim_next_story', 'move_story', 'post_progress', 'release_story']) {
      expect(INSTRUCTIONS).toContain(tool);
    }
  });

  it('states the eight rules in the order the brief requires', () => {
    const order = [
      at(/never invent work/i),
      at('superpowers'),
      at('project.path'),
      at(/never skip/i),
      at('post_progress'),
      at('control.stop_requested'),
      at(/never move a story to/i),
      at('/clear'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('reads as prose, not as a bulleted spec dump', () => {
    const lines = INSTRUCTIONS.split('\n').filter(line => line.trim() !== '');
    const bulleted = lines.filter(line => /^\s*[-*•]\s/.test(line));
    expect(bulleted.length / lines.length).toBeLessThan(0.5);
    expect(INSTRUCTIONS.length).toBeGreaterThan(1200);
  });
});
