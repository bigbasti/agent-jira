# agent-jira Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Jira-style kanban board where AI agents claim, implement and report on stories over MCP, with a live-updating browser UI and one-command Docker deployment.

**Architecture:** One Fastify process serves the React SPA, a REST API, a WebSocket hub and an MCP Streamable-HTTP endpoint backed by SQLite. All writes funnel through a service layer that persists and then publishes a WS event, so no mutation is invisible to the board. Agents authenticate via an OAuth 2.1 authorization server built into the app.

**Tech Stack:** Node 22 · TypeScript (ESM) · Fastify 5 · better-sqlite3 · Drizzle ORM + drizzle-kit · @modelcontextprotocol/sdk · React 19 · Vite 6 · TanStack Query · @dnd-kit · Tailwind v4 · Radix UI · Vitest

**Spec:** `docs/superpowers/specs/2026-09-12-agent-jira-design.md`

## Global Constraints

- **Node 22+, TypeScript strict, ESM everywhere** (`"type": "module"`, `"moduleResolution": "Bundler"`).
- **TDD is mandatory.** Every task: write the failing test, run it, watch it fail, implement, watch it pass, commit. Never write implementation before a failing test exists.
- **Every DB write goes through `src/server/services/*`** — routes and MCP tools call services, never Drizzle directly. Services publish events.
- **Every query is scoped by `userId`.** Boards are isolated per account; a missing `userId` filter is a security bug.
- **Status values (exact strings):** `draft`, `todo`, `in_progress`, `in_test`, `finished`, `accepted`.
- **Only a human may move a story to `accepted`.** The transition guard enforces this by actor.
- **Commit after every task**, message prefix `feat:` / `test:` / `chore:`. Append:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014QSExiuSBQZpvdvP2vtS5g
  ```
- **Design tokens are law.** Canvas `#0B0C0F`, surface `#131519`, raised `#1A1D23`, border `#24272F`, text `#E6E8EC`, muted `#8A9099`, accent `#7C5CFF`. Accent is reserved for progress, active agents and primary actions. No drop shadows.
- **Run `npm run check` (typecheck + test) before every commit.**

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vitest.config.ts`, `.gitignore` (exists), `.env.example`
- Create: `src/shared/types.ts`, `src/shared/models.ts`, `src/shared/status.ts`
- Create: `src/server/index.ts`, `src/server/app.ts`, `src/server/config.ts`
- Test: `src/server/app.test.ts`, `src/shared/models.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `buildApp(opts: {db: Database}): Promise<FastifyInstance>` from `src/server/app.ts`
  - `loadConfig(env = process.env): AppConfig` from `src/server/config.ts` where
    `AppConfig = {port: number; databasePath: string; sessionSecret: string; publicUrl: string; nodeEnv: string}`
  - `MODELS: ModelOption[]` and `DEFAULT_MODEL_ID = 'claude-opus-5'` from `src/shared/models.ts`
  - `STATUSES`, `type Status` from `src/shared/status.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agent-jira",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "concurrently -n api,web -c magenta,cyan \"npm:dev:api\" \"npm:dev:web\"",
    "dev:api": "tsx watch src/server/index.ts",
    "dev:web": "vite",
    "build": "npm run build:web && npm run build:api",
    "build:web": "vite build",
    "build:api": "tsc -p tsconfig.server.json",
    "start": "node dist/server/index.js",
    "db:generate": "drizzle-kit generate",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.server.json --noEmit",
    "check": "npm run typecheck && npm run test"
  }
}
```

Then install:

```bash
npm i fastify @fastify/cookie @fastify/session @fastify/static @fastify/websocket \
  better-sqlite3 drizzle-orm @node-rs/argon2 nanoid zod \
  @modelcontextprotocol/sdk
npm i -D typescript tsx vite @vitejs/plugin-react vitest @vitest/ui jsdom \
  @testing-library/react @testing-library/user-event @testing-library/jest-dom \
  drizzle-kit @types/node @types/better-sqlite3 concurrently
npm i react react-dom @tanstack/react-query @dnd-kit/core @dnd-kit/sortable \
  @radix-ui/react-dialog @radix-ui/react-select @radix-ui/react-switch \
  @radix-ui/react-tooltip @radix-ui/react-dropdown-menu clsx
npm i -D tailwindcss @tailwindcss/vite @types/react @types/react-dom
```

- [ ] **Step 2: Write the failing tests**

`src/shared/models.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {MODELS, DEFAULT_MODEL_ID, findModel} from './models.js';

describe('models', () => {
  it('defaults to Opus 5', () => {
    expect(DEFAULT_MODEL_ID).toBe('claude-opus-5');
    expect(findModel(DEFAULT_MODEL_ID)?.label).toBe('Claude Opus 5');
  });
  it('offers both providers', () => {
    const providers = new Set(MODELS.map(m => m.provider));
    expect(providers).toEqual(new Set(['anthropic', 'openai']));
  });
  it('has unique ids', () => {
    expect(new Set(MODELS.map(m => m.id)).size).toBe(MODELS.length);
  });
});
```

`src/server/app.test.ts`:

```ts
import {describe, it, expect, afterAll} from 'vitest';
import {buildApp} from './app.js';
import {createTestDb} from './db/testing.js';

const app = await buildApp({db: createTestDb()});
afterAll(() => app.close());

describe('health', () => {
  it('reports ok', async () => {
    const res = await app.inject({method: 'GET', url: '/api/health'});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({status: 'ok'});
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./models.js` / `./app.js`.

- [ ] **Step 4: Implement `src/shared/models.ts`**

Model IDs below are current as of 2026-09-12 and were verified against the `claude-api` skill reference. Do not invent date suffixes.

```ts
export type Provider = 'anthropic' | 'openai';
export interface ModelOption { id: string; label: string; provider: Provider }

export const MODELS: ModelOption[] = [
  {id: 'claude-opus-5',     label: 'Claude Opus 5',     provider: 'anthropic'},
  {id: 'claude-fable-5-1',  label: 'Claude Fable 5.1',  provider: 'anthropic'},
  {id: 'claude-opus-4-8',   label: 'Claude Opus 4.8',   provider: 'anthropic'},
  {id: 'claude-sonnet-5',   label: 'Claude Sonnet 5',   provider: 'anthropic'},
  {id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  provider: 'anthropic'},
  {id: 'gpt-5.1',           label: 'GPT-5.1',           provider: 'openai'},
  {id: 'gpt-5.1-mini',      label: 'GPT-5.1 mini',      provider: 'openai'},
  {id: 'gpt-5',             label: 'GPT-5',             provider: 'openai'},
  {id: 'o4',                label: 'o4',                provider: 'openai'},
];

export const DEFAULT_MODEL_ID = 'claude-opus-5';
export const findModel = (id: string) => MODELS.find(m => m.id === id);
```

- [ ] **Step 5: Implement `src/shared/status.ts` and `src/shared/types.ts`**

