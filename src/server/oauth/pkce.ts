import {createHash, timingSafeEqual} from 'node:crypto';

/**
 * PKCE (RFC 7636), S256 only.
 *
 * `plain` is deliberately unimplemented: it offers no protection at all when the
 * authorization request itself is what leaks, which is the threat PKCE exists to answer.
 * The method is still taken as an argument so a caller that forwards an attacker-supplied
 * `code_challenge_method` gets `false` rather than a silent downgrade.
 */

/** A code verifier is 43-128 characters of the unreserved set (RFC 7636 §4.1). */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** A base64url SHA-256 digest: 43 characters, no padding. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The S256 transformation: `BASE64URL(SHA256(ASCII(verifier)))`. */
export function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Returns true only when `challenge` is the S256 transformation of `verifier`.
 *
 * Returns false — never throws — for a non-`S256` method, a malformed verifier or
 * challenge, and any non-string input, so a caller can hand it raw request parameters.
 * The final comparison is constant-time: both sides are fixed-length base64url digests,
 * so a byte-by-byte early exit would leak how much of a guessed verifier was right.
 */
export function verifyChallenge(verifier: string, challenge: string, method: 'S256'): boolean {
  if (method !== 'S256') return false;
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  if (!VERIFIER_PATTERN.test(verifier)) return false;
  if (!CHALLENGE_PATTERN.test(challenge)) return false;

  const expected = Buffer.from(deriveChallenge(verifier), 'ascii');
  const actual = Buffer.from(challenge, 'ascii');
  // Both are 43 ASCII bytes by construction, but check anyway: `timingSafeEqual` throws
  // on a length mismatch, and this function must never throw.
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}
