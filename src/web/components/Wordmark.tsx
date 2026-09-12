import clsx from 'clsx';

export interface WordmarkProps {
  size?: 'bar' | 'hero';
  /** The blinking terminal caret — the hero's one piece of motion. */
  caret?: boolean;
  className?: string;
}

export function Wordmark({size = 'bar', caret = false, className}: WordmarkProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 font-mono font-medium tracking-tight text-text',
        size === 'hero' ? 'text-display' : 'text-label',
        className,
      )}
    >
      agent-jira
      {caret && <span className="caret" aria-hidden="true" />}
    </span>
  );
}
