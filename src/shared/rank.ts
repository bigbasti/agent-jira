/**
 * Lexicographic fractional index over the base-62 alphabet `0-9A-Za-z`.
 *
 * The alphabet is ordered so character order and ASCII order agree
 * (digits, then uppercase, then lowercase), which is what lets plain
 * string comparison order ranks correctly.
 *
 * `rankBetween(before, after)` returns a string that sorts strictly
 * between `before` and `after` (either may be `null` for "no bound",
 * i.e. start or end of the sequence). Walk both strings character by
 * character; at the first position where they differ (or where one
 * runs out), take the midpoint digit. When neighbouring digits are
 * adjacent (no digit fits between them), keep the lower digit and
 * recurse into an unbounded continuation of the remaining string —
 * this is what makes the result grow by a character instead of failing.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length; // 62

function digitOf(s: string, i: number): number {
  return i < s.length ? ALPHABET.indexOf(s.charAt(i)) : 0;
}

/** Builds a rank greater than `before` and, if given, less than `after`. */
function build(before: string, after: string | null): string {
  let result = '';
  for (let i = 0; ; i++) {
    const b = digitOf(before, i);
    const a = after === null ? BASE : digitOf(after, i);
    if (b === a) {
      // Digits match so far — carry it forward and keep comparing.
      result += ALPHABET.charAt(b);
      continue;
    }
    const gap = a - b;
    if (gap >= 2) {
      const mid = b + Math.floor(gap / 2);
      return result + ALPHABET.charAt(mid);
    }
    // gap === 1: adjacent digits, no room at this position. Keep `before`'s
    // digit and grow the result by recursing, unbounded, into the rest of
    // `before`'s tail.
    result += ALPHABET.charAt(b);
    return result + build(before.slice(i + 1), null);
  }
}

export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) {
    throw new RangeError(
      `rankBetween: before (${JSON.stringify(before)}) must be < after (${JSON.stringify(after)})`,
    );
  }
  if (before === null && after === null) {
    return 'U'; // mid-alphabet seed
  }
  return build(before ?? '', after);
}
