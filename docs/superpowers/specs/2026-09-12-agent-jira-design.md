# agent-jira — Design

**Date:** 2026-09-12
**Status:** Approved for planning

## 1. Purpose

A Jira-style kanban board whose workers are AI coding agents, not people. A human writes
stories; agents connect over MCP, claim work, implement it, and report their state back to
the board continuously. The human watches a live board instead of a terminal, and keeps the
final say: only a human moves a story into `accepted`.

**Success criteria**

1. A new user registers, logs in, creates a project and a story in under a minute.
2. An agent connects with one `claude mcp add` command, authenticates via browser consent,
   and needs no further instruction — the MCP server tells it the whole workflow.
3. While an agent works, the board updates live, with a progress bar that reflects real
   implementation progress, without the human refreshing.
4. `docker compose up -d` on a fresh host produces a working instance with a persistent
   database that survives image upgrades.

**Non-goals**

- Sprints, epics, story points, burndown charts, comments-as-discussion, attachments.
- Running agents inside the server container. The server is a state store and a protocol
  endpoint; agents always run on the developer's machine.
- Git integration. The agent handles its own commits inside the project directory.

## 2. Architecture

One container. A Fastify process on port 3000 serves four surfaces:

| Path | Surface |
|---|---|
| `/` | Built React SPA (static, `@fastify/static`) |
| `/api/*` | REST API, session-cookie auth |
| `/ws` | WebSocket hub, session-cookie auth |
| `/mcp` | MCP Streamable HTTP endpoint, OAuth bearer auth |
| `/.well-known/oauth-authorization-server`, `/oauth/*` | OAuth 2.1 authorization server |

```
Browser (SPA) ──REST──▶ Fastify ──▶ SQLite (volume)
      ▲                    │
      └───── WS events ────┤
                           │
Claude Code agent ──MCP───▶┘   (OAuth bearer)
      ▲
      └── scripts/agent-runner.sh (host, optional cold-start)
```

Every write goes through a single service layer that (a) persists and (b) publishes an
event to the WS hub. No route mutates the database directly, so no mutation can be
invisible to the board.

### Technology

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node 22, TypeScript, ESM | LTS, native `node:test`-free (Vitest used) |
| HTTP | Fastify 5 | Low memory, `@fastify/websocket`, easy raw-body for MCP |
| DB | SQLite via `better-sqlite3`, WAL mode | Single file, synchronous, no server |
| ORM + migrations | Drizzle ORM + drizzle-kit | Typed queries and **versioned SQL migrations** applied automatically at boot |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP transport | What `claude mcp add --transport http` speaks |
| Password hashing | `@node-rs/argon2` (Argon2id) | Prebuilt binaries, no build toolchain in image |
| Sessions | `@fastify/session` + `@fastify/cookie`, SQLite store | HttpOnly, SameSite=Lax, 30-day rolling |
| Frontend | React 19 + Vite 6 + TypeScript | — |
| Server state | TanStack Query, invalidated by WS events | Cache + live updates without hand-rolled reducers |
| Drag & drop | `@dnd-kit/core` + `@dnd-kit/sortable` | ~12 kB, pointer + keyboard accessible |
| Styling | Tailwind v4 with a token layer, Radix UI primitives (Dialog, Select, Switch, Tooltip) | Accessible behaviour, custom visuals |
| Tests | Vitest; backend via `fastify.inject` against an in-memory SQLite; frontend via Testing Library | Fast, no browser needed |

Resource target: idle under 150 MB RSS, image under 250 MB.

## 3. Data model

All tables carry `user_id` — boards are isolated per account. Timestamps are integer epoch
milliseconds. IDs are 21-char nanoid strings.

```
users              id, email (unique, lowercased), password_hash, created_at
projects           id, user_id, name, path, created_at, archived_at
stories            id, user_id, project_id, title, description, model,
                   status, rank, progress_pct, progress_label,
                   claimed_by_agent_id, stop_requested, play_requested_at,
                   created_at, updated_at
story_dependencies story_id, depends_on_story_id            (PK both, FK cascade)
story_updates      id, story_id, author_type, author_id, kind, body,
                   progress_pct, created_at
agents             id, user_id, name, autonomous, status, current_story_id,
                   last_seen_at, created_at
oauth_clients      id, user_id?, client_id, client_secret_hash?, redirect_uris,
                   name, created_at
oauth_codes        code, client_id, user_id, agent_id, redirect_uri,
                   code_challenge, scope, expires_at
oauth_tokens       id, client_id, user_id, agent_id, access_token_hash,
                   refresh_token_hash, expires_at, revoked_at
sessions           sid, user_id, data, expires_at
```

