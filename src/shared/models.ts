export type Provider = 'anthropic' | 'openai';
export interface ModelOption { id: string; label: string; provider: Provider }

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

export const MODELS: ModelOption[] = [
  {id: 'claude-opus-5',     label: 'Claude Opus 5',     provider: 'anthropic'},
  {id: 'claude-fable-5-1',  label: 'Claude Fable 5.1',  provider: 'anthropic'},
  {id: 'claude-opus-4-8',   label: 'Claude Opus 4.8',   provider: 'anthropic'},
  {id: 'claude-sonnet-5',   label: 'Claude Sonnet 5',   provider: 'anthropic'},
  {id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  provider: 'anthropic'},
  {id: 'gpt-5.1',           label: 'GPT-5.1',           provider: 'openai'},
  {id: 'gpt-5.1-mini',      label: 'GPT-5.1 mini',      provider: 'openai'},
  {id: 'gpt-5',             label: 'GPT-5',             provider: 'openai'},
  {id: 'o4',                label: 'o4',                provider: 'openai'},
];

export const DEFAULT_MODEL_ID = 'claude-opus-5';
export const findModel = (id: string) => MODELS.find(m => m.id === id);
