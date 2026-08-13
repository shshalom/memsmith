#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Bring up the throwaway team-mode rig (Colima + a single pgvector container via
# `docker run`). Prints the exact command for the USER to !-launch the team server
# (agent can't; mise shim). Dogfood is never targeted — preflight enforces it.
#
# NOTE: uses raw `docker run` (not `docker compose`) — this environment's Docker
# ships no Compose v2 plugin, and a single throwaway PG container needs no Compose.
set -euo pipefail

RIG_DATA_DIR="${RIG_DATA_DIR:-/tmp/ms-team-server}"
RIG_PG_PORT="${RIG_PG_PORT:-55440}"
export RIG_PG_PORT
RIG_HTTP_PORT="${RIG_HTTP_PORT:-38890}"
RIG_PG_USER="${RIG_PG_USER:-memsmith}"
RIG_PG_PASSWORD="${RIG_PG_PASSWORD:-rig-throwaway}"
RIG_PG_DB="${RIG_PG_DB:-memsmith}"
RIG_PG_CONTAINER="${RIG_PG_CONTAINER:-ms-team-pg}"
RIG_PG_IMAGE="${RIG_PG_IMAGE:-pgvector/pgvector:pg17}"
RIG_DB_URL="postgres://${RIG_PG_USER}:${RIG_PG_PASSWORD}@127.0.0.1:${RIG_PG_PORT}/${RIG_PG_DB}"

# Hard preflight — refuse if this would touch the dogfood.
#
# --credentials-path is checked explicitly because it used to be the one piece of
# state MEMSMITH_DATA_DIR could not move: CredentialStore hardcoded homedir(), so
# a rig pointed at /tmp still wrote the developer's real credentials.json, and a
# clobbered key silently stops capture for a live project. CredentialStore now
# derives from the data dir; passing the derived path here asserts that rather
# than trusting it.
RIG_CREDENTIALS_PATH="${RIG_DATA_DIR%/}/credentials.json"
node "$(dirname "$0")/preflight.mjs" --data-dir "$RIG_DATA_DIR" --db-url "$RIG_DB_URL" --http-port "$RIG_HTTP_PORT" --credentials-path "$RIG_CREDENTIALS_PATH"

# Colima up (idempotent).
if ! colima status >/dev/null 2>&1; then colima start; fi

# Bring up ONLY a single throwaway pgvector container on the throwaway port.
# Idempotent: remove any prior container of the same name first (throwaway data).
docker rm -f "$RIG_PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$RIG_PG_CONTAINER" \
  -e POSTGRES_USER="$RIG_PG_USER" \
  -e POSTGRES_PASSWORD="$RIG_PG_PASSWORD" \
  -e POSTGRES_DB="$RIG_PG_DB" \
  -p "127.0.0.1:${RIG_PG_PORT}:5432" \
  "$RIG_PG_IMAGE" >/dev/null

echo "[team-up] waiting for postgres on :${RIG_PG_PORT} ..."
_pg_ready=0
for _i in $(seq 1 30); do
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h 127.0.0.1 -p "${RIG_PG_PORT}" -U "${RIG_PG_USER}" -q && _pg_ready=1 && break
  else
    node -e "
      const net = require('net');
      const s = net.createConnection(${RIG_PG_PORT}, '127.0.0.1');
      s.on('connect', () => { s.destroy(); process.exit(0); });
      s.on('error', () => { s.destroy(); process.exit(1); });
    " 2>/dev/null && _pg_ready=1 && break
  fi
  sleep 1
done
if [ "${_pg_ready}" -eq 0 ]; then
  echo "[team-up] WARNING: postgres did not become ready within 30s — proceeding anyway." >&2
fi

cat <<EOF

[team-up] Docker pgvector PG is up on :${RIG_PG_PORT} (throwaway).
Next — YOU (!-launch, the agent can't due to the mise shim) start the team server:

  ! MEMSMITH_RUNTIME=server \
    MEMSMITH_SERVER_DATABASE_URL="${RIG_DB_URL}" \
    MEMSMITH_IDENTITY_PROVIDER=better-auth \
    MEMSMITH_QUEUE_ENGINE=inline \
    MEMSMITH_DATA_DIR="${RIG_DATA_DIR}" \
    MEMSMITH_SERVER_PORT=${RIG_HTTP_PORT} \
    npx memsmith server start

Dogfood untouched: still local on :38879 / :55433 / ~/.memsmith.
EOF
