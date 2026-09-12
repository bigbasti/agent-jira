import {describe, it, expect} from 'vitest';
import {rankBetween} from './rank.js';

describe('rankBetween', () => {
  it('produces a rank between two neighbours', () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const mid = rankBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
  });
  it('prepends before the first', () => {
    const a = rankBetween(null, null);
    expect(rankBetween(null, a) < a).toBe(true);
  });
  it('survives 500 successive midpoint insertions', () => {
    let lo = rankBetween(null, null), hi = rankBetween(lo, null);
    for (let i = 0; i < 500; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      hi = mid;
    }
  });
  it('throws when neighbours are out of order', () => {
    expect(() => rankBetween('b', 'a')).toThrow();
  });

  it('throws when neighbours are equal', () => {
    expect(() => rankBetween('m', 'm')).toThrow(RangeError);
  });

  it('seeds a mid-alphabet rank when both neighbours are null', () => {
    expect(rankBetween(null, null)).toBe('U');
  });

  it('appends after the last forever without collision', () => {
    let last = rankBetween(null, null);
    for (let i = 0; i < 50; i++) {
      const next = rankBetween(last, null);
      expect(next > last).toBe(true);
      last = next;
    }
  });

  it('grows by a character when neighbours are adjacent in the alphabet', () => {
    const mid = rankBetween('a', 'b');
    expect(mid > 'a' && mid < 'b').toBe(true);
    expect(mid.length).toBeGreaterThan(1);
  });
});
