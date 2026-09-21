import {useState} from 'react';
import type {Agent} from '../../../shared/types.js';
import {useRevokeAgent} from '../../lib/agent-queries.js';
import {ApiError} from '../../lib/api.js';
import {Button} from '../ui/Button.js';
import {Dialog} from '../ui/Dialog.js';

export interface ConnectAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** From `useConfig()`; `undefined` while it is still loading. */
  config?: {mcpUrl: string};
  /** True when `useConfig()` failed — swaps the loading placeholders for a retry. */
  configError?: boolean;
  /** Refetches `GET /api/config`; required when `configError` can be true. */
  onRetryConfig?: () => void;
  /** The caller's connected agents — the same live list `AgentStrip` renders. */
  agents: Agent[];
}

/** How long the button reads "Copied" before reverting. */
const COPIED_TIMEOUT_MS = 2000;

function connectCommand(mcpUrl: string): string {
  return `claude mcp add --transport http agent-jira ${mcpUrl}`;
}

const SECTION_HEADING = 'text-label font-medium text-muted';

/**
 * Walks a human through connecting an agent over MCP: the server's own url (never
 * hardcoded — it comes from `GET /api/config`), the CLI command to add it, what the
 * consent screen will ask, and the agents already connected, each revocable.
 */
export function ConnectAgentDialog({
  open,
  onOpenChange,
  config,
  configError,
  onRetryConfig,
  agents,
}: ConnectAgentDialogProps) {
  const revoke = useRevokeAgent();
  const [copied, setCopied] = useState(false);

  const mcpUrl = config?.mcpUrl;
  const command = mcpUrl ? connectCommand(mcpUrl) : undefined;

  async function copyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_TIMEOUT_MS);
    } catch {
      // Clipboard access can be denied (permissions, an insecure context) — the command
      // is still right there, selectable text, so nothing else needs to happen here.
    }
  }

  const revokeError =
    revoke.error instanceof ApiError ? revoke.error.message : revoke.error ? 'Something went wrong. Try again.' : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Connect an agent"
      description="Point a Claude Code session at this board over MCP."
    >
      <div className="flex flex-col gap-5">
        {configError ? (
          <section role="alert" className="flex flex-col gap-2 rounded-well border border-hairline bg-well px-3 py-2">
            <p className="text-label text-text">Couldn't load the connection details. Check your connection and try again.</p>
            <Button type="button" variant="secondary" size="sm" className="self-start" onClick={onRetryConfig}>
              Retry
            </Button>
          </section>
        ) : (
          <>
            <section className="flex flex-col gap-1.5">
              <h3 className={SECTION_HEADING}>MCP server URL</h3>
              <p className="break-all rounded-well border border-hairline bg-well px-3 py-2 font-mono text-label text-text">
                {mcpUrl ?? 'Loading…'}
              </p>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={SECTION_HEADING}>Add it with the Claude Code CLI</h3>
              <div className="flex items-center gap-2 rounded-well border border-hairline bg-well px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-label text-text">
                  {command ?? 'Loading…'}
                </code>
                <Button type="button" variant="secondary" size="sm" disabled={!command} onClick={copyCommand}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </section>
          </>
        )}

        <section className="flex flex-col gap-1.5">
          <h3 className={SECTION_HEADING}>What happens next</h3>
          <ol className="flex flex-col gap-1 text-label text-muted">
            <li>1. Claude Code opens your browser so you can sign in to this board.</li>
            <li>2. Review what the agent will be able to do, then choose Allow.</li>
            <li>3. It appears in the strip above and starts asking for work.</li>
          </ol>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className={SECTION_HEADING}>Connected agents</h3>
          {agents.length === 0 ? (
            <p className="text-label text-muted">No agents connected yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {agents.map(agent => (
                <li
                  key={agent.id}
                  className="flex items-center justify-between gap-2 rounded-well border border-hairline px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-label text-text">{agent.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="hover:text-rose"
                    aria-label={`Revoke ${agent.name}`}
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(agent.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {revokeError && (
            <p role="alert" className="text-label text-rose">
              {revokeError}
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
