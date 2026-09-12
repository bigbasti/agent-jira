import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it} from 'vitest';
import {ThemeToggle} from './ThemeToggle.js';

afterEach(() => {
  localStorage.clear();
});

describe('ThemeToggle', () => {
  it('swaps the document theme and remembers the choice', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const toggle = screen.getByRole('switch', {name: 'Light'});
    expect(document.documentElement.dataset.theme).toBe('dark');

    await user.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('agent-jira:theme')).toBe('light');

    await user.click(toggle);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('agent-jira:theme')).toBe('dark');
  });

  it('stays neutral: a display preference never wears the accent', () => {
    render(<ThemeToggle />);

    expect(screen.getByRole('switch', {name: 'Light'})).toHaveAttribute('data-tone', 'neutral');
  });
});
