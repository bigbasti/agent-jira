import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {Agent} from '../../shared/types.js';
import type {ApiError} from './api.js';
import {api} from './api.js';
import {BOARD_KEY, upsertAgent, useBoard} from './board-queries.js';

/**
 * Agent presence and control: the board's own live `agents` list (kept current by
 * `useLiveBoard`'s `agent.updated`/`agent.deleted` handling), plus mutations for the
 * autonomous switch, revoking, and the server's public MCP url.
 *
 * `GET /api/agents` exists as its own endpoint (see `routes/agents.ts`) and is exercised
 * directly at the server layer, but the client deliberately does not call it a second
 * time here: `board.data.agents` is already the live-updated source of truth every other
 * part of the board reads, and a separate `['agents']` cache would just be a second copy
 * that `useLiveBoard` would also have to keep in sync — a second source of truth for data
 * that already has one. `useAgents` is a thin selector over the same board query instead.
 */
export function useAgents() {
  const board = useBoard();
  return {...board, data: board.data?.agents};
}

/** Toggles whether an agent may claim its next story without asking. */
export function useSetAutonomous() {
  const client = useQueryClient();
  return useMutation<Agent, ApiError, {agentId: string; autonomous: boolean}>({
    mutationFn: ({agentId, autonomous}) =>
      api.patch<Agent>(`/api/agents/${encodeURIComponent(agentId)}`, {autonomous}),
    onSuccess: agent => upsertAgent(client, agent),
  });
}

/** Renames an agent. */
export function useRenameAgent() {
  const client = useQueryClient();
  return useMutation<Agent, ApiError, {agentId: string; name: string}>({
    mutationFn: ({agentId, name}) => api.patch<Agent>(`/api/agents/${encodeURIComponent(agentId)}`, {name}),
    onSuccess: agent => upsertAgent(client, agent),
  });
}

/**
 * Revokes an agent: its tokens die, its claimed story (if any) is released back to
 * `todo`, and it disappears from the board. The response carries neither the agent's id
 * (204, no body) nor the released story, so — unlike the other agent mutations — this
 * one just invalidates the whole board rather than hand-patching the cache; revoking is
 * rare enough that a refetch is simpler than duplicating the server's release logic here.
 */
export function useRevokeAgent() {
  const client = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: agentId => api.del(`/api/agents/${encodeURIComponent(agentId)}`),
    onSuccess: () => client.invalidateQueries({queryKey: BOARD_KEY}),
  });
}

export const CONFIG_KEY = ['config'] as const;

export interface AppConfigResponse {
  publicUrl: string;
  mcpUrl: string;
}

/**
 * The server's own view of its public url, and the MCP url derived from it —
 * `GET /api/config`. The client must never hardcode or guess either: behind a reverse
 * proxy `window.location` can disagree with what the server was actually configured to
 * answer to. Cannot change without a server restart, so it is fetched once and cached.
 *
 * `enabled` defaults to `true`; the board screen passes `false` until the connect-agent
 * dialog is actually opened, so a config round trip is not paid on every board load.
 */
export function useConfig(enabled = true) {
  return useQuery<AppConfigResponse, ApiError>({
    queryKey: CONFIG_KEY,
    queryFn: () => api.get<AppConfigResponse>('/api/config'),
    staleTime: Infinity,
    enabled,
  });
}
