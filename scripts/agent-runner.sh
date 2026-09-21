#!/usr/bin/env bash
# scripts/agent-runner.sh — cold-starts a Claude Code agent when a story is played.
#
# The board's play button and the MCP wait_for_work long-poll both assume an agent is
# already running and parked waiting for work. If nothing is running at all, a played
# story just sits in `todo` forever. This script runs on the developer's machine
# (outside the container): it polls GET /api/runner/queued for the oldest played,
# unblocked, unclaimed story and launches `claude` in the right project directory to
# pick it up. See README.md's "Host runner" section for setup.
set -euo pipefail

CONFIG="${AGENT_JIRA_CONFIG:-$HOME/.agent-jira/runner.json}"
# Override to stub the launch when testing this script, e.g. AGENT_JIRA_LAUNCH_CMD=echo.
LAUNCH_CMD="${AGENT_JIRA_LAUNCH_CMD:-claude}"

# Ceiling for the poll-failure backoff (server down, network blip, expired token).
MAX_BACKOFF_SECONDS=300
# A launched agent that exits before this many seconds have passed is treated as a
# crash, not a finished task — a real agent session takes minutes, not seconds — and
# trips the same backoff, so a broken launch command can't spin in a tight restart loop.
MIN_HEALTHY_RUN_SECONDS=15

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "agent-runner: missing required command '$1' — install it and try again." >&2
    exit 1
  }
}
require_cmd jq
require_cmd curl
require_cmd "$LAUNCH_CMD"

[ -f "$CONFIG" ] || {
  echo "agent-runner: missing config: $CONFIG (see scripts/runner.example.json)" >&2
  exit 1
}

BASE_URL=$(jq -r '.baseUrl // empty' "$CONFIG")
TOKEN=$(jq -r '.token // empty' "$CONFIG")
INTERVAL=$(jq -r '.pollSeconds // 10' "$CONFIG")

if [ -z "$BASE_URL" ] || [ -z "$TOKEN" ]; then
  echo "agent-runner: $CONFIG must set both \"baseUrl\" and \"token\" (see scripts/runner.example.json)" >&2
  exit 1
fi
# From here on, $TOKEN is a live credential with the same power as a connected agent.
# It is only ever placed in the Authorization header below — never echoed, logged, or
# put anywhere a `ps` from another user on the same box could read it.

log "agent-jira runner watching $BASE_URL every ${INTERVAL}s"

poll_failures=0
backoff_until=0

while true; do
  now=$(date +%s)
  if [ "$now" -lt "$backoff_until" ]; then
    sleep "$INTERVAL"
    continue
  fi

  # A failed poll (server down, expired/revoked token, network blip) must not kill the
  # loop: log it and back off, rather than a tight retry or a hard exit.
  if ! RESP=$(curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/runner/queued"); then
    poll_failures=$((poll_failures + 1))
    backoff=$((INTERVAL * poll_failures))
    [ "$backoff" -gt "$MAX_BACKOFF_SECONDS" ] && backoff=$MAX_BACKOFF_SECONDS
    log "poll failed (attempt $poll_failures) — is the server up and the token still valid? retrying in ${backoff}s"
    sleep "$backoff"
    continue
  fi
  poll_failures=0

  STORY_ID=$(printf '%s' "$RESP" | jq -r '.story.id // empty')

  if [ -n "$STORY_ID" ]; then
    DIR=$(printf '%s' "$RESP" | jq -r '.story.projectPath')
    TITLE=$(printf '%s' "$RESP" | jq -r '.story.title')
    log "launching agent for: $TITLE ($STORY_ID) in $DIR"

    # Runs synchronously — the loop does not poll again until the agent exits, so this
    # process never launches a second agent on top of one still working. The server
    # itself also stops offering a story the moment it's claimed, so even a second
    # runner instance polling the same account can't double-launch it.
    START=$(date +%s)
    if (cd "$DIR" && "$LAUNCH_CMD" -p "Connect to the agent-jira MCP server, claim story $STORY_ID, and implement it following the server's instructions exactly."); then
      log "agent for $STORY_ID finished"
    else
      log "agent for $STORY_ID exited with an error"
    fi
    ELAPSED=$(($(date +%s) - START))

    if [ "$ELAPSED" -lt "$MIN_HEALTHY_RUN_SECONDS" ]; then
      backoff_until=$(($(date +%s) + MAX_BACKOFF_SECONDS))
      log "that run lasted only ${ELAPSED}s, which looks like a crash rather than real work — pausing ${MAX_BACKOFF_SECONDS}s before trying again"
    fi
  fi

  sleep "$INTERVAL"
done
