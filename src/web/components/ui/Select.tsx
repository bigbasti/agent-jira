import * as RadixSelect from '@radix-ui/react-select';
import clsx from 'clsx';
import {useId} from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function Select({
  label,
  value,
  onValueChange,
  options,
  placeholder = 'Choose one',
  disabled,
  className,
}: SelectProps) {
  const id = useId();

  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-label font-medium text-muted">
        {label}
      </label>
      <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RadixSelect.Trigger
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
              {options.map(option => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  className={clsx(
                    'flex cursor-default items-center justify-between gap-3 rounded-well px-2 py-1.5 text-body text-text',
                    'outline-none data-[highlighted]:bg-accent-wash data-[highlighted]:text-accent-text',
                  )}
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
