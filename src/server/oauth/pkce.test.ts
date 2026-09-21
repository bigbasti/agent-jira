import {describe, it, expect} from 'vitest';
import {createHash, randomBytes} from 'node:crypto';
import {verifyChallenge} from './pkce.js';

// RFC 7636 appendix B's worked example.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

describe('PKCE', () => {
  it('accepts a matching S256 verifier', () => {
    expect(verifyChallenge(RFC_VERIFIER, RFC_CHALLENGE, 'S256')).toBe(true);
  });

  it('agrees with a freshly generated verifier/challenge pair', () => {
    const verifier = randomBytes(32).toString('base64url');
    expect(verifyChallenge(verifier, s256(verifier), 'S256')).toBe(true);
  });

  it('rejects a mismatched verifier', () => {
    const other = 'M25iVXpKU3puUjFaYWg3T1NDTDQtcW1ROUY5YXlwalNoc0hhakxifmZHag';
    expect(verifyChallenge(other, RFC_CHALLENGE, 'S256')).toBe(false);
  });

  it('rejects the plain method', () => {
    // Even when verifier and challenge are identical — which is exactly what `plain`
    // means — the S256-only server must refuse.
    expect(verifyChallenge(RFC_VERIFIER, RFC_VERIFIER, 'plain' as 'S256')).toBe(false);
    expect(verifyChallenge(RFC_VERIFIER, RFC_CHALLENGE, 'plain' as 'S256')).toBe(false);
  });

  it('rejects a verifier presented as its own challenge (plain smuggled into S256)', () => {
    expect(verifyChallenge(RFC_VERIFIER, RFC_VERIFIER, 'S256')).toBe(false);
  });

  it('rejects a verifier shorter than 43 characters', () => {
    const short = 'a'.repeat(42);
    expect(verifyChallenge(short, s256(short), 'S256')).toBe(false);
  });

  it('accepts the 43 and 128 character boundaries', () => {
    for (const length of [43, 128]) {
      const verifier = 'a'.repeat(length);
      expect(verifyChallenge(verifier, s256(verifier), 'S256')).toBe(true);
    }
  });

  it('rejects a verifier longer than 128 characters', () => {
    const long = 'a'.repeat(129);
    expect(verifyChallenge(long, s256(long), 'S256')).toBe(false);
  });

  it('rejects a verifier with characters outside the unreserved set', () => {
    const bad = `${'a'.repeat(42)}/`;
    expect(verifyChallenge(bad, s256(bad), 'S256')).toBe(false);
  });

  it('rejects an empty verifier or challenge', () => {
    expect(verifyChallenge('', '', 'S256')).toBe(false);
    expect(verifyChallenge(RFC_VERIFIER, '', 'S256')).toBe(false);
    expect(verifyChallenge('', RFC_CHALLENGE, 'S256')).toBe(false);
  });

  it('rejects a challenge that is not a 43-character base64url digest', () => {
    expect(verifyChallenge(RFC_VERIFIER, `${RFC_CHALLENGE}=`, 'S256')).toBe(false);
    expect(verifyChallenge(RFC_VERIFIER, RFC_CHALLENGE.slice(0, 42), 'S256')).toBe(false);
    // Standard base64 alphabet instead of base64url.
    const standard = createHash('sha256').update(RFC_VERIFIER, 'ascii').digest('base64').replace(/=+$/, '');
    if (standard !== RFC_CHALLENGE) {
      expect(verifyChallenge(RFC_VERIFIER, standard, 'S256')).toBe(false);
    }
  });

  it('does not throw on non-string input', () => {
    expect(verifyChallenge(undefined as unknown as string, RFC_CHALLENGE, 'S256')).toBe(false);
    expect(verifyChallenge(RFC_VERIFIER, null as unknown as string, 'S256')).toBe(false);
  });
});
