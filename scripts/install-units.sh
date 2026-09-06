#!/usr/bin/env bash
# Install the two systemd units that carry Tulip across a reboot.
#
# The units are templates rather than finished files, and that is deliberate:
# systemd will not expand a variable inside `ExecStart`, so the checkout's path
# has to be baked in at install time. They shipped with one developer's home
# directory in them for a while, which works exactly once — on that machine.
#
# Run from anywhere; the path is taken from where this script actually lives, so
# there is nothing to type and nothing to get wrong.
#
#   sudo scripts/install-units.sh
#
# What gets installed:
#   tulip-boot  — starts the stack once the address it publishes on exists.
#                 `restart: unless-stopped` does NOT cover this: Docker restarts
#                 a container that exited, and one whose port bind failed never
#                 started. See scripts/tulip-boot.sh.
#   tulip-ttyd  — the operator terminal, ttyd on a UNIX socket. Optional: without
#                 it the panel's Terminal page answers 503 and says why.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-units: needs root to write /etc/systemd/system — re-run with sudo." >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR=/etc/systemd/system
UNITS=(tulip-boot tulip-ttyd)

# Only the checkout path is templated. The `1000` in the ttyd unit is NOT a host
# uid and must not be substituted — it is the uid the *bridge container* runs as,
# and it is what has to own the socket for the panel to connect.
echo "install-units: checkout at $DIR"

for unit in "${UNITS[@]}"; do
  src="$DIR/scripts/$unit.service"
  if [ ! -f "$src" ]; then
    echo "  ! $unit.service is missing from the checkout; skipping" >&2
    continue
  fi
  sed -e "s|@@TULIP_DIR@@|$DIR|g" "$src" > "$UNIT_DIR/$unit.service"
  # A placeholder that survives is a unit that will fail at boot rather than now,
  # which is the worst time to find out.
  if grep -q '@@' "$UNIT_DIR/$unit.service"; then
    echo "  ! $unit.service still holds an unfilled placeholder — not enabling it" >&2
    grep -n '@@' "$UNIT_DIR/$unit.service" >&2
    exit 1
  fi
  echo "  installed $unit.service"
done

systemctl daemon-reload
for unit in "${UNITS[@]}"; do
  [ -f "$UNIT_DIR/$unit.service" ] || continue
  systemctl enable "$unit" >/dev/null 2>&1 && echo "  enabled $unit"
done

echo
echo "Start them now with:  sudo systemctl start ${UNITS[*]}"
echo "Check with:           systemctl status ${UNITS[*]}"
