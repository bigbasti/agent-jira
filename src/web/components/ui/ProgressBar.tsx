import clsx from 'clsx';
import {useId} from 'react';

export interface ProgressBarProps {
  /** Percent complete; values outside 0-100 are clamped. */
  value: number;
  /** What the agent says it is doing right now. */
  label?: string;
  className?: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function ProgressBar({value, label, className}: ProgressBarProps) {
  const percent = clampPercent(value);
  const labelId = useId();

  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        {label && (
          <span id={labelId} className="min-w-0 truncate text-label text-muted">
            {label}
          </span>
        )}
        <span className="ml-auto font-mono text-micro tabular-nums text-muted">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-labelledby={label ? labelId : undefined}
        aria-label={label ? undefined : 'Progress'}
        className="h-1 w-full overflow-hidden rounded-full bg-hairline"
      >
        {/* No zero-width sliver: an unstarted story shows an empty track. */}
        {percent > 0 && (
          <div
            data-progress-fill=""
            style={{width: `${percent}%`}}
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-console"
          />
        )}
      </div>
    </div>
  );
}
