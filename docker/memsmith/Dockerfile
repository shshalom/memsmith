
FROM node:20

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      unzip \
      jq \
      less \
      procps \
      uuid-runtime \
      sqlite3 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.12
ENV BUN_INSTALL="/usr/local/bun"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && chmod -R a+rX /usr/local/bun
ENV PATH="/usr/local/bun/bin:${PATH}"

ARG UV_VERSION=0.11.7
ENV UV_INSTALL_DIR="/usr/local/bin"
RUN set -eux \
 && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
 && { chmod a+rX /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null || true; }

RUN mkdir -p /usr/local/share/npm-global \
 && chown -R node:node /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH="/usr/local/share/npm-global/bin:${PATH}"

# Registry override for building inside a corporate network that blocks
# registry.npmjs.org. Autodesk's VPN does exactly that (measured: HTTP 000),
# which otherwise forces a VPN-off/VPN-on flip mid-build. The Artifactory
# mirror is reachable ON VPN and serves manifests AND tarballs, including the
# native tree-sitter packages:
#   --build-arg NPM_REGISTRY=https://npm.autodesk.com/artifactory/api/npm/npm-remote
#
# Set as NPM_CONFIG_REGISTRY (not a per-command --registry flag) so it applies
# to EVERY npm invocation below. A per-command flag was tried first and missed
# the `npm install -g @anthropic-ai/claude-code` step, which then failed with
# ETIMEDOUT after 8 minutes.
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}

ARG CLAUDE_CODE_VERSION=latest
USER node
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

USER root
COPY plugin/ /opt/memsmith/
RUN chown -R node:node /opt/memsmith

USER node
# DELETE any node_modules that came in with the COPY before installing.
#
# The root .dockerignore lists `node_modules/`, but that pattern does NOT match
# the nested `plugin/node_modules/`, so the host's tree was being copied into
# the image. npm then saw every dependency satisfied and installed NOTHING,
# leaving macOS-arm64 artefacts in a linux-amd64 image. Measured: the image
# contained @img/sharp-darwin-arm64 (dated from the host, not the build) and no
# linux binary, so the server crashed on boot with
#   error: Could not load the "sharp" module using the linux-x64 runtime
# (sharp is an optional native dep of @huggingface/transformers, the embedder).
#
# tree-sitter happens to be immune — it ships prebuilds for every platform in
# one package — which is why the failure surfaced only via sharp.
#
# --include=optional is explicit because sharp's platform binaries are OPTIONAL
# deps; omitting them is exactly how a "successful" install yields a broken
# image. Registry comes from NPM_CONFIG_REGISTRY, set above.
# NOTE: the prune below runs in THIS SAME `RUN`, not a later one. A Docker layer
# is a diff — deleting a file in a subsequent layer records a whitebout marker
# and the bytes STAY in the earlier layer, so the image does not shrink. Measured
# exactly that way first: node_modules went 1220 MB -> 406 MB inside the
# container while `docker image inspect` still reported 1.61 GB for both tags.
# Install and prune must therefore be one layer.
#
# Prune targets are what a LINUX SERVER container can never execute or never loads.
#
# Measured on memsmith:v3 (1.61 GB image, 1.54 GB node_modules layer): ~650 MB
# of it is dead weight, which is why a push over a ~10 Mbps VPN link took ~20
# minutes. Two categories, both verified before removal rather than assumed:
#
# 1. onnxruntime-node's NON-LINUX binaries. `du` inside the image:
#      linux 354 MB | win32 124 MB | darwin 35 MB
#    The win32/darwin blobs cannot run in a linux/amd64 container. The LINUX
#    directory is LOAD-BEARING — it is the engine behind
#    @huggingface/transformers, which the embedder imports (embedder.ts:4) to
#    run all-MiniLM-L6-v2 locally. Deleting that would give a container that
#    boots fine and then fails on the first embed, so the guard below asserts
#    the linux binary survives.
#
# 2. tree-sitter grammars (~500 MB across ~15 packages: swift 96 MB, scala 53,
#    cpp 50, haskell 47, …). These power smart_search / smart_outline, which
#    are CLIENT-side code parsing. Verified absent from the server path:
#      grep -c tree-sitter plugin/scripts/server-service.cjs  -> 0
#      grep -rn tree-sitter src/server/                       -> no matches
#    and the entrypoint only ever runs `server`, `worker`, or `shell` — never
#    the MCP server, which is the real tree-sitter consumer.
#
# onnxruntime-web (130 MB) is the browser build of the same runtime; the Node
# server uses onnxruntime-node, never the WASM one.
#
# CAVEAT, deliberately accepted: MEMSMITH_CONTAINER_MODE=shell drops to a bash
# prompt for ad-hoc tooling. Anything run there that wants tree-sitter will now
# fail. That is the right trade for a server image — reinstall in the shell if
# ever needed.
# DROP the tree-sitter grammars from package.json BEFORE installing, rather than
# installing and deleting them.
#
# Two reasons, both measured:
#  - SIZE: 24 grammar packages are hard `dependencies` (~500 MB installed:
#    swift 96 MB, scala 53, cpp 50, haskell 47, …). Installing then deleting
#    leaves the bytes in the layer anyway (a layer is a diff).
#  - BUILD FAILURE: with the host node_modules correctly excluded from the build
#    context, npm actually COMPILES them — and tree-sitter-kotlin's
#    `node-gyp-build` SEGFAULTS (exit 139) under linux/amd64 emulation on an
#    arm64 host. The old build only "worked" because the copied-in macOS tree
#    made npm think everything was already satisfied.
#
# Safe for a SERVER image, verified rather than assumed:
#   grep -c tree-sitter plugin/scripts/server-service.cjs  -> 0
#   grep -rn tree-sitter src/server/                       -> no matches
# The grammars back smart_search / smart_outline, which are CLIENT-side code
# parsing run by the MCP server. The entrypoint only ever runs `server`,
# `worker`, or `shell` — never the MCP server.
RUN cd /opt/memsmith \
 && node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));let n=0;for(const s of ['dependencies','optionalDependencies']){if(!j[s])continue;for(const k of Object.keys(j[s])){if(k.includes('tree-sitter')){delete j[s][k];n++;}}}fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('dropped '+n+' tree-sitter deps for the server image');"

