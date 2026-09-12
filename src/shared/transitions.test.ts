import {describe, it, expect} from 'vitest';
import {canTransition} from './transitions.js';

describe('canTransition', () => {
  it('lets a human accept a finished story', () => {
    expect(canTransition('finished', 'accepted', 'user').ok).toBe(true);
  });
  it('never lets an agent accept', () => {
    const r = canTransition('finished', 'accepted', 'agent');
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty('reason');
  });
  it('lets an agent bounce between in_progress and in_test', () => {
    expect(canTransition('in_progress', 'in_test', 'agent').ok).toBe(true);
    expect(canTransition('in_test', 'in_progress', 'agent').ok).toBe(true);
  });
  it('forbids an agent moving a draft', () => {
    expect(canTransition('draft', 'todo', 'agent').ok).toBe(false);
  });
  it('forbids skipping from todo straight to finished', () => {
    expect(canTransition('todo', 'finished', 'agent').ok).toBe(false);
  });
  it('allows a human to send finished work back to todo for rework', () => {
    expect(canTransition('finished', 'todo', 'user').ok).toBe(true);
    expect(canTransition('accepted', 'todo', 'user').ok).toBe(true);
  });

  it('gives a specific reason when an agent tries to accept', () => {
    const r = canTransition('finished', 'accepted', 'agent');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('Agents cannot accept stories — only a human can.');
  });

  it('gives a generic reason for any other disallowed move', () => {
    const r = canTransition('draft', 'finished', 'user');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('Cannot move a story from draft to finished.');
  });

  it('allows same-status reordering within a column for both actors', () => {
    expect(canTransition('todo', 'todo', 'user').ok).toBe(true);
    expect(canTransition('todo', 'todo', 'agent').ok).toBe(true);
    expect(canTransition('draft', 'draft', 'agent').ok).toBe(true);
    expect(canTransition('accepted', 'accepted', 'agent').ok).toBe(true);
  });
});
