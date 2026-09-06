#!/usr/bin/env bash
# Bring the stack up after a reboot, once the address it publishes on exists.
#
# WHY THIS EXISTS, when every service already carries `restart: unless-stopped`
# and docker.service is enabled. That policy is not the thing it sounds like.
# Docker restarts a container that has *exited*; a container whose port bind
# failed has never started, so there is no exit to react to. It is left sitting
# in `created` and nothing touches it again — not when the address appears, not
# ever. Verified on the box: a container that lost this race was still `created`
# with `startedAt=0001-01-01` long after the address it wanted came up.
#
# The race is reachable here because the panel is published on the *tailnet*
# address (TULIP_PANEL_BIND), which tailscaled assigns some seconds into the
# boot. Docker restores containers as soon as the daemon is up, and nothing
# orders those two. Lose the race and the bind fails with EADDRNOTAVAIL.
#
# What makes that worth a unit rather than a shrug is which container it is.
# tulip-bridge holds the WhatsApp connection, so this does not degrade to "the
# panel is down" — it degrades to Juan silently never coming back, with two
# healthy containers either side of him and nothing in `docker ps` looking
# obviously wrong.
#
# So: wait for the address, then start the containers. `docker start` on a
# running container is a successful no-op, which is what makes this safe to run
# on every boot, twice, or by hand while everything is already up.
set -euo pipefail

REPO="${TULIP_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="${TULIP_ENV:-$REPO/.env}"
WAIT_SECS="${TULIP_BOOT_WAIT:-120}"

# egress first, then the bridge, then the agent — the same order compose uses,
# because the agent's proxy has to be listening before it starts a turn.
CONTAINERS=(tulip-egress tulip-bridge tulip-agent)

# Read the publish address from .env rather than hardcoding it, so this cannot
# drift from what Docker will actually try to bind.
publish_address() {
  [ -r "$ENV_FILE" ] || return 0
  sed -n 's/^[[:space:]]*TULIP_PANEL_BIND[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" |
    tail -n1 | tr -d "\"'" | sed 's/[[:space:]#].*$//'
}

ADDR="$(publish_address || true)"

case "$ADDR" in
  '' | 127.0.0.1 | localhost | 0.0.0.0)
    # Nothing to wait for: these exist before the network does.
    echo "tulip-boot: publish address '${ADDR:-unset}' needs no wait"
    ;;
  *)
    echo "tulip-boot: waiting up to ${WAIT_SECS}s for $ADDR"
    deadline=$((SECONDS + WAIT_SECS))
    until ip -4 -o addr show | grep -qF " inet $ADDR/"; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        # Start anyway. If the address really is gone the start fails and this
        # unit goes red, which is a better outcome than declining to try.
        echo "tulip-boot: $ADDR never appeared; starting anyway" >&2
        break
      fi
      sleep 1
    done
    ;;
esac

rc=0
for c in "${CONTAINERS[@]}"; do
  if ! docker inspect "$c" >/dev/null 2>&1; then
    # A box where the stack was never created is not a failure, it is a box
    # waiting for `docker compose up -d`.
    echo "tulip-boot: $c does not exist; skipping" >&2
    continue
  fi
  if docker start "$c" >/dev/null 2>&1; then
    echo "tulip-boot: $c is $(docker inspect -f '{{.State.Status}}' "$c")"
  else
    echo "tulip-boot: $c failed to start" >&2
    rc=1
  fi
done
exit "$rc"
