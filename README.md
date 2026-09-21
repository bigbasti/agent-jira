# agent-jira

A kanban board for work done by AI coding agents. You write stories, drag them into
`To do`, and a Claude Code (or any MCP-capable) agent connected to the board picks them
up, works them through `In progress` and `In test`, and hands them back as `Finished` for
you to review and accept. It is a normal web app — sign in, click around, drag cards — but
the thing doing the cards is a coding agent talking to the server over MCP, not another
human.

This README covers running it in Docker, connecting an agent, how the board works, and
running it for development.

## 60-second quickstart

You need Docker and Docker Compose (`docker compose version`).

```bash
git clone <this repo> agent-jira
cd agent-jira
cp .env.example .env
```

Open `.env` and set `SESSION_SECRET` to a real random value — the server refuses to start
in production without one:

```bash
openssl rand -hex 32
# paste the output as SESSION_SECRET= in .env
```

Then bring it up:

```bash
docker compose up -d
```

Open http://localhost:3000, register an account, and you're looking at an empty board.
The image bundles everything: the API, the WebSocket that keeps the board live, the MCP
server agents connect to, and the built frontend, all served by one process on port 3000.
Data lives in the `agent-jira-data` named volume, so it survives `docker compose down` (but
not `docker compose down -v` — see [Backups](#backups)).

## Connecting an agent

Point Claude Code's MCP client at the server:

```bash
claude mcp add --transport http agent-jira http://localhost:3000/mcp
```

The first tool call opens a browser window at this server's sign-in page (bring your own —
the same account you registered above works). Sign in, and you land on a consent screen
that shows exactly which client is asking to connect and what it will be able to do: read
your board, create and move stories, and post progress updates. Choose **Allow**, and the
agent appears in the strip at the top of the board, ready to work.

From the board itself, the **Connect agent** button in the top bar shows the same MCP URL
and `claude mcp add` command, plus every agent you've already connected, each with a
**Revoke** button — revoking deletes that agent's credentials immediately and releases
whatever story it was holding back to `To do`.

## How the board works

Columns, left to right: **Draft → To do → In progress → In test → Finished → Accepted.**

You write and own the first two states. A story starts in `Draft` — write it, describe
what you want, pick a project and a model — and you drag it to `To do` when it's ready for
an agent to pick up.

From there, a connected agent drives it:

- **To do → In progress**: an agent claims the story (either you clicked **Play** on the
  card, or the agent is running autonomously and asked for the next one) and starts work,
  scoped strictly to that story's project directory.
- **In progress**: the agent posts progress updates as it works — the card's progress bar
  and the story's timeline both come from these. If you leave a remark on the card, the
  agent picks it up the next time it checks in.
- **In progress → In test**: once the agent believes the work is done, it moves the story
  here and actually verifies it — runs the tests, runs the thing. A failure sends it back
  to `In progress`.
- **In test → Finished**: only after verification passes. This is the agent handing the
  story back to you for review — it will never move a story to `Accepted` itself.
- **Finished → Accepted**: your call, and yours alone. Drag it over once you're happy with
  the result.

Every transition carries a reason the agent writes for you, visible in the story's
timeline — that's usually the clearest window you get into what it actually did. The
**Stop** button on an in-progress card asks the agent to hand the story back at its next
safe checkpoint; the **autonomous** switch on each agent (in the connect-agent dialog)
controls whether it claims the next story on its own once it finishes one, or waits for
you to hand it one.

## Deploying behind a reverse proxy

Running this on a real host — which is what `openship` or any other Docker Compose
platform gives you — normally means a reverse proxy (nginx, Caddy, Traefik, whatever the
platform provides) sits in front of this container and terminates TLS. Two settings matter
for that:

- **`PUBLIC_URL`** — set this to the externally reachable URL the proxy answers to, e.g.
  `https://agent-jira.example.com`. This is the one thing the server uses to build its
  OAuth metadata and the MCP URL it tells agents to use; get it wrong and `claude mcp add`
  will be handed a URL nobody outside the container can reach.
- **`TRUST_PROXY`** — set to `true` once you actually have a reverse proxy in front of the
  container. Without it, every request's IP is attributed to the proxy rather than the
  real client, and rate limiting (in particular the limit on registering new MCP clients)
  collapses to one shared budget for everyone behind the proxy. Leave it `false` if you're
  exposing the container directly — trusting forwarded-for headers from a client that
  isn't actually behind a proxy lets that client forge its own IP and dodge rate limits
  entirely.

Your proxy needs to forward two non-HTTP paths through as-is, not just `/`:

- `/ws` — the board's live WebSocket connection (upgrade requests must pass through).
- `/mcp` — the MCP endpoint agents connect to.

An nginx `location` block, for reference:

```nginx
location / {
    proxy_pass http://agent-jira:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /ws {
    proxy_pass http://agent-jira:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Backups

Everything — accounts, projects, stories, agent credentials — lives in one SQLite file at
`/data/agent-jira.db` inside the `agent-jira-data` volume (plus its `-wal`/`-shm`
sidecars, since the database runs in WAL mode). The simplest reliable backup is a tar of
the whole volume:

```bash
docker run --rm \
  -v agent-jira_agent-jira-data:/data \
  -v "$(pwd)":/backup \
  alpine tar czf /backup/agent-jira-backup.tar.gz -C /data .
```

(Adjust the volume name if you changed the project/service name — check `docker volume
ls`.) Stopping the container first (`docker compose stop`) avoids catching mid-write
state, though WAL mode makes that unlikely to matter. Restore by reversing the tar:

```bash
docker run --rm \
  -v agent-jira_agent-jira-data:/data \
  -v "$(pwd)":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/agent-jira-backup.tar.gz -C /data"
```

## Local development

You don't need Docker for this — the container is for running the finished app, not
building it.

Requirements: Node 22+.

```bash
npm install
cp .env.example .env   # SESSION_SECRET doesn't matter outside production
npm run dev
```

This runs the API (`tsx watch`, auto-restarting on server changes) and Vite's dev server
side by side; Vite proxies `/api`, `/ws`, `/oauth` and `/.well-known` to the API so the
whole app — board and OAuth consent screen included — works at http://localhost:5173
without a build. SQLite migrations run automatically at boot against
`DATABASE_PATH` (`./data/agent-jira.db` by default).

Other useful scripts:

```bash
npm test          # vitest, once
npm run test:watch
npm run typecheck  # both tsconfigs (web + server)
npm run check      # typecheck + test — what CI (and you, before committing) should run
npm run build      # what the Docker image runs: vite build + tsc -p tsconfig.server.json
npm start          # runs the build's output — node dist/server/index.js
```

To try the actual container locally without going through Compose:

```bash
docker build -t agent-jira .
docker run --rm -p 3000:3000 \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -v agent-jira-data:/data \
  agent-jira
```

`scripts/smoke-test.sh` builds the Compose stack, waits for it to come up, and exercises
health, registration, the served SPA, and the OAuth metadata endpoint — run it after
touching anything in the Dockerfile or compose file.
