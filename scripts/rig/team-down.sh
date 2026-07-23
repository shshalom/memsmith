#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Tear down the throwaway rig. Removes the throwaway pgvector container (and its
# anonymous data — no named volume is used). Prints the team server PID for the
# USER to stop it. Dogfood untouched.
set -euo pipefail
RIG_DATA_DIR="${RIG_DATA_DIR:-/tmp/ms-team-server}"
RIG_PG_CONTAINER="${RIG_PG_CONTAINER:-ms-team-pg}"

# -f removes the running container + its anonymous volume (throwaway data).
docker rm -f "$RIG_PG_CONTAINER" >/dev/null 2>&1 || true
PIDFILE="${RIG_DATA_DIR}/.server-beta.pid"
if [ -f "$PIDFILE" ]; then
  PID=$(node -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid))}catch{process.exit(1)}" "$PIDFILE" 2>/dev/null) || true
  if [ -n "${PID:-}" ]; then
    echo "[team-down] team server PID: ${PID} — stop it with:  ! kill ${PID}"
  else
    echo "[team-down] team server pid file present but could not parse PID — raw: $(cat "$PIDFILE") — stop manually with:  ! kill <pid>"
  fi
else
  echo "[team-down] no team-server pid file under ${RIG_DATA_DIR} (already stopped?)"
fi
echo "[team-down] throwaway pgvector container '${RIG_PG_CONTAINER}' removed. Dogfood was never touched."
