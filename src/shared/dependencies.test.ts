import {describe, it, expect} from 'vitest';
import {blockedBy, wouldCycle} from './dependencies.js';
import type {Status} from './status.js';

describe('blockedBy', () => {
  it('reports unfinished dependencies', () => {
    // deps: s2 -> [s1], s1 in todo => ['s1']
    const deps = new Map<string, string[]>([['s2', ['s1']]]);
    const statusOf = new Map<string, Status>([
      ['s1', 'todo'],
      ['s2', 'todo'],
    ]);
    expect(blockedBy('s2', deps, statusOf)).toEqual(['s1']);
  });

  it('treats finished and accepted as satisfied', () => {
    // s2 -> [s1, s3], s1 finished, s3 accepted => []
    const deps = new Map<string, string[]>([['s2', ['s1', 's3']]]);
    const statusOf = new Map<string, Status>([
      ['s1', 'finished'],
      ['s3', 'accepted'],
      ['s2', 'todo'],
    ]);
    expect(blockedBy('s2', deps, statusOf)).toEqual([]);
  });

  it('returns an empty list when the story has no dependencies', () => {
    const deps = new Map<string, string[]>();
    const statusOf = new Map<string, Status>([['s1', 'todo']]);
    expect(blockedBy('s1', deps, statusOf)).toEqual([]);
  });

  it('reports only the dependencies that are unfinished, not all of them', () => {
    const deps = new Map<string, string[]>([['s2', ['s1', 's3']]]);
    const statusOf = new Map<string, Status>([
      ['s1', 'finished'],
      ['s3', 'in_progress'],
      ['s2', 'todo'],
    ]);
    expect(blockedBy('s2', deps, statusOf)).toEqual(['s3']);
  });
});

describe('wouldCycle', () => {
  it('detects a direct cycle', () => {
    // s1 -> s2, adding s2 -> s1 => true
    const deps = new Map<string, string[]>([['s1', ['s2']]]);
    expect(wouldCycle('s2', 's1', deps)).toBe(true);
  });

  it('detects a transitive cycle', () => {
    // s1 -> s2 -> s3, adding s3 -> s1 => true
    const deps = new Map<string, string[]>([
      ['s1', ['s2']],
      ['s2', ['s3']],
    ]);
    expect(wouldCycle('s3', 's1', deps)).toBe(true);
  });

  it('allows a diamond', () => {
    // s4 -> s2, s4 -> s3, s2 -> s1, s3 -> s1 => false
    const deps = new Map<string, string[]>([
      ['s4', ['s2', 's3']],
      ['s2', ['s1']],
      ['s3', ['s1']],
    ]);
    expect(wouldCycle('s2', 's3', deps)).toBe(false);
  });

  it('allows adding an edge to an unrelated story', () => {
    const deps = new Map<string, string[]>([['s1', ['s2']]]);
    expect(wouldCycle('s3', 's1', deps)).toBe(false);
  });
});
