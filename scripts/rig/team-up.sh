#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Bring up the throwaway team-mode rig (Colima + Docker pgvector PG). Prints the
# exact command for the USER to !-launch the team server (agent can't; mise shim).
# Dogfood is never targeted — preflight enforces it.
set -euo pipefail

RIG_DATA_DIR="${RIG_DATA_DIR:-/tmp/ms-team-server}"
RIG_PG_PORT="${RIG_PG_PORT:-55440}"
export RIG_PG_PORT
RIG_HTTP_PORT="${RIG_HTTP_PORT:-38890}"
RIG_PG_USER="${RIG_PG_USER:-memsmith}"
RIG_PG_PASSWORD="${RIG_PG_PASSWORD:-rig-throwaway}"
RIG_PG_DB="${RIG_PG_DB:-memsmith}"
RIG_DB_URL="postgres://${RIG_PG_USER}:${RIG_PG_PASSWORD}@127.0.0.1:${RIG_PG_PORT}/${RIG_PG_DB}"

# Hard preflight — refuse if this would touch the dogfood.
node "$(dirname "$0")/preflight.mjs" --data-dir "$RIG_DATA_DIR" --db-url "$RIG_DB_URL" --http-port "$RIG_HTTP_PORT"

# Colima up (idempotent).
if ! colima status >/dev/null 2>&1; then colima start; fi

# Bring up ONLY the pgvector postgres service on the throwaway port.
POSTGRES_USER="$RIG_PG_USER" POSTGRES_PASSWORD="$RIG_PG_PASSWORD" POSTGRES_DB="$RIG_PG_DB" \
  docker compose -f docker-compose.yml -f docker-compose.rig.yml up -d postgres

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
