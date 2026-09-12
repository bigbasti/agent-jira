import {useSyncExternalStore} from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'agent-jira:theme';
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

function preferred(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

let current: Theme = stored() ?? preferred();

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

apply(current);

export function setTheme(theme: Theme): void {
  if (theme === current) return;
  current = theme;
  apply(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A blocked storage API only costs the choice its persistence.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shared across every mount, so two toggles on screen never disagree. */
export function useTheme(): {theme: Theme; setTheme: (theme: Theme) => void} {
  const theme = useSyncExternalStore(
    subscribe,
    () => current,
    () => 'dark' as Theme,
  );
  return {theme, setTheme};
}
