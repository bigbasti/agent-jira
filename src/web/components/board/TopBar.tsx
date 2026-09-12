import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import {ThemeToggle} from '../ThemeToggle.js';
import {Wordmark} from '../Wordmark.js';
import {Button} from '../ui/Button.js';

export interface TopBarProps {
  email: string;
  /** A short line about what the board is doing; Task 11 puts "reconnecting…" here. */
  status?: string;
  onNewStory: () => void;
  onConnectAgent: () => void;
  onLogout: () => void;
  loggingOut?: boolean;
}

const MENU_ITEM = clsx(
  'flex cursor-default items-center rounded-well px-2 py-1.5 text-body text-text outline-none',
  'data-[highlighted]:bg-hairline data-[disabled]:opacity-45',
);

export function TopBar({email, status, onNewStory, onConnectAgent, onLogout, loggingOut}: TopBarProps) {
  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b border-hairline px-4">
      <Wordmark />
      <span aria-label="Board status" role="status" className="ml-auto truncate font-mono text-micro text-muted">
        {status}
      </span>
      <ThemeToggle className="shrink-0" />
      <Button variant="primary" size="sm" onClick={onNewStory}>
        New story
      </Button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="sm" className="px-1" aria-label="Account">
            <span className="grid size-6 place-items-center rounded-full border border-hairline bg-raised font-mono text-micro text-muted">
              {email.slice(0, 1).toUpperCase()}
            </span>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-52 rounded-card border border-hairline bg-raised p-1"
          >
            <DropdownMenu.Label className="truncate px-2 py-1.5 font-mono text-micro text-muted">
              {email}
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
            <DropdownMenu.Item className={MENU_ITEM} onSelect={onConnectAgent}>
              Connect agent
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM} disabled={loggingOut} onSelect={onLogout}>
              Log out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}
