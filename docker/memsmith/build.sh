#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${TAG:-memsmith:basic}"

cd "$REPO_ROOT"

echo "[build] npm run build"
npm run build

echo "[build] docker build -t $TAG"
docker build \
  -f docker/memsmith/Dockerfile \
  -t "$TAG" \
  "$REPO_ROOT"

echo "[build] done: $TAG"
