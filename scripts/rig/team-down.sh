#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Tear down the throwaway rig. Drops the Docker PG + volume. Prints the team
# server PID for the USER to stop it. Dogfood untouched.
set -euo pipefail
RIG_DATA_DIR="${RIG_DATA_DIR:-/tmp/ms-team-server}"

docker compose down -v || true   # -v drops the throwaway volume
PIDFILE="${RIG_DATA_DIR}/.server-beta.pid"
if [ -f "$PIDFILE" ]; then
  echo "[team-down] team server PID: $(cat "$PIDFILE") — stop it with:  ! kill $(cat "$PIDFILE")"
else
  echo "[team-down] no team-server pid file under ${RIG_DATA_DIR} (already stopped?)"
fi
echo "[team-down] Docker PG + volume dropped. Dogfood was never touched."
