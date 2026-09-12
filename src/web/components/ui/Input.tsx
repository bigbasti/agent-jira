import clsx from 'clsx';
import {useId, type InputHTMLAttributes} from 'react';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Stated up front, not as a punishment after a failed submit. */
  hint?: string;
  error?: string;
}

export function Input({label, hint, error, className, ...props}: InputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-label font-medium text-muted">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={describedBy || undefined}
        aria-invalid={error ? true : undefined}
        className={clsx(
          // A well: recessed a step below the panel it sits on, the way a field should read.
          'h-9 w-full rounded-well border bg-well px-3 text-body text-text',
          'placeholder:text-muted/70 transition-colors duration-150 ease-console',
          error ? 'border-rose' : 'border-hairline hover:border-hairline-strong',
          className,
        )}
        {...props}
      />
      {hint && (
        <p id={hintId} className="text-label text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-label text-rose">
          {error}
        </p>
      )}
    </div>
  );
}
