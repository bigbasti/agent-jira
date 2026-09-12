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
 *
 * `'0'` is the alphabet's minimum character, which means there is no
 * valid rank strictly between `S` and `S` followed only by `'0'`
 * characters (e.g. between `'5'` and `'50'`, or `'5'` and `'5000'`):
 * any extension of `S` makes the `'0'`-suffixed string a proper prefix
 * of the result, so the result would sort *after* it, not before —
 * and stopping short reproduces the upper bound exactly. `rankBetween`
 * detects that case and throws `RangeError` rather than looping
 * forever trying to find a digit that cannot exist.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length; // 62

/** The digit value of `s`'s character at `i`, or 0 ("no constraint") past its end. */
function digitOf(s: string, i: number): number {
  if (i >= s.length) return 0;
  const ch = s.charAt(i);
  const digit = ALPHABET.indexOf(ch);
  if (digit === -1) {
    throw new RangeError(
      `rankBetween: ${JSON.stringify(ch)} in ${JSON.stringify(s)} is not in the rank alphabet (0-9A-Za-z).`,
    );
  }
  return digit;
}

/** Builds a rank greater than `before` and, if given, less than `after`. */
function build(before: string, after: string | null): string {
  let result = '';
  for (let i = 0; ; i++) {
    if (after !== null && i >= after.length) {
      // `after`'s real content just ran out while we were still matching
      // `before` character-for-character. Given the `before < after`
      // precondition, this can only happen when the remainder of `after`
      // beyond `before` was entirely `'0'` characters — see the module
      // doc comment for why no valid rank exists in that case.
      throw new RangeError(
        `rankBetween: no rank exists strictly between ${JSON.stringify(before)} and ${JSON.stringify(after)} ` +
          `— ${JSON.stringify(after)} is ${JSON.stringify(before)} followed only by '0' characters.`,
      );
    }
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
    // digit — which already sorts below `after`'s digit here, deciding the
    // comparison — and grow the result by recursing, unbounded, into the
    // rest of `before`'s tail, to satisfy result > before.
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
