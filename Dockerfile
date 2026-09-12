# Tulip — one Dockerfile, four targets.
#
# Kept as a single file because the services share a workspace, a lockfile
# and a build, and because a reviewer should be able to read the whole build in
# one place. Every runtime stage runs as uid 1000 and holds no compiler, no
# package manager cache and no source.
#
# Nothing here grants a capability. The privilege dropping that matters —
# read-only root, cap_drop, no-new-privileges, the network topology — lives in
# docker-compose.yml, because that is where it can be seen next to the volume
# mounts it is protecting.

# ─── Base ─────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ─── Dependencies (including dev, for the compiler) ───────────────────────────
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY bridge/package.json ./bridge/
COPY agent/package.json ./agent/
COPY egress/package.json ./egress/
COPY browser/package.json ./browser/
RUN npm ci --no-audit --fund=false

# ─── Compile ──────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY tsconfig.base.json tsconfig.json ./
COPY shared ./shared
COPY bridge ./bridge
COPY agent ./agent
COPY egress ./egress
COPY browser ./browser
COPY scripts ./scripts
RUN npx tsc --build --force
# The panel serves its own fonts and shader bundle rather than pulling them from
# a CDN, which is what lets its CSP stay at 'self' on a page that renders
# message text written by strangers. Vendored here, beside the compiled bridge.
RUN node scripts/build-panel-assets.mjs

# ─── Runtime dependencies only ────────────────────────────────────────────────
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY bridge/package.json ./bridge/
COPY agent/package.json ./agent/
COPY egress/package.json ./egress/
COPY browser/package.json ./browser/
RUN npm ci --omit=dev --no-audit --fund=false

# ─── tulip-bridge ─────────────────────────────────────────────────────────────
# Holds the WhatsApp credentials. Runs no untrusted code and hosts no model, but
# is hardened exactly like the agent: being the trusted side of a boundary is
# not a reason to be the soft one.
FROM base AS bridge
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/bridge/dist ./bridge/dist
COPY shared/package.json ./shared/
COPY bridge/package.json ./bridge/
COPY package.json ./

# The persona, so the panel can show the operator what Tulip has been told to
# be. Read-only reference, never loaded or executed here — the agent's own copy
# is what actually runs. Both images are built from the same tree by one
# `docker compose build`, so they agree; build only one and the panel shows the
# other's brief, which is why the page says which build it is from.
COPY persona /persona

# The state and handoff directories are volumes at run time. Creating them here
# with the right owner means the container does not need to be root to fix them
# on first boot.
# /browse is the browser's handoff (see docker-compose.yml). A fresh named volume
# takes the ownership of the directory it is first mounted over, so the path must
# exist here, owned by node, or the bridge cannot write its first request.
RUN mkdir -p /state /handoff/in /handoff/out /config /browse/req /browse/res \
 && chown -R node:node /state /handoff /config /browse

# Strip every setuid and setgid bit in the image.
#
# `no-new-privileges: true` already means the kernel refuses to honour them, so
# this is belt and braces — but it is the belt that can be *checked*, and
# `scripts/verify-containment.sh` asserts it. The Debian base ships the usual
# set (su, mount, passwd, chsh…), none of which a service account needs. The
# setgid one worth naming is utempter, which tmux uses to write utmp records:
# without it tmux works and simply does not record a login, which is correct
# behaviour for a container nobody logs into.
RUN find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod -s {} + 2>/dev/null || true

USER node
ENV TULIP_STATE_DIR=/state TULIP_IN_DIR=/handoff/in TULIP_OUT_DIR=/handoff/out
CMD ["node", "bridge/dist/index.js"]

# ─── tulip-agent ──────────────────────────────────────────────────────────────
# The untrusted half. It holds nothing but its own workspace, has no route off
# its network, and cannot resolve a name.
FROM base AS agent