```ts
// status.ts
export const STATUSES = ['draft','todo','in_progress','in_test','finished','accepted'] as const;
export type Status = typeof STATUSES[number];
export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Draft', todo: 'To do', in_progress: 'In progress',
  in_test: 'In test', finished: 'Finished', accepted: 'Accepted',
};
```

`types.ts` holds the wire shapes shared by server and client — `Project`, `Story`, `StoryUpdate`, `Agent`, `BoardSnapshot`, `ServerEvent`. Write them to match the spec's data model; every id is `string`, every timestamp `number` (epoch ms). `Story` includes `blockedBy: string[]` (computed, not stored).

- [ ] **Step 6: Implement `config.ts`, `app.ts`, `index.ts`**

`loadConfig` reads `PORT` (default 3000), `DATABASE_PATH` (default `./data/agent-jira.db`), `SESSION_SECRET` (**throws** if missing or shorter than 32 chars when `NODE_ENV === 'production'`; in dev falls back to a fixed dev secret), `PUBLIC_URL` (default `http://localhost:${port}`).

`buildApp` creates a Fastify instance, registers `/api/health` returning `{status: 'ok', version}`, and stores `db` on `app.decorate('db', db)`.

`index.ts` loads config, opens the real DB, runs migrations, then listens on `0.0.0.0:port`.

Also create a **placeholder** `src/server/db/testing.ts` exporting `createTestDb()` that opens an in-memory `better-sqlite3` handle wrapped in `drizzle()` with no tables yet — Task 2 replaces it with the migrated version. The health-check test only needs the decoration to exist.

- [ ] **Step 7: Run tests, verify they pass**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: scaffold agent-jira with fastify, vite and vitest"
```

---

### Task 2: Database schema and migrations

**Files:**
- Create: `drizzle.config.ts`, `src/server/db/schema.ts`, `src/server/db/index.ts`, `src/server/db/migrate.ts`, `src/server/db/testing.ts`
- Create: `drizzle/` (generated migrations)
- Test: `src/server/db/migrate.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1).
- Produces:
  - `openDb(path: string): BetterSQLite3Database<typeof schema>` from `src/server/db/index.ts`
  - `runMigrations(db): void` from `src/server/db/migrate.ts`
  - `createTestDb(): BetterSQLite3Database<typeof schema>` from `src/server/db/testing.ts` — in-memory, migrated, ready to use
  - All table objects from `src/server/db/schema.ts`: `users`, `projects`, `stories`, `storyDependencies`, `storyUpdates`, `agents`, `oauthClients`, `oauthCodes`, `oauthTokens`, `sessions`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/db/migrate.test.ts
import {describe, it, expect} from 'vitest';
import {createTestDb} from './testing.js';
import {users, stories} from './schema.js';
import {eq} from 'drizzle-orm';

