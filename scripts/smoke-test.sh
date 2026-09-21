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