# tmux, because the agent is a real terminal session an operator can attach to
# and take over. git and ripgrep because a coding assistant without them is
# annoying. No editor, no compiler, no sudo — there is deliberately no way to
# escalate inside this image.
# poppler-utils and unzip are what let the agent read a document somebody sent
# rather than only see its filename. Both parse hostile input, and this is the
# right container for that: no route out, read-only rootfs, no capabilities,
# non-root. The bridge — which holds the WhatsApp credentials — is where a
# parser with poppler's CVE history would actually be dangerous.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git ripgrep ca-certificates procps \
      poppler-utils unzip \
 && rm -rf /var/lib/apt/lists/*

# Pinned. An agent that silently upgrades itself is an agent whose behaviour
# changed without a commit.
ARG CLAUDE_CODE_VERSION=2.1.259
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/agent/dist ./agent/dist
COPY shared/package.json ./shared/
COPY agent/package.json ./agent/
# Read by every chat session through `--mcp-config`. On the read-only rootfs,
# so the agent cannot rewrite which server it is given.
COPY agent/mcp.json ./agent/
COPY package.json ./
COPY persona /persona

# `tulip-wa` on PATH is the agent's only way to reach a person. The `tulip` MCP
# server reaches it the same way — it runs this CLI for every tool call.
RUN printf '#!/bin/sh\nexec node /app/agent/dist/wa-cli.js "$@"\n' > /usr/local/bin/tulip-wa \
 && chmod 755 /usr/local/bin/tulip-wa \
 && mkdir -p /workspace /handoff/in /handoff/out \
 && chown -R node:node /workspace /handoff

# Strip every setuid and setgid bit in the image.
#
# `no-new-privileges: true` already means the kernel refuses to honour them, so
# this is belt and braces — but it is the belt that can be *checked*, and
# `scripts/verify-containment.sh` asserts it. The Debian base ships the usual
# set (su, mount, passwd, chsh…), none of which a service account needs. The
# setgid one worth naming is utempter, which tmux uses to write utmp records:
# without it tmux works and simply does not record a login, which is correct
# behaviour for a container nobody logs into.
RUN find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod -s {} + 2>/dev/null || true

USER node
# HOME is the workspace volume: Claude Code writes its config and transcripts
# under it, and the root filesystem is read-only at run time.
ENV HOME=/workspace \
    CLAUDE_CONFIG_DIR=/workspace/.claude \
    TULIP_WORKSPACE=/workspace \
    TULIP_PERSONA=/persona \
    TULIP_IN_DIR=/handoff/in \
    TULIP_OUT_DIR=/handoff/out \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    MCP_TOOL_TIMEOUT=160000
# MCP_TOOL_TIMEOUT sits above the server's own 150s limit, which sits above the
# slowest verb: `page-image` waits up to 120s on the bridge. A client that gave
# up first would report a failure for a picture that was still being made.
CMD ["node", "agent/dist/supervisor.js"]

# ─── tulip-egress ─────────────────────────────────────────────────────────────
# No dependencies at all: the proxy is plain Node. Nothing to audit but its own
# two hundred lines.
FROM base AS egress
COPY --from=builder /app/egress/dist ./egress/dist

# Strip every setuid and setgid bit in the image.
#
# `no-new-privileges: true` already means the kernel refuses to honour them, so
# this is belt and braces — but it is the belt that can be *checked*, and
# `scripts/verify-containment.sh` asserts it. The Debian base ships the usual
# set (su, mount, passwd, chsh…), none of which a service account needs. The
# setgid one worth naming is utempter, which tmux uses to write utmp records:
# without it tmux works and simply does not record a login, which is correct
# behaviour for a container nobody logs into.
RUN find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod -s {} + 2>/dev/null || true

USER node
CMD ["node", "egress/dist/index.js"]

# ─── tulip-browser ────────────────────────────────────────────────────────────
# The second untrusted container: headless Chromium, one page at a time, behind
# tulip-webproxy. Debian's `chromium` package, because it is built for arm64 —
# which the Pi needs and Google's own builds are not — and because bookworm's
# security updates are where Chromium's fixes arrive. Rebuild this image to take
# them; a browser that faces the open internet is the one image here where
# staleness is itself the vulnerability.
#
# `--no-install-recommends` keeps out chromium-sandbox, the setuid helper. The
# container runs Chromium with --no-sandbox (see browser/src/chromium.ts) and
# wants no setuid anything; the strip below would remove the bit regardless.
# Fonts, so a screenshot shows letters rather than boxes.
FROM base AS browser
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Only what the browser loop imports: zod and the compiled shared contract, laid
# out as real directories rather than the workspace's symlinks. Not the
# workspace's node_modules — this image renders hostile pages, and every package
# it does not contain is one an exploit cannot go looking through.
COPY --from=prod-deps /app/node_modules/zod ./node_modules/zod
COPY --from=builder /app/shared/dist ./node_modules/@tulip/shared/dist
COPY shared/package.json ./node_modules/@tulip/shared/package.json
COPY --from=builder /app/browser/dist ./browser/dist
COPY browser/package.json ./browser/

# Owned by node for the same reason as the bridge's: a fresh named volume takes
# the ownership of the directory it is first mounted over.
RUN mkdir -p /browse/req /browse/res && chown -R node:node /browse

# Strip every setuid and setgid bit in the image. See the bridge stage; it is
# asserted by `scripts/verify-containment.sh` here too.
RUN find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod -s {} + 2>/dev/null || true

USER node
# HOME and TMPDIR on the tmpfs: the root filesystem is read-only at run time,
# and every Chromium profile is made — and deleted — under /tmp. The binary is
# named directly rather than through Debian's /usr/bin/chromium wrapper, which
# sources flag files from /etc that this program would rather not inherit.
ENV HOME=/tmp \
    TMPDIR=/tmp \
    TULIP_BROWSE_REQ_DIR=/browse/req \
    TULIP_BROWSE_RES_DIR=/browse/res \
    TULIP_BROWSER_BIN=/usr/lib/chromium/chromium
CMD ["node", "browser/dist/index.js"]
