import * as RadixSwitch from '@radix-ui/react-switch';
import clsx from 'clsx';
import {useId} from 'react';

/**
 * `accent` is opt-in and means the switch stands for an active agent — the only reason a
 * toggle may wear the accent. A display preference (the theme toggle) stays neutral.
 */
export type SwitchTone = 'neutral' | 'accent';

const TONES: Record<SwitchTone, {track: string; thumb: string}> = {
  neutral: {
    track: 'data-[state=checked]:border-transparent data-[state=checked]:bg-hairline-strong',
    thumb: 'data-[state=checked]:bg-text',
  },
  accent: {
    track: 'data-[state=checked]:border-transparent data-[state=checked]:bg-accent-solid',
    thumb: 'data-[state=checked]:bg-accent-ink',
  },
};

export interface SwitchProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  tone?: SwitchTone;
  disabled?: boolean;
  className?: string;
}

export function Switch({label, checked, onCheckedChange, tone = 'neutral', disabled, className}: SwitchProps) {
  const id = useId();

  return (
    <div className={clsx('inline-flex items-center gap-2', className)}>
      <RadixSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        data-tone={tone}
        className={clsx(
          // 24px tall: a target that clears WCAG 2.2 on its own, without the label's help.
          'inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-hairline bg-well p-0.5',
          'transition-colors duration-150 ease-console disabled:opacity-45',
          TONES[tone].track,
        )}
      >
        <RadixSwitch.Thumb
          className={clsx(
            'block size-5 rounded-full bg-muted',
            'transition-transform duration-150 ease-console data-[state=checked]:translate-x-5',
            TONES[tone].thumb,
          )}
        />
      </RadixSwitch.Root>
      <label htmlFor={id} className="text-label text-muted select-none">
        {label}
      </label>
    </div>
  );
}
