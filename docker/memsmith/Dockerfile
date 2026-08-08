
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
RUN rm -rf /opt/memsmith/node_modules \
 && cd /opt/memsmith \
 && npm install --omit=dev --include=optional --legacy-peer-deps \
 && test -d node_modules/@img/sharp-linux-x64 \
    || (echo "FATAL: sharp linux-x64 binary missing after install" >&2; exit 1)

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