**Enums**

- `stories.status`: `draft | todo | in_progress | in_test | finished | accepted`
- `story_updates.kind`: `progress | note | status_change | remark | error`
- `story_updates.author_type`: `user | agent | system`
- `agents.status`: `offline | idle | waiting | working`

**Ordering.** `stories.rank` is a lexicographic fractional-index string (`jittered-rank`
style, generated in-house — ~40 lines, tested). Dropping a card between two neighbours
writes one row.

**Dependency rules.** `story_dependencies` is a DAG; inserts that would create a cycle are
rejected (depth-first check). A story is *blocked* when any dependency is not in
`finished` or `accepted`. Blocked stories can sit in `todo` but cannot be claimed —
`claim_next_story` skips them and the UI marks them with a lock chip listing the blockers.

**Models offered.** A static list in `shared/models.ts`, grouped by provider (Anthropic
Opus/Sonnet/Haiku tiers, OpenAI GPT tiers), each `{id, label, provider}`. Default:
**Opus 5**. Exact model IDs are verified against the `claude-api` skill reference at
implementation time rather than written from memory here. Agents receive the label as a
hint; the board never calls a model API itself.

## 4. REST API

Session-cookie auth on everything except the first three.

```
POST   /api/auth/register        {email, password}      → 201, sets session
POST   /api/auth/login           {email, password}      → 200, sets session
POST   /api/auth/logout                                 → 204
GET    /api/me                                          → {id, email}

GET    /api/projects                                    → Project[]
POST   /api/projects             {name, path}           → Project
PATCH  /api/projects/:id         {name?, path?}         → Project
DELETE /api/projects/:id                                → 204 (409 if stories exist)

GET    /api/board                                       → {columns, stories, agents}
POST   /api/stories              {title, projectId, model, description, dependsOn[]}
PATCH  /api/stories/:id          {…fields}
POST   /api/stories/:id/move     {status, beforeId?, afterId?}
POST   /api/stories/:id/play                            → queues for an agent
POST   /api/stories/:id/stop                            → sets stop_requested
DELETE /api/stories/:id
GET    /api/stories/:id/updates                         → StoryUpdate[]
POST   /api/stories/:id/updates  {body}                 → human remark

GET    /api/agents                                      → Agent[]
PATCH  /api/agents/:id           {autonomous?, name?}
DELETE /api/agents/:id                                  → revokes its tokens
```

**Status transition guard.** A shared `canTransition(from, to, actor)` function is the only
place transitions are decided; both REST and MCP call it.

| From → To | Human | Agent |
|---|---|---|
| draft ↔ todo | yes | no |
| todo → in_progress | yes | yes (claim) |
| in_progress ↔ in_test | yes | yes |
| in_test → finished | yes | yes |
| finished → accepted | **yes** | **no** |
| finished/accepted → todo (rework, with remark) | yes | no |
| any → todo (release) | yes | yes (own story only) |

Rejected transitions return 409 with the reason; the UI snaps the card back.

## 5. WebSocket protocol

Client connects to `/ws` with the session cookie, receives only its own user's events.

```ts
type ServerEvent =
  | {type: 'story.created'  | 'story.updated' | 'story.moved', story: Story}
  | {type: 'story.deleted', id: string}
  | {type: 'story.progress', id: string, progressPct: number, progressLabel: string}
  | {type: 'story.update',  storyId: string, update: StoryUpdate}
  | {type: 'agent.updated', agent: Agent}
  | {type: 'project.changed'}
```

Handling is intentionally dumb: each event patches the TanStack Query cache for the board
key, and `story.update` appends to an open story dialog's timeline. Heartbeat ping every
30 s; the client reconnects with exponential backoff and refetches the board on reconnect,
so a missed event is self-healing.

## 6. MCP server

`POST /mcp` — Streamable HTTP, stateless per request except long-polls. Bearer token maps
to `(user_id, agent_id)`; every query is scoped to that user.

### Instructions (served on initialize)

The server's `instructions` string is the agent's operating manual and the single source of
truth for the workflow. It states, in order:

1. You are a worker on a kanban board. Never invent work; only implement claimed stories.
2. Use the **superpowers** skills — brainstorming when the story is vague, TDD while
   implementing, systematic-debugging on failures, verification-before-completion before
   moving to `finished`.
