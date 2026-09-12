import clsx from 'clsx';
import type {ComponentPropsWithoutRef, ReactNode} from 'react';

export type ChipTone = 'neutral' | 'accent' | 'amber' | 'emerald' | 'rose';

const TONES: Record<ChipTone, string> = {
  neutral: 'border-hairline bg-raised text-muted',
  accent: 'border-accent/35 bg-accent-wash text-accent-text',
  amber: 'border-amber/30 bg-amber-wash text-amber',
  emerald: 'border-emerald/30 bg-emerald-wash text-emerald',
  rose: 'border-rose/30 bg-rose-wash text-rose',
};

export interface ChipProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  tone?: ChipTone;
  children: ReactNode;
}

/** The only place a status hue is allowed to appear. */
export function Chip({tone = 'neutral', className, children, ...props}: ChipProps) {
  return (
    <span
      className={clsx(
        'inline-flex h-5 items-center gap-1.5 rounded-chip border px-1.5 text-micro whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
