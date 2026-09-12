import * as RadixDialog from '@radix-ui/react-dialog';
import clsx from 'clsx';
import type {ReactNode} from 'react';

export interface DialogProps {
  trigger?: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * Radix owns the behaviour that is easy to get wrong — focus trapping, restore, scroll
 * lock, Escape — so this only dresses it.
 */
export function Dialog({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-canvas/75 backdrop-blur-[2px]" />
        <RadixDialog.Content
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 w-[min(calc(100vw-2rem),34rem)] -translate-x-1/2 -translate-y-1/2',
            'max-h-[min(42rem,calc(100dvh-2rem))] overflow-y-auto',
            'rounded-card border border-hairline bg-surface p-5',
            className,
          )}
        >
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-lede font-semibold text-text">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-label text-muted">
                  {description}
                </RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              aria-label="Close"
              className="-mr-1 -mt-1 rounded-chip p-1 text-muted transition-colors duration-150 ease-console hover:bg-raised hover:text-text"
            >
              <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </RadixDialog.Close>
          </div>
          <div className="mt-4">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
