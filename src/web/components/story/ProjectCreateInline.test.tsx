import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createRef} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ProjectCreateInline} from './ProjectCreateInline.js';
import {createTestQueryClient, mockFetch} from '../../testing/render.js';
import {QueryClientProvider} from '@tanstack/react-query';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderInline(nameInputRef: ReturnType<typeof createRef<HTMLInputElement>>) {
  mockFetch();
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ProjectCreateInline nameInputRef={nameInputRef} onCreated={() => {}} onCancel={() => {}} />
    </QueryClientProvider>,
  );
}

describe('ProjectCreateInline — merged ref stability', () => {
  it('does not reattach the name-input ref on every re-render', async () => {
    const user = userEvent.setup();
    // Wrap the ref object so every write to `.current` is counted — a ref callback whose
    // identity changes every render makes React call it with `null` and then the node
    // again on each of those renders, which shows up here as extra writes.
    let setCount = 0;
    let stored: HTMLInputElement | null = null;
    const countedRef = {
      get current() {
        return stored;
      },
      set current(value: HTMLInputElement | null) {
        setCount += 1;
        stored = value;
      },
    } as unknown as ReturnType<typeof createRef<HTMLInputElement>>;

    renderInline(countedRef);
    const setsAfterMount = setCount;
    expect(setsAfterMount).toBeGreaterThan(0);
    expect(countedRef.current).not.toBeNull();

    // Three keystrokes are three re-renders of `ProjectCreateInline` (its `name` state
    // changes each time). A stable ref must not be reattached by any of them.
    await user.type(screen.getByLabelText('Project name'), 'abc');

    expect(setCount).toBe(setsAfterMount);
  });
});