3. Work only inside the claimed story's `project.path`.
4. Move the story through **every** state, never skip: `in_progress` while building,
   `in_test` while verifying, back to `in_progress` when a test fails, `finished` when
   verified. The human is watching these transitions — they are the status report.
5. Call `post_progress` at least at every meaningful step (0/25/50/75 style is a floor, not
   a target) with a one-line human-readable label. This drives the card's progress bar.
6. Every tool result contains a `control` block. If `control.stop_requested` is true, stop
   immediately, post what you completed, call `release_story`, and do not continue. If
   `control.remarks` is non-empty, the human has left feedback — read it and act on it.
7. Never move a story to `accepted`. Only the human accepts.
8. When a story reaches `finished`: if `control.autonomous` is true, clear your context
   (`/clear`) and call `claim_next_story` to begin the next one; if false, ask your human
   whether to continue before claiming anything.

### Tools

| Tool | Input | Behaviour |
|---|---|---|
| `get_board` | — | All stories grouped by column, with blockers flagged |
| `get_story` | `storyId` | Full story incl. description, project path, dependency state, update timeline |
| `list_projects` | — | `{id, name, path}` |
| `wait_for_work` | `timeoutSeconds?` (≤55) | Long-polls; resolves when a `todo` story is playable (played, or agent is autonomous), else `{work: false}`. Sets agent status `waiting`. |
| `claim_next_story` | `storyId?` | Claims a specific or the highest-ranked unblocked `todo` story, moves it to `in_progress`, returns the full story + project path |
| `start_story` | `projectId, title, description?` | For a task the human gave the agent directly (not via the board): creates the story straight into `in_progress`, top of the column, claimed by the caller, with a note saying where it came from. Refused while the agent holds another story; never for self-initiated work |
| `move_story` | `storyId, status, note?` | Guarded transition; rejects `accepted` |
| `post_progress` | `storyId, progressPct, label` | Updates the bar, appends a `progress` update |
| `post_update` | `storyId, body, kind?` | Appends to the timeline |
| `release_story` | `storyId, reason` | Back to `todo`, unclaims, clears `stop_requested` |
| `set_agent_mode` | `autonomous` | Mirrors the UI toggle |

Every result is `{...payload, control: {stop_requested, autonomous, remarks: string[]}}`,
so stop requests and human remarks reach the agent without polling.

**Resources:** `board://current` (live snapshot) and `story://{id}`, so agents can attach
board state as context.

### OAuth 2.1

`claude mcp add --transport http agent-jira http://host:3000/mcp` triggers:

1. Unauthenticated `POST /mcp` → `401` + `WWW-Authenticate: Bearer resource_metadata=…`
2. Client fetches `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server`
3. **Dynamic client registration** at `/oauth/register` (public, rate-limited) → client_id
4. Browser opens `/oauth/authorize?…&code_challenge=…` → login if needed, then a **consent
   screen**: "*Claude Code* wants to read and update your board" with an agent-name field
   (default `Claude Code`, editable), Allow / Deny. Allow creates the `agents` row.
5. `/oauth/token` with PKCE verifier → access token (8 h) + refresh token (90 d)
6. Revoking an agent in the UI deletes its tokens; the next MCP call gets 401.

Tokens are stored hashed (SHA-256); only the agent holds the plaintext.

## 7. Host runner (cold start)

`scripts/agent-runner.sh` — a ~60-line bash script for the case where no agent is running
yet. It reads a config file (`~/.agent-jira/runner.json`: base URL, token, poll interval),
polls `GET /api/runner/queued` (bearer auth, same tokens as MCP), and on a hit launches:

```
claude --mcp-config <generated> -p "Claim story <id> from agent-jira and implement it. \
Follow the agent-jira MCP instructions exactly." --cwd <project.path>
```

It is optional, documented in the README, and never required for a running agent — an agent
parked in `wait_for_work` is the primary path.

## 8. UI

**Direction: dark technical console.** Reads like an ops dashboard for machines, not a Jira
clone.

**Tokens** — canvas `#0B0C0F`; surface `#131519`; raised `#1A1D23`; hairline borders
`#24272F`; text `#E6E8EC` / muted `#8A9099`; accent **electric violet `#7C5CFF`** reserved
exclusively for progress, active agents and primary actions; status hues used only as small
chips (amber `in_test`, emerald `accepted`, rose `error`). Type: Inter (UI) + JetBrains Mono
(models, paths, IDs). 4 px spacing grid, 10 px radii, no drop shadows — elevation comes
from surface steps and hairlines. Light theme ships as a token swap behind a toggle.

