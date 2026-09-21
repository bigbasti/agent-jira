import {describe, expect, it} from 'vitest';
import {safeNextPath} from './next-path.js';

describe('safeNextPath', () => {
  it('returns the in-app path the server asked us to come back to', () => {
    const next = '/oauth/authorize?client_id=abc&state=xyz';
    expect(safeNextPath(`?next=${encodeURIComponent(next)}`)).toBe(next);
  });

  it('returns null when there is nothing to return to', () => {
    expect(safeNextPath('')).toBeNull();
    expect(safeNextPath('?')).toBeNull();
    expect(safeNextPath('?next=')).toBeNull();
    expect(safeNextPath('?other=1')).toBeNull();
  });

  it('refuses anything that would leave this origin', () => {
    for (const hostile of [
      'https://evil.example.com/',
      '//evil.example.com/',
      '/\\evil.example.com/',
      '\\\\evil.example.com/',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'oauth/authorize',
      'http://localhost:3000/oauth/authorize',
    ]) {
      expect(safeNextPath(`?next=${encodeURIComponent(hostile)}`), hostile).toBeNull();
    }
  });

  it('refuses a path carrying control characters', () => {
    expect(safeNextPath(`?next=${encodeURIComponent('/oauth/authorize\nSet-Cookie: a=b')}`)).toBeNull();
  });
});
