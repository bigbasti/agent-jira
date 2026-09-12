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

  it('prepends before the first forever without collision', () => {
    let first = rankBetween(null, null);
    for (let i = 0; i < 50; i++) {
      const prev = rankBetween(null, first);
      expect(prev < first).toBe(true);
      first = prev;
    }
  });

  it('grows by a character when neighbours are adjacent in the alphabet', () => {
    const mid = rankBetween('a', 'b');
    expect(mid > 'a' && mid < 'b').toBe(true);
    expect(mid.length).toBeGreaterThan(1);
  });

  it('produces a valid rank on a long shared prefix that only diverges at the tail', () => {
    const mid = rankBetween('abcdef0', 'abcdef9');
    expect(mid > 'abcdef0' && mid < 'abcdef9').toBe(true);
  });

  it('throws instead of looping forever on a character outside the alphabet', () => {
    expect(() => rankBetween('5!', '6')).toThrow(RangeError);
  });

  describe('when `after` is `before` followed only by \'0\' characters', () => {
    // '0' is the alphabet's minimum character, so there is provably no
    // string that sorts strictly between `before` and `before + '0'*n`:
    // any extension makes the upper bound a proper prefix of the result
    // (so the result would sort *after* it), and stopping short just
    // reproduces the upper bound. rankBetween must recognise this and
    // fail fast with a RangeError rather than loop forever searching for
    // a digit that cannot exist. Each case is given an explicit timeout
    // so a regression to the old infinite loop fails the test promptly
    // instead of hanging the whole suite.
    it('rejects a single trailing zero', () => {
      expect(() => rankBetween('5', '50')).toThrow(RangeError);
    }, 2000);

    it('rejects a longer run of trailing zeros', () => {
      expect(() => rankBetween('5', '500')).toThrow(RangeError);
    }, 2000);

    it('rejects a trailing zero on a multi-character prefix', () => {
      expect(() => rankBetween('abc', 'abc0')).toThrow(RangeError);
    }, 2000);

    it('rejects a much longer zero run', () => {
      expect(() => rankBetween('5', '50000000')).toThrow(RangeError);
    }, 2000);
  });
});
