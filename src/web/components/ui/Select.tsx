import * as RadixSelect from '@radix-ui/react-select';
import clsx from 'clsx';
import {Fragment, forwardRef, useId, useMemo} from 'react';

export interface SelectOption {
  value: string;
  label: string;
  /** Options sharing a group render under one label, in the order the group first appears. */
  group?: string;
}

export interface SelectProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  /**
   * Rendered after a separator, below every group — a fixed entry such as "+ New
   * project" that stays in the same place regardless of how `options` is filtered or
   * sorted.
   */
  pinnedOption?: SelectOption;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const ITEM_CLASS = clsx(
  'flex cursor-default items-center justify-between gap-3 rounded-well border-l-2 border-transparent py-1.5 pr-2 pl-[7px] text-body text-text',
  'outline-none',
  // Accent marks committed state — the option that is actually selected — never
  // transient pointer/keyboard chrome. A merely-highlighted, not-yet-selected item gets
  // a neutral left rule instead. `border-hairline-strong` was tried here first and
  // measured only ~1.4:1 against `--raised` — effectively as invisible as the wash it
  // was replacing — so this uses `--muted` instead, which clears 5.25:1 (dark) / 6.26:1
  // (light) against `--raised`. Ratios in the task report. The `data-[state=unchecked]`
  // guard keeps this rule from fighting the accent one below when an item is both
  // highlighted and selected, which is the common case right after the menu opens.
  'data-[highlighted]:data-[state=unchecked]:border-muted',
  // The committed item: a solid accent rule, wash and accent text together — this is the
  // only place accent decorates this list.
  'data-[state=checked]:border-accent data-[state=checked]:bg-accent-wash data-[state=checked]:text-accent-text',
);

/** Groups options by `group`, preserving first-seen order; ungrouped options come first. */
function groupOptions(options: SelectOption[]): {group: string | null; items: SelectOption[]}[] {
  const order: (string | null)[] = [];
  const byGroup = new Map<string | null, SelectOption[]>();
  for (const option of options) {
    const key = option.group ?? null;
    if (!byGroup.has(key)) {
      order.push(key);
      byGroup.set(key, []);
    }
    byGroup.get(key)!.push(option);
  }
  return order.map(group => ({group, items: byGroup.get(group)!}));
}

function SelectItem({option}: {option: SelectOption}) {
  return (
    <RadixSelect.Item value={option.value} className={ITEM_CLASS}>
      <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
    </RadixSelect.Item>
  );
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {label, value, onValueChange, options, pinnedOption, placeholder = 'Choose one', disabled, className},
  ref,
) {
  const id = useId();
  const groups = useMemo(() => groupOptions(options), [options]);

  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-label font-medium text-muted">
        {label}
      </label>
      <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RadixSelect.Trigger
          ref={ref}
          id={id}
          className={clsx(
            'inline-flex h-9 w-full items-center justify-between gap-2 rounded-well border border-hairline bg-well px-3',
            'text-body text-text transition-colors duration-150 ease-console',
            'hover:border-hairline-strong disabled:opacity-45 data-[placeholder]:text-muted',
          )}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon>
            <svg viewBox="0 0 16 16" className="size-3.5 text-muted" aria-hidden="true">
              <path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className="z-50 max-h-72 w-[var(--radix-select-trigger-width)] overflow-hidden rounded-card border border-hairline bg-raised"
          >
            <RadixSelect.Viewport className="p-1">
              {groups.map(({group, items}) => (
                <Fragment key={group ?? '__ungrouped__'}>
                  {group ? (
                    <RadixSelect.Group>
                      <RadixSelect.Label className="px-2 pt-1.5 pb-1 text-micro font-medium text-muted">
                        {group}
                      </RadixSelect.Label>
                      {items.map(option => (
                        <SelectItem key={option.value} option={option} />
                      ))}
                    </RadixSelect.Group>
                  ) : (
                    items.map(option => <SelectItem key={option.value} option={option} />)
                  )}
                </Fragment>
              ))}
              {pinnedOption && (
                <>
                  <RadixSelect.Separator className="my-1 h-px bg-hairline" />
                  <SelectItem option={pinnedOption} />
                </>
              )}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
});
