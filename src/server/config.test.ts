import {describe, it, expect} from 'vitest';
import {loadConfig} from './config.js';

const baseEnv = () => ({} as NodeJS.ProcessEnv);

describe('loadConfig', () => {
  describe('defaults', () => {
    it('uses default port, database path and public url in development', () => {
      const config = loadConfig(baseEnv());
      expect(config.port).toBe(3000);
      expect(config.databasePath).toBe('./data/agent-jira.db');
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
  });
});
