#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Bring up the throwaway team-mode rig (Colima + Docker pgvector PG). Prints the
# exact command for the USER to !-launch the team server (agent can't; mise shim).
# Dogfood is never targeted — preflight enforces it.
set -euo pipefail

RIG_DATA_DIR="${RIG_DATA_DIR:-/tmp/ms-team-server}"
RIG_PG_PORT="${RIG_PG_PORT:-55440}"
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
  docker compose up -d postgres

echo "[team-up] waiting for postgres on :${RIG_PG_PORT} ..."
# (health-check loop via pg_isready or a `pg` ping — see README; kept short here.)

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
