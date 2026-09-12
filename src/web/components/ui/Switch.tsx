import * as RadixSwitch from '@radix-ui/react-switch';
import clsx from 'clsx';
import {useId} from 'react';

export interface SwitchProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function Switch({label, checked, onCheckedChange, disabled, className}: SwitchProps) {
  const id = useId();

  return (
    <div className={clsx('inline-flex items-center gap-2', className)}>
      <RadixSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={clsx(
          'inline-flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5',
          'transition-colors duration-150 ease-console disabled:opacity-45',
          'border-hairline bg-well data-[state=checked]:border-transparent data-[state=checked]:bg-accent-solid',
        )}
      >
        <RadixSwitch.Thumb
          className={clsx(
            'block size-3.5 rounded-full bg-muted',
            'transition-transform duration-150 ease-console',
            'data-[state=checked]:translate-x-4 data-[state=checked]:bg-accent-ink',
          )}
        />
      </RadixSwitch.Root>
      <label htmlFor={id} className="text-label text-muted select-none">
        {label}
      </label>
    </div>
  );
}
