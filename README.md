# agent-jira

A kanban board for work done by AI coding agents. You write stories, drag them into
`To do`, and a Claude Code (or any MCP-capable) agent connected to the board picks them
up, works them through `In progress` and `In test`, and hands them back as `Finished` for
you to review and accept. It is a normal web app — sign in, click around, drag cards — but
the thing doing the cards is a coding agent talking to the server over MCP, not another
human.

This README covers running it in Docker, connecting an agent, cold-starting one with the
host runner script, how the board works, and running it for development.

## 60-second quickstart

You need Docker and Docker Compose (`docker compose version`).

```bash
git clone <this repo> agent-jira
cd agent-jira
cp .env.example .env
```

Open `.env` and set `SESSION_SECRET` to a real random value — the server refuses to start
in production with one missing, too short, or left as the example placeholder:

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

## Host runner: cold-starting an agent

Connecting an agent only gets you a worker once something is already running and parked,
waiting for work over MCP's `wait_for_work` long-poll. If nothing is running at all — you
played a story from a cold start, or the machine that runs your agents just rebooted — the
story just sits in `To do` with nobody to notice it. `scripts/agent-runner.sh` closes that
gap: a small script you run on your own machine, outside the container, that polls the
board for played work nobody has picked up yet and launches `claude` in the right project
directory to claim it.