**Layout**

- **Top bar:** wordmark, `New story` (accent), `Connect agent`, theme toggle, account menu
  with Log out.
- **Agent strip:** one pill per agent — status dot (pulsing violet when working), name,
  current story title, autonomous `Switch`. Empty state: "No agents connected —
  *Connect an agent*".
- **Board:** six fixed columns, horizontally scrollable, each with a title, count, and a
  hairline. `draft` and `todo` accept drags from the human; `in_progress`/`in_test` show
  agent-owned cards; `finished` is the human's review queue; `accepted` is terminal.
- **Card:** title (2-line clamp), monospace model chip, project chip, thin progress bar
  (violet, only when `progress_pct > 0`), a blocked-lock chip when dependencies are unmet,
  and a hover action row — edit/delete in `draft`, **play** in `todo`, **stop** in
  `in_progress`/`in_test`. Agent-owned cards carry a subtle animated left accent edge.
- **New/edit story dialog:** title, project `Select` (with **+ New project** → inline
  name + path), model `Select` grouped by provider (default Opus 5), description textarea,
  dependency multi-select listing other stories with status chips. Creates into `draft`.
- **Story detail dialog:** header (title, project path in mono, model, status), progress
  bar with label, the update timeline (author avatar glyph — human vs agent, timestamp,
  body), and a remark composer. Remarks are what an agent picks up on rework.
- **Connect agent dialog:** the copyable command, the full `/mcp` URL, a three-step
  walkthrough of the consent flow, and the list of connected agents with Revoke.

**Interaction rules.** Drags are optimistic with a snap-back + toast on a 409. Live
updates from agents animate the bar and card position rather than replacing the card. Full
keyboard path for drag (dnd-kit), focus-visible rings in accent, `prefers-reduced-motion`
respected. Responsive down to ~400 px: columns become a swipeable single-column view with a
status switcher.

## 9. Deployment

- **Dockerfile** — stage 1 builds the SPA and compiles TS; stage 2 is `node:22-alpine` with
  production deps only, non-root `node` user, `HEALTHCHECK` on `/api/health`.
- **docker-compose.yml** — one service, `ports: 3000`, volume `agent-jira-data:/data`,
  env `DATABASE_PATH=/data/agent-jira.db`, `SESSION_SECRET`, `PUBLIC_URL`,
  `restart: unless-stopped`.
- **`.env.example`** with every variable documented; the server refuses to boot with a
  default/missing `SESSION_SECRET`.
- **Migrations run at boot**, before the port opens; failure exits non-zero.
- **Scripts:** `npm run dev` (Vite + tsx watch), `build`, `start`, `db:generate`,
  `db:migrate`, `test`, `docker:build`, `docker:up`.
- `PUBLIC_URL` matters: OAuth redirect URIs and the MCP URL shown in the UI derive from it,
  so an instance behind a reverse proxy advertises the right address.

## 10. Testing

TDD throughout — test first, watch it fail, implement.

- **Unit:** rank generation, `canTransition` matrix, dependency cycle detection and blocked
  computation, OAuth PKCE verification, password hashing.
- **Integration (`fastify.inject`, in-memory SQLite):** auth lifecycle, board CRUD, move
  guards, remark flow, WS broadcast on every mutation, the full OAuth dance, each MCP tool
  including `wait_for_work` resolution and the `control` block, cross-user isolation
  (user A must never see user B's stories through REST *or* MCP).
- **Frontend:** board renders columns from fixture state, drag calls the move mutation,
  dialog validation, WS event patches the cache, progress bar reflects `progress_pct`.
- **Smoke:** `docker compose up` → register → create story → `/api/health`, in CI.

## 11. Build order

1. Scaffold, TS config, Drizzle schema + first migration, boot-time migrate
2. Auth (register/login/logout/session) + cross-user isolation tests
3. Projects & stories REST, transition guard, ranking, dependencies
4. WS hub + event publication from the service layer
5. Frontend shell, design tokens, board, drag & drop, dialogs, live updates
6. OAuth 2.1 authorization server + consent screen
7. MCP server: instructions, tools, resources, `control` block, long-poll
8. Play/stop plumbing end to end
9. Dockerfile, compose, `.env.example`, README
10. `scripts/agent-runner.sh` + docs