# Install with the host tree absent (see .dockerignore's **/node_modules/ note).
# The rm -rf stays as a belt-and-braces guard: if the ignore rule ever regresses,
# a stale macOS-arm64 tree would otherwise make npm a no-op and ship a broken
# image (that exact failure happened once — "Could not load the sharp module
# using the linux-x64 runtime").
#
# --include=optional is explicit because sharp's platform binaries are OPTIONAL
# deps; omitting them is how a "successful" install yields a broken image.
#
# The prune runs in THIS SAME RUN: a Docker layer is a diff, so deleting in a
# later layer records a whiteout and the bytes stay. Measured exactly that way —
# node_modules 1220 MB -> 406 MB inside the container while the image size stayed
# at 1.61 GB for both tags.
RUN rm -rf /opt/memsmith/node_modules \
 && cd /opt/memsmith \
 && npm install --omit=dev --include=optional --legacy-peer-deps \
 && cd /opt/memsmith/node_modules \
 && rm -rf onnxruntime-node/bin/napi-v6/win32 \
           onnxruntime-node/bin/napi-v6/darwin \
           onnxruntime-web \
 && test -d onnxruntime-node/bin/napi-v6/linux \
    || (echo "FATAL: onnxruntime linux binary missing — the embedder would fail at runtime" >&2; exit 1) \
 && test -d @img/sharp-linux-x64 \
    || (echo "FATAL: sharp linux-x64 binary missing after install" >&2; exit 1) \
 && echo "post-prune node_modules size:" && du -sh /opt/memsmith/node_modules

USER root
RUN mkdir -p /home/node/.claude /home/node/.memsmith /data/memsmith \
 && chown -R node:node /home/node/.claude /home/node/.memsmith /data/memsmith

COPY --chown=node:node docker/memsmith/entrypoint.sh /usr/local/bin/memsmith-entrypoint
RUN chmod +x /usr/local/bin/memsmith-entrypoint

USER node
WORKDIR /home/node

# Phase 10 — server-beta runtime is the only foregrounded process. The legacy
# worker binaries remain available for tooling but are NEVER spawned by the
# entrypoint. Mode selection happens via MEMSMITH_CONTAINER_MODE
# (server | worker | shell). `docker run ... bash` works because shell mode
# falls through to "$@".
ENV MEMSMITH_CONTAINER_MODE=server
ENV MEMSMITH_RUNTIME=server-beta

ENTRYPOINT ["/usr/local/bin/memsmith-entrypoint"]
CMD []
