import {describe, it, expect} from 'vitest';
import {MODELS, DEFAULT_MODEL_ID, findModel} from './models.js';

describe('models', () => {
  it('defaults to Opus 5', () => {
    expect(DEFAULT_MODEL_ID).toBe('claude-opus-5');
    expect(findModel(DEFAULT_MODEL_ID)?.label).toBe('Claude Opus 5');
  });
  it('offers both providers', () => {
    const providers = new Set(MODELS.map(m => m.provider));
    expect(providers).toEqual(new Set(['anthropic', 'openai']));
  });
  it('has unique ids', () => {
    expect(new Set(MODELS.map(m => m.id)).size).toBe(MODELS.length);
  });
});
