import clsx from 'clsx';
import type {ButtonHTMLAttributes} from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  // The accent is a primary action's badge of office — nothing else may wear it.
  primary: 'bg-accent-solid text-accent-ink hover:bg-accent-solid-hover active:bg-accent-solid-active',
  secondary: 'bg-raised text-text border border-hairline hover:border-hairline-strong',
  ghost: 'text-muted hover:text-text hover:bg-raised',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-label',
  md: 'h-9 px-4 text-body',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({variant = 'secondary', size = 'md', className, type = 'button', ...props}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-well font-medium',
        'transition-colors duration-150 ease-console',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
