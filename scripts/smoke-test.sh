#!/usr/bin/env bash
# scripts/smoke-test.sh — fails until the image builds and boots
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
COOKIES="$(mktemp)"

docker compose up -d --build
trap 'docker compose down -v; rm -f "$COOKIES"' EXIT

for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/api/health" | grep -q '"status":"ok"'; then break; fi
  sleep 2
done
curl -fsS "$BASE_URL/api/health" | grep -q '"status":"ok"'

# The session cookie this returns is what the rest of the run is authenticated by.
curl -fsS -c "$COOKIES" -X POST "$BASE_URL/api/auth/register" \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"hunter22hunter22"}' | grep -q smoke@example.com

# A project, then a story in it: the board is not proven by health and a login alone —
# writing a row through the service layer is what shows the database is really there and
# writable inside the container.
project=$(curl -fsS -b "$COOKIES" -X POST "$BASE_URL/api/projects" \
  -H 'content-type: application/json' \
  -d '{"name":"smoke","path":"/tmp/smoke-project"}')
project_id=$(printf '%s' "$project" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
test -n "$project_id"

curl -fsS -b "$COOKIES" -X POST "$BASE_URL/api/stories" \
  -H 'content-type: application/json' \
  -d "{\"projectId\":\"$project_id\",\"title\":\"Smoke story\"}" | grep -q '"status":"draft"'

curl -fsS -b "$COOKIES" "$BASE_URL/api/board" | grep -q 'Smoke story'

curl -fsS "$BASE_URL/" | grep -qi '<div id="root"'
curl -fsS -o /dev/null -w '%{http_code}' "$BASE_URL/.well-known/oauth-authorization-server" | grep -q 200
echo "smoke test passed"
