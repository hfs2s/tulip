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

# Each proxy before the thing that uses it — egress before the agent, webproxy
# before the browser — the same order compose uses, because a proxy has to be
# listening before its client starts work. An instance without the browser
# profile has no webproxy or browser container and simply skips those two.
# Every instance: the repository's own .env, and each instances/<name>/.env.
# One unit starts them all, so adding an agent never means another boot unit.
ENV_FILES=("$ENV_FILE")
for f in "$REPO"/instances/*/.env; do [ -f "$f" ] && ENV_FILES+=("$f"); done

envval() {
  [ -r "$1" ] || return 0
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" |
    tail -n1 | tr -d "\"'" | sed 's/[[:space:]#].*$//'
}

wait_for() {
  local addr=$1
  case "$addr" in
    '' | 127.0.0.1 | localhost | 0.0.0.0)
      echo "tulip-boot: publish address '${addr:-unset}' needs no wait"
      return 0
      ;;
  esac
  echo "tulip-boot: waiting up to ${WAIT_SECS}s for $addr"
  local deadline=$((SECONDS + WAIT_SECS))
  until ip -4 -o addr show | grep -qF " inet $addr/"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "tulip-boot: $addr never appeared; starting anyway" >&2
      return 0
    fi
    sleep 1
  done
}

rc=0
for env_file in "${ENV_FILES[@]}"; do
  [ -r "$env_file" ] || continue
  project="$(envval "$env_file" TULIP_INSTANCE)"
  project="${project:-tulip}"
  wait_for "$(envval "$env_file" TULIP_PANEL_BIND || true)"
  for c in "$project-egress" "$project-webproxy" "$project-bridge" "$project-agent" "$project-browser"; do
    if ! docker inspect "$c" >/dev/null 2>&1; then
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
done
exit "$rc"
