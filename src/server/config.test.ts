import {describe, it, expect} from 'vitest';
import {loadConfig} from './config.js';

const baseEnv = () => ({} as NodeJS.ProcessEnv);

describe('loadConfig', () => {
  describe('defaults', () => {
    it('uses default port, database path and public url in development', () => {
      const config = loadConfig(baseEnv());
      expect(config.port).toBe(3000);
      expect(config.databasePath).toBe('./data/agent-kanban.db');
      expect(config.publicUrl).toBe('http://localhost:3000');
      expect(config.nodeEnv).toBe('development');
    });

    it('derives publicUrl default from a custom PORT', () => {
      const config = loadConfig({...baseEnv(), PORT: '4000'});
      expect(config.port).toBe(4000);
      expect(config.publicUrl).toBe('http://localhost:4000');
    });
  });

  describe('SESSION_SECRET', () => {
    it('throws in production when SESSION_SECRET is missing', () => {
      expect(() => loadConfig({...baseEnv(), NODE_ENV: 'production'})).toThrow(/SESSION_SECRET/);
    });

    it('throws in production when SESSION_SECRET is shorter than 32 characters', () => {
      expect(() =>
        loadConfig({...baseEnv(), NODE_ENV: 'production', SESSION_SECRET: 'short'}),
      ).toThrow(/SESSION_SECRET/);
    });

    it('accepts a SESSION_SECRET of at least 32 characters in production', () => {
      const secret = 'a'.repeat(32);
      const config = loadConfig({...baseEnv(), NODE_ENV: 'production', SESSION_SECRET: secret});
      expect(config.sessionSecret).toBe(secret);
    });

    it('falls back to a dev secret outside production when unset', () => {
      const config = loadConfig(baseEnv());
      expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
    });

    it('falls back to a dev secret outside production even when set too short', () => {
      const config = loadConfig({...baseEnv(), SESSION_SECRET: 'short'});
      expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
    });

    it('throws in production when SESSION_SECRET is the exact .env.example placeholder', () => {
      // The literal value shipped at .env.example's SESSION_SECRET= line. It is long
      // enough (54 chars) to pass the length check, so it must be refused by name — a
      // deployer who runs `cp .env.example .env` and skips the next step must never be
      // able to boot production with a secret anyone can read in this repo's history.
      const placeholder = 'change-me-to-a-random-string-of-at-least-32-characters';
      expect(placeholder.length).toBeGreaterThanOrEqual(32);
      expect(() =>
        loadConfig({...baseEnv(), NODE_ENV: 'production', SESSION_SECRET: placeholder}),
      ).toThrow(/SESSION_SECRET/);
    });

    it('throws in production for an obvious "change-me"-style secret even if long enough', () => {
      const secret = `change-me-${'a'.repeat(40)}`;
      expect(() =>
        loadConfig({...baseEnv(), NODE_ENV: 'production', SESSION_SECRET: secret}),
      ).toThrow(/SESSION_SECRET/);
    });

    it('rejects a "change-me"-style secret case-insensitively', () => {
      const secret = `CHANGE-ME-${'a'.repeat(40)}`;
      expect(() =>
        loadConfig({...baseEnv(), NODE_ENV: 'production', SESSION_SECRET: secret}),
      ).toThrow(/SESSION_SECRET/);
    });

    it('rejects "changeme" with no separator too', () => {
      const secret = `changeme${'a'.repeat(40)}`;
      expect(() =>
        loadConfig({...baseEnv(), NODE_ENV: 'production', SESSION_SECRET: secret}),
      ).toThrow(/SESSION_SECRET/);
    });

    it('tells the deployer exactly what to run when the secret is missing or a placeholder', () => {
      expect(() => loadConfig({...baseEnv(), NODE_ENV: 'production'})).toThrow(/openssl rand -hex 32/);
      expect(() =>
        loadConfig({
          ...baseEnv(),
          NODE_ENV: 'production',
          SESSION_SECRET: 'change-me-to-a-random-string-of-at-least-32-characters',
        }),
      ).toThrow(/openssl rand -hex 32/);
    });

    it('still accepts a real random secret that merely contains "change" as a substring', () => {
      // The check must not be so broad it refuses a genuine secret that happens to
      // contain the word "change" somewhere other than as a change-me-style prefix.
      const secret = `${'x'.repeat(20)}-change-${'y'.repeat(20)}`;
      const config = loadConfig({...baseEnv(), NODE_ENV: 'production', SESSION_SECRET: secret});
      expect(config.sessionSecret).toBe(secret);
    });
  });

  describe('PORT', () => {
    it('throws a clear error when PORT is not a number', () => {
      expect(() => loadConfig({...baseEnv(), PORT: 'not-a-number'})).toThrow(/PORT/);
    });

    it('throws a clear error when PORT is zero or negative', () => {
      expect(() => loadConfig({...baseEnv(), PORT: '0'})).toThrow(/PORT/);
      expect(() => loadConfig({...baseEnv(), PORT: '-1'})).toThrow(/PORT/);
    });

    it('throws a clear error when PORT is not an integer', () => {
      expect(() => loadConfig({...baseEnv(), PORT: '3000.5'})).toThrow(/PORT/);
    });

    it('throws a clear error when PORT is above 65535', () => {
      expect(() => loadConfig({...baseEnv(), PORT: '65536'})).toThrow(/PORT/);
    });

    it('accepts the boundary value PORT=65535', () => {
      const config = loadConfig({...baseEnv(), PORT: '65535'});
      expect(config.port).toBe(65535);
    });
  });

  describe('TRUST_PROXY', () => {
    it('defaults to false when unset', () => {
      const config = loadConfig(baseEnv());
      expect(config.trustProxy).toBe(false);
    });

    it('is true when set to "true"', () => {
      const config = loadConfig({...baseEnv(), TRUST_PROXY: 'true'});
      expect(config.trustProxy).toBe(true);
    });

    it('is true when set to "1"', () => {
      const config = loadConfig({...baseEnv(), TRUST_PROXY: '1'});
      expect(config.trustProxy).toBe(true);
    });

    it('is false for any other value', () => {
      const config = loadConfig({...baseEnv(), TRUST_PROXY: 'yes'});
      expect(config.trustProxy).toBe(false);
    });
  });
});