**Prerequisites:** [`jq`](https://jqlang.org/) and the Claude Code CLI (`claude`) must both
be on your `PATH`. The script checks for both before it does anything else and exits with a
clear message, rather than a cryptic failure on its first poll, if either is missing.

**Setup**

1. Copy the example config and lock it down — it will hold a live bearer credential:

   ```bash
   mkdir -p ~/.agent-jira
   cp scripts/runner.example.json ~/.agent-jira/runner.json
   chmod 600 ~/.agent-jira/runner.json
   ```

2. Fill in a token. `runner.json`'s `"token"` is the same kind of bearer credential an
   agent gets the moment you approve it on the consent screen the **Connect agent**
   dialog sends you to — the dialog itself only shows you the `claude mcp add` command,
   never the raw token, because the server stores nothing but a hash of it once it's
   issued (see `src/server/oauth/tokens.ts`) and hands the plaintext only to whichever
   client just completed the exchange. For an interactive agent that client is the
   `claude` CLI; for the runner, mint one yourself by walking through the same OAuth
   exchange by hand, once, from a terminal signed in to the board:

   ```bash
   BASE=http://localhost:3000   # your board's URL
   read -rp 'Email: ' EMAIL
   read -rsp 'Password: ' PASSWORD; echo

   # 1. Sign in and keep the session cookie.
   curl -fsS -c cookies.txt -X POST "$BASE/api/auth/login" \
     -H 'content-type: application/json' \
     -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null

   # 2. Register a client for the runner and a PKCE pair. The redirect URI just has to
   #    be a loopback address — nothing needs to be listening on it.
   CLIENT_ID=$(curl -fsS -X POST "$BASE/oauth/register" \
     -H 'content-type: application/json' \
     -d '{"client_name":"agent-jira runner","redirect_uris":["http://127.0.0.1:8945/callback"]}' \
     | jq -r .client_id)
   VERIFIER=$(openssl rand -base64 96 | tr -d '=+/\n' | cut -c1-64)
   CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')

   # 3. Grant consent as yourself. This is the same "Allow" you'd click in the browser —
   #    it creates the agent (named "Host runner" here; revoke it like any other agent
   #    from the Connect agent dialog) and hands back an authorization code.
   CODE=$(curl -fsS -b cookies.txt -X POST "$BASE/oauth/authorize" \
     -H 'content-type: application/json' \
     -d "{\"client_id\":\"$CLIENT_ID\",\"redirect_uri\":\"http://127.0.0.1:8945/callback\",\"response_type\":\"code\",\"code_challenge\":\"$CHALLENGE\",\"code_challenge_method\":\"S256\",\"decision\":\"allow\",\"agent_name\":\"Host runner\"}" \
     | jq -r .redirectTo | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')

   # 4. Exchange the code for a token — this is the one line that prints it.
   curl -fsS -X POST "$BASE/oauth/token" \
     -d "grant_type=authorization_code&code=$CODE&redirect_uri=http://127.0.0.1:8945/callback&client_id=$CLIENT_ID&code_verifier=$VERIFIER" \
     | jq -r .access_token
   ```

   Paste the printed `aj_…` value into `runner.json`'s `"token"` field. Treat it like a
   password: it never needs to be typed again, it isn't recoverable once you lose it
   (only a hash of it is stored), and the fix if it leaks is the same **Revoke** button
   any agent gets.

3. Run it:

   ```bash
   scripts/agent-runner.sh
   ```

   Every `pollSeconds` (default 10) it asks the board for the oldest played story nobody
   is working on — the same play/autonomy rule a connected agent goes through, so if the
   agent the runner's token belongs to is autonomous it will also cold-start on unplayed
   work queued in `To do`. The moment there is one, it runs `claude -p "…"` in that story's
   project directory to pick it up, blocking until that agent session ends before it
   polls again — so *this process* never launches a second agent on top of one still
   working. That guarantee is per-instance only: the poll endpoint is read-only and
   claims nothing, so run at most one runner per account. A failed poll (server down,
   expired token, or a response that doesn't come back as valid JSON) is logged and
   retried with backoff rather than killing the loop; a launch that exits almost
   immediately is treated as a crash rather than finished work and backs off the same
   way, so a broken `claude` invocation can't spin in a restart loop. Leave it running in
   a terminal (or under `tmux`, a `launchd` agent, or a `systemd --user` unit) on
   whatever machine should cold-start agents. `AGENT_JIRA_CONFIG` overrides the config
   path (default `~/.agent-jira/runner.json`); `AGENT_JIRA_LAUNCH_CMD` overrides the
   launch command (default `claude`) — handy for a dry run, e.g.
   `AGENT_JIRA_LAUNCH_CMD=echo scripts/agent-runner.sh` to see the command it would have
   run without starting a real agent.

   The token is passed to `curl` as a header argument, which means it's visible to
   anyone on the same machine who can run `ps` while a poll is in flight — fine on a
   single-user box, worth knowing on a shared one. If that matters for your setup, have
   `curl` read the header from a file instead (`curl -K <(printf 'header = "Authorization: Bearer %s"' "$TOKEN")`
   rather than `-H "Authorization: Bearer $TOKEN"`) — `-K`'s contents never show up in
   `ps`. The `chmod 600` above still matters regardless — it's what keeps the token
   off-limits at rest.

## How the board works

Columns, left to right: **Draft → To do → In progress → In test → Finished → Accepted.**

You write and own the first two states. A story starts in `Draft` — write it, describe
what you want, pick a project and a model — and you drag it to `To do` when it's ready for
an agent to pick up.

From there, a connected agent drives it:

- **To do → In progress**: an agent claims the story and starts work, scoped strictly to
  that story's project directory. `To do` on its own is not an invitation: it is your
  staging column as much as the agents' queue, so a card sitting there is picked up only
  once you press **Play** on it — or, if that agent's **autonomous** switch is on, once it
  goes looking for its next story. A connected agent that has nothing played to do parks
  on the board waiting, without touching anything.
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
safe checkpoint, and the story goes back to `To do` unplayed, so nothing picks it straight
back up. The **autonomous** switch on each agent's pill in the agent strip, along the top
of the board, controls whether that agent claims work on its own — any unblocked story
waiting in `To do` — or only ever the ones you hand it with **Play**.

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

One more thing worth knowing about `SESSION_SECRET` specifically: `docker-compose.yml`'s
`${SESSION_SECRET:?set SESSION_SECRET in .env}` only catches a missing value at the moment
Compose *parses* the file — if your platform injects environment variables straight into
the container instead of through a `.env` Compose reads (some PaaS setups do), that guard
never runs. The real backstop is inside the app itself: `config.ts` refuses to boot in
production with a `SESSION_SECRET` that is missing, too short, or an obvious placeholder
(including the exact value shipped in `.env.example`) — so however your platform passes
environment variables in, the app fails closed rather than starting up insecurely. Set it
in whichever environment your deployment actually parses, and trust the boot-time check to
catch it if you didn't.

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
npm run typecheck    # both tsconfigs (web + server)
npm run check        # typecheck + test — what CI (and you, before committing) should run
npm run build        # what the Docker image runs: vite build + tsc -p tsconfig.server.json
npm start            # runs the build's output — node dist/server/index.js
npm run db:generate  # write a migration for the current schema.ts
npm run db:migrate   # apply pending migrations to DATABASE_PATH (the server also does
                     # this at boot; this is for doing it deliberately, ahead of a deploy)
npm run docker:build # docker compose build
npm run docker:up    # docker compose up -d
npm run smoke        # scripts/smoke-test.sh, against the Compose stack
```

To try the actual container locally without going through Compose:

```bash
docker build -t agent-jira .
docker run --rm -p 3000:3000 \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -v agent-jira-data:/data \
  agent-jira
```

`scripts/smoke-test.sh` (or `npm run smoke`) builds the Compose stack, waits for it to come
up, and exercises health, registration, creating a project and a story, the served SPA, and
the OAuth metadata endpoint — run it after touching anything in the Dockerfile or compose
file.
