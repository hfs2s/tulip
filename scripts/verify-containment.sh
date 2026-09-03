#!/usr/bin/env bash
#
# Assert, against the running deployment, that the agent container is actually
# contained.
#
# Controls that are not tested are claims. Everything checked here is something
# docs/THREAT-MODEL.md asserts, and every one of them is a property of the
# environment rather than of the code — which means it can be silently undone by
# a Docker upgrade, an edit to docker-compose.yml, or a well-meaning `--network`
# flag. Run it after any of those.
#
# Exit code 0 means every assertion held.

set -uo pipefail

AGENT=${TULIP_AGENT_CONTAINER:-tulip-agent}
BRIDGE=${TULIP_BRIDGE_CONTAINER:-tulip-bridge}

pass=0
fail=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

# `check <description> <expectation>` where expectation is `fails` or `succeeds`
check() {
  local description=$1 expectation=$2
  shift 2
  local output status
  output=$(docker exec "$AGENT" sh -lc "$*" 2>&1)
  status=$?

  local ok=1
  if [ "$expectation" = fails ] && [ $status -eq 0 ]; then ok=0; fi
  if [ "$expectation" = succeeds ] && [ $status -ne 0 ]; then ok=0; fi

  if [ $ok -eq 1 ]; then
    printf '  %s %s\n' "$(green '✓')" "$description"
    pass=$((pass + 1))
  else
    printf '  %s %s\n' "$(red '✗')" "$description"
    printf '      expected the command to %s; it exited %d\n' "$expectation" "$status"
    printf '      %s\n' "$(printf '%s' "$output" | head -3 | tr '\n' ' ')"
    fail=$((fail + 1))
  fi
}

if ! docker inspect "$AGENT" >/dev/null 2>&1; then
  echo "containment check: $AGENT is not running. Start it with 'docker compose up -d'." >&2
  exit 2
fi

echo
echo "Containment checks against $AGENT"
echo

echo "Network — the agent must not be able to reach anything by itself"
# Name resolution is pointed at 127.0.0.1, where nothing listens. Without this,
# an HTTP-proxy-only jail still leaks through DNS tunnelling.
check "DNS resolution of an external name fails" fails \
  "getent hosts example.com"
# internal:true means the kernel has no route to install, so this is refused
# before a packet leaves.
check "a direct connection to a public address fails" fails \
  "timeout 5 node -e \"require('node:net').connect({host:'1.1.1.1',port:443}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(4000,()=>process.exit(1))\""
check "a direct connection to the bridge's network fails" fails \
  "timeout 5 node -e \"require('node:net').connect({host:'172.17.0.1',port:8791}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(4000,()=>process.exit(1))\""

echo
echo "Proxy — the one permitted path out, and only it"
check "CONNECT to a host that is not allowlisted is refused" fails \
  "timeout 10 node -e \"
    const net=require('node:net');
    const s=net.connect(3128,'172.31.240.10',()=>s.write('CONNECT evil.example.com:443 HTTP/1.1\r\nHost: evil.example.com:443\r\n\r\n'));
    s.on('data',d=>{ process.exit(/200/.test(d.toString())?0:1); });
    s.on('error',()=>process.exit(1)); s.setTimeout(8000,()=>process.exit(1));\""
check "CONNECT to the allowlisted API succeeds" succeeds \
  "timeout 15 node -e \"
    const net=require('node:net');
    const s=net.connect(3128,'172.31.240.10',()=>s.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'));
    s.on('data',d=>{ process.exit(/200/.test(d.toString())?0:1); });
    s.on('error',()=>process.exit(1)); s.setTimeout(12000,()=>process.exit(1));\""

echo
echo "Credentials — the agent must hold nothing worth stealing"
check "the WhatsApp session directory is not present" fails \
  "test -e /state/session"
check "the bridge's state volume is not mounted" fails \
  "test -d /state"
check "the chat key map is unreachable" fails \
  "test -e /state/chats.json"
# The inbound volume is the agent's only view of a conversation, and it is
# read-only: it cannot forge a batch or rewrite the current-turn pointer.
check "the inbound handoff volume is read-only" fails \
  "touch /handoff/in/tamper 2>/dev/null"

echo
echo "Privilege — no way up from inside"
check "the process is not uid 0" succeeds \
  "test \"\$(id -u)\" -ne 0"
check "the root filesystem is read-only" fails \
  "touch /root-write-test 2>/dev/null"
check "/usr is not writable" fails \
  "touch /usr/local/bin/tamper 2>/dev/null"
check "sudo is not installed" fails \
  "command -v sudo"
check "there are no setuid binaries" succeeds \
  "test -z \"\$(find / -xdev -perm -4000 -type f 2>/dev/null | head -1)\""
# cap_drop: [ALL] — this is the capability that would let it re-mount things.
check "CAP_SYS_ADMIN is not held" fails \
  "grep -q 'CapEff:\\s*0000000000200000' /proc/self/status"

echo
echo "Bridge — hardened too, being the side that holds the credentials"
if docker inspect "$BRIDGE" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$BRIDGE")" = true ]; then
    printf '  %s bridge root filesystem is read-only\n' "$(green '✓')"; pass=$((pass + 1))
  else
    printf '  %s bridge root filesystem is writable\n' "$(red '✗')"; fail=$((fail + 1))
  fi
  if docker inspect -f '{{.HostConfig.CapDrop}}' "$BRIDGE" | grep -qi all; then
    printf '  %s bridge drops all capabilities\n' "$(green '✓')"; pass=$((pass + 1))
  else
    printf '  %s bridge does not drop all capabilities\n' "$(red '✗')"; fail=$((fail + 1))
  fi
else
  printf '  ! %s is not running; skipped\n' "$BRIDGE"
fi

echo
if [ $fail -eq 0 ]; then
  printf '%s %d checks passed.\n\n' "$(green '✓')" "$pass"
  exit 0
fi
printf '%s %d of %d checks FAILED — the threat model does not currently hold.\n\n' \
  "$(red '✗')" "$fail" "$((pass + fail))"
exit 1