describe('migrations', () => {
  it('creates every table and enforces user scoping columns', () => {
    const db = createTestDb();
    db.insert(users).values({id: 'u1', email: 'a@b.c', passwordHash: 'x', createdAt: 1}).run();
    const rows = db.select().from(users).where(eq(users.email, 'a@b.c')).all();
    expect(rows).toHaveLength(1);
  });

  it('cascades story deletion to dependencies and updates', () => {
    const db = createTestDb();
    // seed user, project, two stories, a dependency and an update, delete the story,
    // then assert dependencies and updates for it are gone.
  });

  it('is idempotent', () => {
    const db = createTestDb();
    expect(() => createTestDb()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/server/db/migrate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `schema.ts`**

Use `sqliteTable` from `drizzle-orm/sqlite-core`. Every FK gets `{onDelete: 'cascade'}` except `stories.projectId` which is `restrict` (deleting a project with stories must fail). Columns exactly as the spec's data model. Key details:

```ts
export const stories = sqliteTable('stories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, {onDelete: 'cascade'}),
  projectId: text('project_id').notNull().references(() => projects.id),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  model: text('model').notNull(),
  status: text('status', {enum: STATUSES}).notNull().default('draft'),
  rank: text('rank').notNull(),
  progressPct: integer('progress_pct').notNull().default(0),
  progressLabel: text('progress_label').notNull().default(''),
  claimedByAgentId: text('claimed_by_agent_id').references(() => agents.id, {onDelete: 'set null'}),
  stopRequested: integer('stop_requested', {mode: 'boolean'}).notNull().default(false),
  playRequestedAt: integer('play_requested_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, t => [index('stories_user_status_idx').on(t.userId, t.status, t.rank)]);
```

Add indexes: `projects(user_id)`, `story_updates(story_id, created_at)`, `agents(user_id)`, `oauth_tokens(access_token_hash)`, `sessions(expires_at)`.

- [ ] **Step 4: Generate the migration**

```bash
npx drizzle-kit generate
```

`drizzle.config.ts` points `schema` at `./src/server/db/schema.ts`, `out` at `./drizzle`, `dialect: 'sqlite'`.

- [ ] **Step 5: Implement `index.ts`, `migrate.ts`, `testing.ts`**

`openDb` creates the parent directory if needed, opens better-sqlite3, sets `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`, wraps in `drizzle()`. `runMigrations` calls `migrate(db, {migrationsFolder: 'drizzle'})` — resolve the folder relative to the compiled file so it works inside Docker. `createTestDb` = `openDb(':memory:')` + `runMigrations`.

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm run check`

- [ ] **Step 7: Wire migrations into boot and commit**

`src/server/index.ts` calls `runMigrations(db)` before `app.listen`; a migration failure logs and exits 1.

```bash
git add -A && git commit -m "feat: add sqlite schema with drizzle migrations"
```

---

### Task 3: Domain rules — ranking, transitions, dependencies

**Files:**
- Create: `src/shared/rank.ts`, `src/shared/transitions.ts`, `src/shared/dependencies.ts`
- Test: `src/shared/rank.test.ts`, `src/shared/transitions.test.ts`, `src/shared/dependencies.test.ts`

**Interfaces:**
- Consumes: `Status` (Task 1).
- Produces:
  - `rankBetween(before: string | null, after: string | null): string` — lexicographic fractional index
  - `type Actor = 'user' | 'agent'`
  - `canTransition(from: Status, to: Status, actor: Actor): {ok: true} | {ok: false; reason: string}`
  - `blockedBy(storyId: string, deps: Map<string, string[]>, statusOf: Map<string, Status>): string[]`
  - `wouldCycle(storyId: string, dependsOnId: string, deps: Map<string, string[]>): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// rank.test.ts
import {describe, it, expect} from 'vitest';
import {rankBetween} from './rank.js';

describe('rankBetween', () => {
  it('produces a rank between two neighbours', () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const mid = rankBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
  });
  it('prepends before the first', () => {
    const a = rankBetween(null, null);
    expect(rankBetween(null, a) < a).toBe(true);
  });
  it('survives 500 successive midpoint insertions', () => {
    let lo = rankBetween(null, null), hi = rankBetween(lo, null);
    for (let i = 0; i < 500; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      hi = mid;
    }
  });
  it('throws when neighbours are out of order', () => {
    expect(() => rankBetween('b', 'a')).toThrow();
  });
});
```

```ts
// transitions.test.ts
import {describe, it, expect} from 'vitest';
import {canTransition} from './transitions.js';

describe('canTransition', () => {
  it('lets a human accept a finished story', () => {
    expect(canTransition('finished', 'accepted', 'user').ok).toBe(true);
  });
  it('never lets an agent accept', () => {
    const r = canTransition('finished', 'accepted', 'agent');
    expect(r.ok).toBe(false);
    expect(r).toHaveProperty('reason');
  });
  it('lets an agent bounce between in_progress and in_test', () => {
    expect(canTransition('in_progress', 'in_test', 'agent').ok).toBe(true);
    expect(canTransition('in_test', 'in_progress', 'agent').ok).toBe(true);
  });
  it('forbids an agent moving a draft', () => {
    expect(canTransition('draft', 'todo', 'agent').ok).toBe(false);
  });
  it('forbids skipping from todo straight to finished', () => {
    expect(canTransition('todo', 'finished', 'agent').ok).toBe(false);
  });
  it('allows a human to send finished work back to todo for rework', () => {
    expect(canTransition('finished', 'todo', 'user').ok).toBe(true);
    expect(canTransition('accepted', 'todo', 'user').ok).toBe(true);
  });
});
```

```ts
// dependencies.test.ts
describe('blockedBy', () => {
  it('reports unfinished dependencies', () => { /* deps: s2 -> [s1], s1 in todo => ['s1'] */ });
  it('treats finished and accepted as satisfied', () => { /* => [] */ });
});
describe('wouldCycle', () => {
  it('detects a direct cycle', () => { /* s1 -> s2, adding s2 -> s1 => true */ });
  it('detects a transitive cycle', () => { /* s1->s2->s3, adding s3->s1 => true */ });
  it('allows a diamond', () => { /* s4->s2, s4->s3, s2->s1, s3->s1 => false */ });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx vitest run src/shared`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `rank.ts`**

Base-62 fractional index over the alphabet `0-9A-Za-z`. `rankBetween(null, null)` returns `'U'` (mid-alphabet). Between two strings, walk characters, take the midpoint of the first differing position, and append a midpoint character when the gap is exhausted. Throw `RangeError` if `before >= after`.

- [ ] **Step 4: Implement `transitions.ts`**

One table, both actors:

```ts
const ALLOWED: Record<Status, Partial<Record<Status, Actor[]>>> = {
  draft:       {todo: ['user']},
  todo:        {draft: ['user'], in_progress: ['user','agent']},
  in_progress: {in_test: ['user','agent'], todo: ['user','agent'], draft: ['user']},
  in_test:     {in_progress: ['user','agent'], finished: ['user','agent'], todo: ['user','agent']},
  finished:    {accepted: ['user'], todo: ['user'], in_progress: ['user','agent']},
  accepted:    {todo: ['user'], finished: ['user']},
};
```

`canTransition` returns `{ok: false, reason: 'Agents cannot accept stories — only a human can.'}` for the agent→`accepted` case specifically, and a generic `"Cannot move a story from X to Y."` otherwise. Same-status moves (reordering within a column) return `{ok: true}`.

- [ ] **Step 5: Implement `dependencies.ts`**

`blockedBy` returns dependency ids whose status is not `finished` or `accepted`. `wouldCycle` runs a DFS from `dependsOnId` looking for `storyId`.

- [ ] **Step 6: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add rank, transition guard and dependency rules"
```

---

### Task 4: Authentication

**Files:**
- Create: `src/server/services/auth.ts`, `src/server/routes/auth.ts`, `src/server/plugins/session.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/routes/auth.test.ts`

**Interfaces:**
- Consumes: `createTestDb`, `users` table, `buildApp`.
- Produces:
  - `registerUser(db, {email, password}): Promise<User>` — throws `ConflictError` on duplicate email
  - `verifyUser(db, {email, password}): Promise<User | null>`
  - `requireUser` — Fastify `preHandler` that 401s and otherwise sets `req.user = {id, email}`
  - Test helper `src/server/testing/harness.ts`: `createHarness(): Promise<{app, db, register(email?, password?): Promise<{cookie: string; user: User}>}>`

- [ ] **Step 1: Write the failing test**

```ts
import {describe, it, expect, beforeEach} from 'vitest';
import {createHarness} from '../testing/harness.js';

describe('auth', () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => { h = await createHarness(); });

  it('registers and returns the user', async () => {
    const res = await h.app.inject({method: 'POST', url: '/api/auth/register',
      payload: {email: 'Dev@Example.com ', password: 'hunter22hunter22'}});
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBe('dev@example.com');   // lowercased, trimmed
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('rejects a short password', async () => {
    const res = await h.app.inject({method: 'POST', url: '/api/auth/register',
      payload: {email: 'a@b.co', password: 'short'}});
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate email', async () => { /* register twice => 409 */ });

  it('never stores the password in plaintext', async () => { /* select users, expect hash !== password and startsWith('$argon2') */ });

  it('logs in with correct credentials and rejects wrong ones', async () => { /* 200 then 401 */ });

  it('401s on /api/me without a session and 200s with one', async () => { /* … */ });

  it('logs out, invalidating the session', async () => { /* logout then /api/me => 401 */ });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/server/routes/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the session plugin**

Register `@fastify/cookie` then `@fastify/session` with a **SQLite-backed store** (implement `SqliteSessionStore` with `set/get/destroy` against the `sessions` table; prune expired rows on an hourly `setInterval` unref'd timer). Cookie: `httpOnly: true`, `sameSite: 'lax'`, `secure` when `PUBLIC_URL` starts with `https`, `maxAge` 30 days.

- [ ] **Step 4: Implement `services/auth.ts` and `routes/auth.ts`**

Zod schemas: email `z.string().email().trim().toLowerCase()`, password `z.string().min(12).max(200)`. Hash with `@node-rs/argon2` `hash()` defaults (Argon2id). `verifyUser` runs `verify()` and returns `null` on mismatch — the login route returns the same 401 body for unknown email and wrong password, so it can't be used to enumerate accounts.

`requireUser` reads `req.session.userId`, loads the user, 401s with `{error: 'unauthorized'}` when absent.

- [ ] **Step 5: Implement the test harness**

```ts
export async function createHarness() {
  const db = createTestDb();
  const app = await buildApp({db});
  await app.ready();
  async function register(email = 'dev@example.com', password = 'hunter22hunter22') {
    const res = await app.inject({method: 'POST', url: '/api/auth/register', payload: {email, password}});
    const cookie = (res.headers['set-cookie'] as string).split(';')[0];
    return {cookie, user: res.json()};
  }
  return {app, db, register};
}
```

- [ ] **Step 6: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add argon2 registration, login and sessions"
```

---

### Task 5: Event hub and WebSocket transport

**Files:**
- Create: `src/server/events/hub.ts`, `src/server/routes/ws.ts`
- Modify: `src/server/app.ts`
- Test: `src/server/events/hub.test.ts`, `src/server/routes/ws.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `ServerEvent` type.
- Produces:
  - `class EventHub { subscribe(userId: string, send: (e: ServerEvent) => void): () => void; publish(userId: string, event: ServerEvent): void; waiters }`
  - `hub.waitFor(userId, predicate: (e: ServerEvent) => boolean, timeoutMs): Promise<ServerEvent | null>` — used later by the MCP long-poll
  - `app.hub` decoration

- [ ] **Step 1: Write the failing tests**

```ts
describe('EventHub', () => {
  it('delivers events only to the owning user', () => {
    const hub = new EventHub();
    const a: ServerEvent[] = [], b: ServerEvent[] = [];
    hub.subscribe('u1', e => a.push(e));
    hub.subscribe('u2', e => b.push(e));
    hub.publish('u1', {type: 'story.deleted', id: 's1'});
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
  it('stops delivering after unsubscribe', () => { /* … */ });
  it('survives a throwing subscriber', () => { /* one bad + one good subscriber, good still receives */ });
  it('resolves waitFor when a matching event arrives', async () => { /* … */ });
  it('resolves waitFor to null on timeout', async () => { /* timeout 20ms => null */ });
});
```

`ws.test.ts` uses the real server: `app.listen({port: 0})`, connect a `ws` client with the session cookie, publish via `app.hub`, assert the client receives the JSON; then assert an unauthenticated connection is closed.

- [ ] **Step 2: Run them, verify they fail**

- [ ] **Step 3: Implement the hub**

`Map<string, Set<(e) => void>>`. `publish` iterates a copied set inside try/catch so one broken socket can't break the loop. `waitFor` registers a temporary subscriber plus a `setTimeout`, cleaning up both on settle.

- [ ] **Step 4: Implement the WS route**

Register `@fastify/websocket`. `GET /ws` — reject (close 4401) if there's no session. Subscribe on open, unsubscribe on close. Send `{type: 'hello'}` immediately, then `ping` every 30 s; terminate a socket that misses two pongs.

- [ ] **Step 5: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add per-user event hub and websocket endpoint"
```

---

### Task 6: Projects service and routes

**Files:**
- Create: `src/server/services/projects.ts`, `src/server/routes/projects.ts`
- Test: `src/server/routes/projects.test.ts`

**Interfaces:**
- Consumes: harness, `requireUser`, `EventHub`.
- Produces: `listProjects(db, userId)`, `createProject(db, hub, userId, {name, path})`, `updateProject(...)`, `deleteProject(...)` — all publishing `{type: 'project.changed'}`.

- [ ] **Step 1: Write the failing test**

```ts
describe('projects', () => {
  it('creates a project with a name and an absolute path', async () => {
    const {app, register} = h; const {cookie} = await register();
    const res = await app.inject({method: 'POST', url: '/api/projects', headers: {cookie},
      payload: {name: 'agent-jira', path: '/Users/dev/git/agent-jira'}});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({name: 'agent-jira', path: '/Users/dev/git/agent-jira'});
  });
  it('rejects a relative path', async () => { /* path: 'relative/dir' => 400 */ });
  it('rejects an empty name', async () => { /* => 400 */ });
  it('lists only the caller\'s projects', async () => { /* two users, each sees one */ });
  it('404s when updating another user\'s project', async () => { /* … */ });
  it('409s when deleting a project that still has stories', async () => { /* … */ });
  it('publishes project.changed on create', async () => { /* subscribe to app.hub, assert */ });
});
```

- [ ] **Step 2–4: fail → implement → pass**

Path validation: `z.string().trim().min(1).refine(p => p.startsWith('/') || /^[A-Za-z]:\\/.test(p), 'Path must be absolute')`. Every query filters `eq(projects.userId, userId)`; a miss returns 404 (never 403 — don't confirm the row exists).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add project CRUD scoped per user"
```

---

### Task 7: Stories service and routes

**Files:**
- Create: `src/server/services/stories.ts`, `src/server/services/board.ts`, `src/server/routes/stories.ts`, `src/server/routes/board.ts`
- Test: `src/server/routes/stories.test.ts`, `src/server/services/board.test.ts`

**Interfaces:**
- Consumes: `rankBetween`, `canTransition`, `blockedBy`, `wouldCycle`, `EventHub`.
- Produces:
  - `getBoard(db, userId): BoardSnapshot` — `{stories: Story[], projects: Project[], agents: Agent[]}`, each story carrying `blockedBy`
  - `createStory(db, hub, userId, input): Story`
  - `moveStory(db, hub, {userId, storyId, status, beforeId?, afterId?, actor, agentId?}): Story` — throws `TransitionError` (→409)
  - `postProgress(db, hub, {userId, storyId, progressPct, label, agentId}): Story`
  - `addUpdate(db, hub, {userId, storyId, body, kind, authorType, authorId}): StoryUpdate`
  - `requestPlay(db, hub, userId, storyId)`, `requestStop(db, hub, userId, storyId)`

- [ ] **Step 1: Write the failing tests** (the largest test file in the project — write all of these)

```ts
describe('stories', () => {
  it('creates into draft with the default model and a rank', async () => { /* status 'draft', rank non-empty */ });
  it('rejects a story for another user\'s project', async () => { /* => 400/404 */ });
  it('rejects an unknown model id', async () => { /* => 400 */ });
  it('stores dependencies and exposes blockedBy', async () => { /* s2 depends on s1 (todo) => blockedBy: ['s1'] */ });
  it('rejects a dependency cycle', async () => { /* => 400 with reason */ });
  it('moves draft -> todo and back', async () => { /* 200 both ways */ });
  it('409s when an agent tries to accept', async () => { /* actor agent via service call => TransitionError */ });
  it('reorders within a column using beforeId/afterId', async () => {
    // three cards; move the third between the first and second; assert rank ordering
  });
  it('clears stop_requested and the claim when released to todo', async () => { /* … */ });
  it('records a status_change update on every move', async () => { /* updates list contains kind 'status_change' */ });
  it('publishes story.moved on the hub', async () => { /* … */ });
  it('clamps progress to 0..100 and publishes story.progress', async () => { /* -5 => 400, 150 => 400, 50 => ok */ });
  it('appends a human remark and returns it in the timeline', async () => { /* POST /updates then GET /updates */ });
  it('sets playRequestedAt on play and stopRequested on stop', async () => { /* … */ });
  it('deletes a story along with its updates and dependencies', async () => { /* … */ });
  it('never leaks another user\'s story through any endpoint', async () => {
    // user B: GET/PATCH/DELETE/move/updates on A's story => all 404
  });
});
```

- [ ] **Step 2: Run, verify they fail**

- [ ] **Step 3: Implement the services**

Rules to encode:
- `createStory` defaults `status: 'draft'`, `rank: rankBetween(lastRankInDraft, null)`, `model: DEFAULT_MODEL_ID` when absent, and validates every `dependsOn` id belongs to the same user.
- `moveStory` loads the story, calls `canTransition(story.status, status, actor)`, throws `TransitionError` when not ok. When `actor === 'agent'`, also require `story.claimedByAgentId === agentId` for anything but a claim. Moving to `todo` clears `claimedByAgentId`, `stopRequested`, `playRequestedAt`, and resets `progressPct` to 0 only when coming from `finished`/`accepted` (rework). Every move writes a `status_change` update and publishes `story.moved`.
- All writes run inside `db.transaction(...)`, and the event publishes **after** the transaction commits.

- [ ] **Step 4: Run tests, verify they pass**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add story lifecycle, ordering, dependencies and progress"
```

---

### Task 8: Frontend shell, design system and auth screens

**Files:**
- Create: `index.html`, `vite.config.ts`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/styles/tokens.css`, `src/web/styles/global.css`
- Create: `src/web/lib/api.ts`, `src/web/lib/queries.ts`
- Create: `src/web/components/ui/{Button,Input,Dialog,Select,Switch,Chip,ProgressBar}.tsx`
- Create: `src/web/screens/AuthScreen.tsx`
- Test: `src/web/screens/AuthScreen.test.tsx`, `src/web/components/ui/ProgressBar.test.tsx`

**Interfaces:**
- Consumes: `/api/auth/*`, `/api/me` (Task 4).
- Produces:
  - `api.get/post/patch/del<T>(path, body?): Promise<T>` — credentials `include`, throws `ApiError {status, message}` on non-2xx
  - `useMe()`, `useLogin()`, `useRegister()`, `useLogout()` hooks
  - UI primitives listed above, styled from tokens
  - `<App/>` renders `<AuthScreen/>` when `/api/me` 401s, `<BoardScreen/>` otherwise

- [ ] **Step 1: Read the design skill**

Before writing any component, invoke `frontend-design:frontend-design` and apply it to the spec's "dark technical console" direction. The tokens in Global Constraints are fixed; the skill governs type scale, rhythm and composition.

- [ ] **Step 2: Write the failing tests**

```tsx
// AuthScreen.test.tsx
it('switches between sign in and create account', async () => { /* click toggle, assert heading */ });
it('shows a server error message', async () => { /* mock api to reject with 401, assert message visible */ });
it('disables submit while the request is in flight', async () => { /* … */ });
```

```tsx
// ProgressBar.test.tsx
it('renders the percentage as an accessible progressbar', () => {
  render(<ProgressBar value={42} label="Writing tests" />);
  const bar = screen.getByRole('progressbar');
  expect(bar).toHaveAttribute('aria-valuenow', '42');
  expect(screen.getByText('Writing tests')).toBeInTheDocument();
});
it('renders nothing but the track at 0', () => { /* … */ });
```

- [ ] **Step 3: Run, verify they fail**

Run: `npx vitest run src/web`

- [ ] **Step 4: Implement tokens and primitives**

`tokens.css` declares the palette on `:root` as CSS custom properties plus a `[data-theme="light"]` block, and Tailwind v4 `@theme` maps them to utility names (`bg-canvas`, `text-muted`, `border-hairline`, `text-accent`). Fonts: Inter + JetBrains Mono via `@fontsource` packages (self-hosted — no external CDN so it works offline in Docker).

Primitives wrap Radix where behaviour matters (Dialog, Select, Switch, Tooltip) and are plain elements otherwise. Every interactive element gets a `focus-visible:ring-2 ring-accent` treatment. Respect `prefers-reduced-motion` in every transition.

- [ ] **Step 5: Implement the API client and auth screen**

`AuthScreen` is a centered card on the canvas: wordmark, a segmented Sign in / Create account control, email + password fields, inline error, primary accent button. Password rules are stated up front ("at least 12 characters"), not only after a failed submit.

- [ ] **Step 6: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add design tokens, ui primitives and auth screen"
```

---

### Task 9: Board screen with drag and drop

**Files:**
- Create: `src/web/screens/BoardScreen.tsx`, `src/web/components/board/{Board,Column,StoryCard,AgentStrip,TopBar}.tsx`
- Create: `src/web/lib/board-queries.ts`
- Test: `src/web/components/board/Board.test.tsx`, `src/web/components/board/StoryCard.test.tsx`

**Interfaces:**
- Consumes: `/api/board`, `/api/stories/:id/move`, UI primitives.
- Produces: `useBoard()`, `useMoveStory()` (optimistic with rollback), `<Board stories agents onOpenStory/>`.

- [ ] **Step 1: Write the failing tests**

```tsx
// Board.test.tsx
it('renders all six columns with counts', () => {
  render(<Board {...fixture} />);
  ['Draft','To do','In progress','In test','Finished','Accepted']
    .forEach(name => expect(screen.getByRole('heading', {name: new RegExp(name)})).toBeInTheDocument());
});
it('places each story in its status column', () => { /* … */ });
it('orders stories within a column by rank', () => { /* … */ });
it('shows an empty-column hint in draft', () => { /* … */ });
```

```tsx
// StoryCard.test.tsx
it('shows title, model and project', () => { /* … */ });
it('shows edit and delete only in draft', () => { /* … */ });
it('shows play only in todo, and disables it when blocked', () => { /* … */ });
it('shows stop in in_progress and in_test', () => { /* … */ });
it('renders the progress bar only when progress > 0', () => { /* … */ });
it('lists blocking story titles in the blocked chip tooltip', () => { /* … */ });
```

- [ ] **Step 2: Run, verify they fail**

- [ ] **Step 3: Implement the board**

`@dnd-kit` `DndContext` with `closestCorners`, a `SortableContext` per column, `PointerSensor` (8 px activation distance so clicks still open the dialog) and `KeyboardSensor`. `onDragEnd` computes `beforeId`/`afterId` from the target column's ordered list and calls the move mutation.

`useMoveStory` is optimistic: it patches the board cache immediately, and on error rolls back and shows a toast carrying the server's `reason` (e.g. "Agents cannot accept stories"). Columns `in_progress`/`in_test` accept drags from the human too — the guard decides, not the UI.

Cards owned by an agent get a 2 px animated accent left edge (a slow opacity pulse, disabled under `prefers-reduced-motion`).

- [ ] **Step 4: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add kanban board with drag and drop"
```

---

### Task 10: Story dialogs and project creation

**Files:**
- Create: `src/web/components/story/{StoryFormDialog,StoryDetailDialog,DependencyPicker,ProjectCreateInline}.tsx`
- Modify: `src/web/screens/BoardScreen.tsx`
- Test: `src/web/components/story/StoryFormDialog.test.tsx`, `src/web/components/story/StoryDetailDialog.test.tsx`

**Interfaces:**
- Consumes: `/api/projects`, `/api/stories`, `/api/stories/:id/updates`, `MODELS`, `DEFAULT_MODEL_ID`.
- Produces: `<StoryFormDialog mode="create"|"edit" story? open onOpenChange/>`, `<StoryDetailDialog storyId open onOpenChange/>`.

- [ ] **Step 1: Write the failing tests**

```tsx
// StoryFormDialog.test.tsx
it('defaults the model select to Claude Opus 5', () => { /* … */ });
it('groups models by provider', () => { /* Anthropic + OpenAI group labels */ });
it('requires a title and a project', async () => { /* submit empty => inline errors, no request */ });
it('creates a project inline and selects it', async () => { /* click "+ New project", fill name+path, assert selected */ });
it('excludes the edited story from its own dependency options', async () => { /* … */ });
it('submits the full payload', async () => { /* assert the mutation received title, projectId, model, description, dependsOn */ });
```

```tsx
// StoryDetailDialog.test.tsx
it('renders the progress bar with its label', () => { /* … */ });
it('renders the update timeline newest last, marking agent vs human authors', () => { /* … */ });
it('posts a remark and clears the composer', async () => { /* … */ });
it('shows the project path in monospace', () => { /* … */ });
```

- [ ] **Step 2: Run, verify they fail**

- [ ] **Step 3: Implement the dialogs**

The form dialog is a single column: Title, Project (Radix Select with a pinned `+ New project` item that swaps the row for an inline name + path form), Model (grouped Select), Description (auto-growing textarea, 4 rows min), Dependencies (searchable multi-select listing `title` + status chip, excluding the current story). Primary button `Add to draft` / `Save`.

The detail dialog is a two-zone layout: a header block (title, status chip, project path in mono, model chip, progress bar) and a scrollable timeline with a sticky remark composer at the bottom. Agent entries get a small violet glyph, human entries a neutral one; `progress` entries render compactly as `42% · Writing tests`.

- [ ] **Step 4: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add story create, edit and detail dialogs"
```

---

### Task 11: Live updates over WebSocket

**Files:**
- Create: `src/web/lib/useLiveBoard.ts`
- Modify: `src/web/screens/BoardScreen.tsx`
- Test: `src/web/lib/useLiveBoard.test.ts`

**Interfaces:**
- Consumes: `/ws`, `ServerEvent`, TanStack Query cache.
- Produces: `useLiveBoard(): {connected: boolean}` — subscribes on mount, patches the `['board']` cache per event, refetches on reconnect.

- [ ] **Step 1: Write the failing test**

Use a fake WebSocket class injected via the hook's options parameter (`useLiveBoard({socketFactory})`) so no real network is needed.

```ts
it('patches a story in the cache on story.updated', async () => { /* … */ });
it('moves a story between columns on story.moved', async () => { /* … */ });
it('updates only the progress fields on story.progress', async () => { /* assert other fields untouched */ });
it('appends to the update timeline cache on story.update', async () => { /* … */ });
it('removes a story on story.deleted', async () => { /* … */ });
it('refetches the board after a reconnect', async () => { /* close the socket, advance timers, assert invalidate called */ });
it('backs off exponentially between reconnect attempts', async () => { /* 1s, 2s, 4s … capped at 15s */ });
```

- [ ] **Step 2: Run, verify it fails**

- [ ] **Step 3: Implement the hook**

Single socket per app instance. On `story.progress`, patch in place so the bar animates rather than the card remounting. Show a small "reconnecting…" pill in the top bar while disconnected.

- [ ] **Step 4: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: live-update the board over websockets"
```

---

### Task 12: OAuth 2.1 authorization server

**Files:**
- Create: `src/server/oauth/{metadata,register,authorize,token,tokens}.ts`, `src/server/routes/oauth.ts`
- Create: `src/web/screens/ConsentScreen.tsx`
- Test: `src/server/oauth/oauth.test.ts`, `src/server/oauth/pkce.test.ts`

**Interfaces:**
- Consumes: `oauthClients`, `oauthCodes`, `oauthTokens`, `agents` tables; `requireUser`.
- Produces:
  - `verifyChallenge(verifier: string, challenge: string, method: 'S256'): boolean`
  - `issueTokens(db, {clientId, userId, agentId}): {accessToken, refreshToken, expiresIn}`
  - `authenticateBearer(db, header?: string): {userId: string; agentId: string} | null`
  - Routes: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/authorize` (consent decision), `POST /oauth/token`, `POST /oauth/revoke`

- [ ] **Step 1: Write the failing tests**

```ts
describe('PKCE', () => {
  it('accepts a matching S256 verifier', () => { /* known vector from RFC 7636 */ });
  it('rejects a mismatched verifier', () => { /* … */ });
  it('rejects the plain method', () => { /* … */ });
});

describe('oauth flow', () => {
  it('advertises metadata with the public url', async () => { /* issuer matches PUBLIC_URL */ });
  it('registers a client dynamically', async () => { /* POST /oauth/register => client_id, redirect_uris echoed */ });
  it('rejects registration with a non-http(s) redirect uri', async () => { /* => 400 */ });
  it('redirects an unauthenticated authorize to login and back', async () => { /* 302 to /?next=… */ });
  it('creates an agent and a code when consent is granted', async () => { /* agent row exists with the submitted name */ });
  it('redirects with error=access_denied when consent is refused', async () => { /* … */ });
  it('exchanges a code with the right verifier exactly once', async () => { /* second exchange => 400 invalid_grant */ });
  it('rejects an expired code', async () => { /* … */ });
  it('rejects a code replayed with a different client_id', async () => { /* … */ });
  it('stores only hashes of tokens', async () => { /* select oauth_tokens, assert no plaintext */ });
  it('refreshes an access token and rotates the refresh token', async () => { /* … */ });
  it('rejects a bearer token after the agent is revoked', async () => { /* … */ });
});
```

- [ ] **Step 2: Run, verify they fail**

- [ ] **Step 3: Implement the server**

- Codes: 10-minute TTL, single use (delete on exchange), bound to `client_id` + `redirect_uri` + `code_challenge`.
- Tokens: 32-byte random, returned as `aj_<base64url>`, stored as SHA-256. Access 8 h, refresh 90 d with rotation.
- `/oauth/register` is public but rate-limited (`@fastify/rate-limit`, 10/hour/IP) and only accepts `http://localhost*`, `http://127.0.0.1*` or `https://` redirect URIs.
- `GET /oauth/authorize` without a session redirects to `/?next=<encoded>`; the SPA logs in and returns.
- `POST /oauth/authorize` is the consent decision: on allow, create the `agents` row (name from the form, default `Claude Code`) and the code, then redirect.

- [ ] **Step 4: Implement `ConsentScreen.tsx`**

Full-page card: app wordmark, the client name, the exact permissions in plain language ("Read your board", "Create and move stories", "Post progress updates"), an editable **Agent name** field, and two buttons — `Allow` (accent) and `Deny` (ghost). It must be visually unmistakable as a security decision: no marketing copy, no dismissible overlay.

- [ ] **Step 5: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add oauth 2.1 authorization server with consent screen"
```

---

### Task 13: MCP server

**Files:**
- Create: `src/server/mcp/{server,instructions,tools,control}.ts`, `src/server/routes/mcp.ts`
- Test: `src/server/mcp/mcp.test.ts`, `src/server/mcp/instructions.test.ts`

**Interfaces:**
- Consumes: every story/board/agent service, `authenticateBearer`, `EventHub.waitFor`.
- Produces:
  - `INSTRUCTIONS: string` from `instructions.ts`
  - `buildMcpServer(ctx: {db, hub, userId, agentId}): McpServer`
  - `controlBlock(db, {userId, storyId?, agentId}): {stop_requested: boolean; autonomous: boolean; remarks: string[]}`
  - `POST /mcp` mounted in `app.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('instructions', () => {
  it('names every column in order', () => {
    ['draft','todo','in_progress','in_test','finished','accepted']
      .forEach(s => expect(INSTRUCTIONS).toContain(s));
  });
  it('tells the agent to use superpowers skills', () => {
    expect(INSTRUCTIONS).toMatch(/superpowers/i);
    expect(INSTRUCTIONS).toMatch(/test-driven-development|TDD/i);
  });
  it('forbids accepting stories', () => { expect(INSTRUCTIONS).toMatch(/never .*accepted/i); });
  it('documents the control block and the stop protocol', () => { /* … */ });
  it('documents clearing context between stories', () => { expect(INSTRUCTIONS).toMatch(/\/clear/); });
});

describe('mcp tools', () => {
  it('401s without a bearer token', async () => { /* POST /mcp => 401 with WWW-Authenticate */ });
  it('lists every documented tool', async () => {
    // tools/list => exactly: get_board, get_story, list_projects, wait_for_work,
    // claim_next_story, move_story, post_progress, post_update, release_story, set_agent_mode
  });
  it('returns only the token owner\'s board', async () => { /* two users, assert isolation */ });
  it('claims the highest-ranked unblocked todo story', async () => { /* blocked one skipped */ });
  it('refuses to claim when another agent holds the story', async () => { /* … */ });
  it('moves in_progress -> in_test and rejects -> accepted', async () => { /* … */ });
  it('updates the progress bar and publishes on the hub', async () => { /* … */ });
  it('includes the control block in every tool result', async () => { /* … */ });
  it('surfaces a human remark once in control.remarks', async () => { /* second call: already delivered => empty */ });
  it('reports stop_requested after POST /stories/:id/stop', async () => { /* … */ });
  it('resolves wait_for_work when a story is played', async () => { /* start the call, play a story, assert resolution */ });
  it('returns work:false after the timeout', async () => { /* timeoutSeconds: 1 */ });
  it('marks the agent waiting, then working, then idle', async () => { /* agents.status transitions */ });
});
```

- [ ] **Step 2: Run, verify they fail**

- [ ] **Step 3: Write `instructions.ts`**

The full operating manual from the spec, section 6, as a single template string. It must state, in this order and in plain imperative English: role; use superpowers skills (brainstorming when vague, TDD while implementing, systematic-debugging on failure, verification-before-completion before `finished`); work only in `project.path`; move through every state without skipping and why (the human reads transitions as the status report); call `post_progress` at every meaningful step with a human-readable label; honour `control.stop_requested` immediately by posting what was done and calling `release_story`; read and act on `control.remarks`; never move a story to `accepted`; and on reaching `finished`, check `control.autonomous` — if true, `/clear` then `claim_next_story`; if false, ask the human before claiming anything.

- [ ] **Step 4: Implement the tools and transport**

Use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` with `StreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`), constructing a fresh server per request from the bearer identity. Register every tool with a Zod schema and a description that repeats the relevant rule (agents often read tool descriptions more carefully than instructions).

`wait_for_work` uses `hub.waitFor(userId, e => e.type === 'story.moved' || e.type === 'story.updated', timeoutMs)` plus an immediate pre-check for an already-playable story, and clamps `timeoutSeconds` to 55.

`controlBlock` reads `stop_requested` from the story, `autonomous` from the agent, and any `story_updates` of kind `remark` created after `agents.last_seen_at`; it then advances `last_seen_at`, so a remark is delivered once.

Every tool result is `{content: [{type: 'text', text: JSON.stringify({...payload, control})}]}`.

- [ ] **Step 5: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add mcp server with agent workflow instructions"
```

---

### Task 14: Agents UI — strip, connect dialog, play and stop

**Files:**
- Create: `src/server/routes/agents.ts`, `src/server/services/agents.ts`
- Create: `src/web/components/agent/{AgentStrip,ConnectAgentDialog}.tsx`
- Modify: `src/web/components/board/{StoryCard,TopBar}.tsx`
- Test: `src/server/routes/agents.test.ts`, `src/web/components/agent/ConnectAgentDialog.test.tsx`, `src/web/components/agent/AgentStrip.test.tsx`

**Interfaces:**
- Consumes: `/api/agents`, `/api/stories/:id/play`, `/api/stories/:id/stop`, `PUBLIC_URL` (exposed to the SPA via `GET /api/config` → `{publicUrl, mcpUrl}`).
- Produces: `useAgents()`, `useSetAutonomous()`, `usePlayStory()`, `useStopStory()`.

- [ ] **Step 1: Write the failing tests**

```ts
// agents.test.ts
it('lists only the caller\'s agents', async () => { /* … */ });
it('toggles autonomous and publishes agent.updated', async () => { /* … */ });
it('revoking an agent deletes its tokens and 401s its next mcp call', async () => { /* … */ });
it('releases a claimed story when its agent is revoked', async () => { /* story back to todo */ });
```

```tsx
// ConnectAgentDialog.test.tsx
it('shows the full mcp url from server config', () => {
  render(<ConnectAgentDialog open config={{mcpUrl: 'https://board.example/mcp'}} agents={[]} />);
  expect(screen.getByText('https://board.example/mcp')).toBeInTheDocument();
});
it('shows the copyable claude mcp add command', () => { /* contains 'claude mcp add --transport http agent-jira' */ });
it('copies the command to the clipboard', async () => { /* mock navigator.clipboard, assert writeText */ });
it('lists connected agents with a revoke button', () => { /* … */ });
it('explains the consent step', () => { /* text mentions browser + Allow */ });
```

```tsx
// AgentStrip.test.tsx
it('renders an empty state when no agents are connected', () => { /* … */ });
it('shows each agent\'s status and current story', () => { /* … */ });
it('toggles autonomous mode', async () => { /* … */ });
```

- [ ] **Step 2: Run, verify they fail**

- [ ] **Step 3: Implement**

`GET /api/config` returns `{mcpUrl: `${publicUrl}/mcp`}` — never hardcode the URL in the client. Revoking an agent runs in one transaction: delete tokens, release any claimed story back to `todo` with a `system` update ("Agent revoked — story released"), delete the agent row.

Play button: `POST /api/stories/:id/play` sets `playRequestedAt` and publishes `story.updated`; the card shows a "queued" pulse until an agent claims it. Stop: sets `stopRequested`, card shows "stopping…" until the agent releases or moves it.

- [ ] **Step 4: Run tests, verify they pass, commit**

```bash
npm run check
git add -A && git commit -m "feat: add agent presence, connect dialog and play/stop controls"
```

---

### Task 15: Docker image and compose deployment

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `README.md`
- Modify: `src/server/app.ts` (serve the SPA in production), `.env.example`
- Test: `scripts/smoke-test.sh`

**Interfaces:**
- Consumes: `npm run build`, `npm start`.
- Produces: a working `docker compose up -d` deployment on port 3000 with a `agent-jira-data` volume.

- [ ] **Step 1: Write the failing smoke test**

```bash
#!/usr/bin/env bash
# scripts/smoke-test.sh — fails until the image builds and boots
set -euo pipefail
docker compose up -d --build
trap 'docker compose down -v' EXIT
for i in $(seq 1 60); do
  if curl -fsS http://localhost:3000/api/health | grep -q '"status":"ok"'; then break; fi
  sleep 2
done
curl -fsS http://localhost:3000/api/health | grep -q '"status":"ok"'
curl -fsS -X POST http://localhost:3000/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"hunter22hunter22"}' | grep -q smoke@example.com
curl -fsS http://localhost:3000/ | grep -qi '<div id="root"'
curl -fsS -o /dev/null -w '%{http_code}' http://localhost:3000/.well-known/oauth-authorization-server | grep -q 200
echo "smoke test passed"
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bash scripts/smoke-test.sh`
Expected: FAIL — no Dockerfile.

- [ ] **Step 3: Write the Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
```

`better-sqlite3` needs prebuilt binaries on alpine; if `npm ci` fails to find one, add `RUN apk add --no-cache --virtual .build python3 make g++` before the install and `apk del .build` after.

- [ ] **Step 4: Write `docker-compose.yml`**

```yaml
services:
  agent-jira:
    build: .
    image: agent-jira:latest
    restart: unless-stopped
    ports: ["${PORT:-3000}:3000"]
    environment:
      NODE_ENV: production
      DATABASE_PATH: /data/agent-jira.db
      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET in .env}
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:3000}
    volumes: ["agent-jira-data:/data"]
volumes:
  agent-jira-data:
```

- [ ] **Step 5: Serve the SPA in production**

In `buildApp`, when `NODE_ENV === 'production'`, register `@fastify/static` on `dist/web` and add a SPA fallback that returns `index.html` for any GET that isn't `/api/*`, `/ws`, `/mcp` or `/.well-known/*`.

- [ ] **Step 6: Run the smoke test, verify it passes**

Run: `bash scripts/smoke-test.sh`
Expected: `smoke test passed`

- [ ] **Step 7: Write the README and commit**

README covers: what it is, a 60-second quickstart (`cp .env.example .env`, generate a secret with `openssl rand -hex 32`, `docker compose up -d`), connecting an agent (`claude mcp add --transport http agent-jira http://localhost:3000/mcp` + the consent flow), the board workflow, deploying behind a reverse proxy (set `PUBLIC_URL`, forward `/ws` and `/mcp`), backups (copy the volume's `.db`), and local development.

```bash
git add -A && git commit -m "feat: containerize with docker compose deployment"
```

---

### Task 16: Host runner script

**Files:**
- Create: `scripts/agent-runner.sh`, `scripts/runner.example.json`
- Modify: `src/server/routes/agents.ts` (add `GET /api/runner/queued`), `README.md`
- Test: `src/server/routes/runner.test.ts`

**Interfaces:**
- Consumes: `authenticateBearer` (same tokens as MCP).
- Produces: `GET /api/runner/queued` → `{story: {id, title, projectPath} | null}` — the oldest `playRequestedAt` unclaimed, unblocked `todo` story.

- [ ] **Step 1: Write the failing test**

```ts
it('401s without a bearer token', async () => { /* … */ });
it('returns null when nothing is queued', async () => { /* … */ });
it('returns the oldest played story with its project path', async () => { /* … */ });
it('skips blocked and already-claimed stories', async () => { /* … */ });
it('never returns another user\'s story', async () => { /* … */ });
```

- [ ] **Step 2: Run, verify it fails**

- [ ] **Step 3: Implement the endpoint and the script**

```bash
#!/usr/bin/env bash
# scripts/agent-runner.sh — cold-starts a Claude Code agent when a story is played.
set -euo pipefail
CONFIG="${AGENT_JIRA_CONFIG:-$HOME/.agent-jira/runner.json}"
[ -f "$CONFIG" ] || { echo "missing config: $CONFIG (see scripts/runner.example.json)" >&2; exit 1; }
BASE_URL=$(jq -r .baseUrl "$CONFIG"); TOKEN=$(jq -r .token "$CONFIG")
INTERVAL=$(jq -r '.pollSeconds // 10' "$CONFIG")
echo "agent-jira runner watching $BASE_URL every ${INTERVAL}s"
while true; do
  RESP=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/runner/queued" || echo '{}')
  STORY_ID=$(printf '%s' "$RESP" | jq -r '.story.id // empty')
  if [ -n "$STORY_ID" ]; then
    DIR=$(printf '%s' "$RESP" | jq -r '.story.projectPath')
    TITLE=$(printf '%s' "$RESP" | jq -r '.story.title')
    echo "==> launching agent for: $TITLE ($STORY_ID) in $DIR"
    (cd "$DIR" && claude -p "Connect to the agent-jira MCP server, claim story $STORY_ID, and implement it following the server's instructions exactly.")
  fi
  sleep "$INTERVAL"
done
```

`runner.example.json`: `{"baseUrl": "http://localhost:3000", "token": "aj_…", "pollSeconds": 10}`. Document in the README that the token comes from the Connect agent dialog and that `jq` and the `claude` CLI are prerequisites.

- [ ] **Step 4: Run tests, verify they pass, commit**

```bash
npm run check
bash -n scripts/agent-runner.sh
git add -A && git commit -m "feat: add host runner script for cold-starting agents"
```

---

## Done criteria

- `npm run check` passes with no skipped tests.
- `bash scripts/smoke-test.sh` passes from a clean `docker compose down -v`.
- Manual pass: register → create project → create story → drag to todo → connect an agent via `claude mcp add` → consent → agent claims, progresses, tests and finishes the story → the board updates live throughout → human drags it to accepted.
