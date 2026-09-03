#!/usr/bin/env bash
#
# Host checks, before Tulip is pointed at the public.
#
# These are things the compose file asks for and the *host* has to be able to
# provide. Docker discards a limit it cannot enforce with a one-line warning
# that scrolls past during a build, so a resource cap can be absent for months
# while the configuration file still says it is there. That is the failure mode
# this script exists to catch.
#
# Exit 0: safe to proceed. Exit 1: something is wrong. Exit 2: warnings only.

set -uo pipefail

fail=0
warn=0

green() { printf '\033[32m%s\033[0m' "$1"; }
amber() { printf '\033[33m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

ok()      { printf '  %s %s\n' "$(green '✓')" "$1"; }
warning() { printf '  %s %s\n' "$(amber '!')" "$1"; warn=$((warn + 1)); }
bad()     { printf '  %s %s\n' "$(red '✗')" "$1"; fail=$((fail + 1)); }

cd "$(dirname "$0")/.." || exit 1

echo
echo "Host prerequisites"
echo

# ── Docker ────────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
else
  bad "docker is not installed — run scripts/install-docker.sh"
fi

if docker compose version >/dev/null 2>&1; then
  ok "compose plugin $(docker compose version --short 2>/dev/null)"
else
  bad "the docker compose plugin is missing; Tulip's containment is expressed in docker-compose.yml"
fi

# ── cgroup controllers ────────────────────────────────────────────────────────
# The one that actually bites on a Raspberry Pi. Raspberry Pi OS ships with the
# memory controller disabled, so `mem_limit` is discarded and a runaway agent
# can take the whole host down.
CONTROLLERS=$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo "")
for controller in memory pids cpu; do
  if printf '%s' "$CONTROLLERS" | grep -qw "$controller"; then
    ok "cgroup controller: $controller"
  elif [ "$controller" = memory ]; then
    warning "cgroup controller 'memory' is NOT available — every mem_limit is silently discarded"
    printf '      On Raspberry Pi OS, append to /boot/firmware/cmdline.txt (one line, no newline):\n'
    printf '        cgroup_enable=memory cgroup_memory=1\n'
    printf '      then reboot. Until then the agent has no memory ceiling and can exhaust the host.\n'
  else
    warning "cgroup controller '$controller' is not available; the matching limit is discarded"
  fi
done

# ── Configuration ─────────────────────────────────────────────────────────────
echo
echo "Configuration"
echo

if [ -f .env ]; then
  # shellcheck disable=SC1091
  KEY=$(grep -E '^ANTHROPIC_API_KEY=' .env | cut -d= -f2- | tr -d '"'"'"' ')
  if [ -z "${KEY:-}" ]; then
    bad ".env has no ANTHROPIC_API_KEY"
  elif [ "${KEY#sk-ant-}" = "$KEY" ] || printf '%s' "$KEY" | grep -qi 'placeholder\|replace-me'; then
    warning "ANTHROPIC_API_KEY looks like a placeholder — the agent cannot answer anyone yet"
  else
    ok "ANTHROPIC_API_KEY is set"
  fi

  PERMS=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null)
  if [ "$PERMS" = "600" ]; then ok ".env is mode 600"; else warning ".env is mode $PERMS; 600 is better"; fi
else
  bad ".env is missing — copy .env.example"
fi

if [ -f config.json ]; then
  ok "config.json exists"

  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import json, sys
try:
    c = json.load(open("config.json"))
except Exception as e:
    print(f"  \033[31m✗\033[0m config.json is not valid JSON: {e}")
    sys.exit(0)

def ok(m):   print(f"  \033[32m✓\033[0m {m}")
def warn(m): print(f"  \033[33m!\033[0m {m}")

ops = c.get("operators", {}).get("numbers", [])
if ops:
    ok(f"{len(ops)} operator number(s) configured")
else:
    warn("no operator numbers: no control commands, and no watchdog alerts when something breaks")

panel = c.get("panel", {})
host = panel.get("host", "127.0.0.1")
if host in ("127.0.0.1", "localhost"):
    ok("panel is bound to loopback")
else:
    warn(f"panel is bound to {host} — it is a bearer-token surface that can read every message. "
         "Tunnel over SSH instead, or put something that authenticates in front of it.")

if c.get("audience", {}).get("everyone"):
    ok("audience: everyone (this is the public configuration)")
else:
    ok("audience: restricted to the numbers list")
PY
  fi
else
  bad "config.json is missing — copy config.example.json"
fi

# ── Repository hygiene ────────────────────────────────────────────────────────
echo
echo "Repository"
echo
if git -C . rev-parse >/dev/null 2>&1; then
  if git ls-files --error-unmatch .env config.json >/dev/null 2>&1; then
    bad "a secret-bearing file is tracked by git — run 'npm run check:secrets'"
  else
    ok "no secret-bearing file is tracked"
  fi
fi

echo
if [ $fail -gt 0 ]; then
  printf '%s %d problem(s) and %d warning(s). Fix the problems before starting.\n\n' "$(red '✗')" "$fail" "$warn"
  exit 1
fi
if [ $warn -gt 0 ]; then
  printf '%s %d warning(s). Tulip will run; read them before opening the audience.\n\n' "$(amber '!')" "$warn"
  exit 2
fi
printf '%s ready.\n\n' "$(green '✓')"
exit 0
