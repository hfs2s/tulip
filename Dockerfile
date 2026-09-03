# Tulip — one Dockerfile, three targets.
#
# Kept as a single file because the three services share a workspace, a lockfile
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
RUN npm ci --no-audit --fund=false

# ─── Compile ──────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY tsconfig.base.json tsconfig.json ./
COPY shared ./shared
COPY bridge ./bridge
COPY agent ./agent
COPY egress ./egress
RUN npx tsc --build --force

# ─── Runtime dependencies only ────────────────────────────────────────────────
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY bridge/package.json ./bridge/
COPY agent/package.json ./agent/
COPY egress/package.json ./egress/
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

# The state and handoff directories are volumes at run time. Creating them here
# with the right owner means the container does not need to be root to fix them
# on first boot.
RUN mkdir -p /state /handoff/in /handoff/out /config \
 && chown -R node:node /state /handoff /config

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
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git ripgrep ca-certificates procps \
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
COPY package.json ./
COPY persona /persona

# `tulip-wa` on PATH is the agent's only way to reach a person.
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
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
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
