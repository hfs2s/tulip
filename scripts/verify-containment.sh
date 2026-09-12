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

# Talking to the Docker daemon needs either membership of the `docker` group or
# root, and a Raspberry Pi set up by following the official install notes often
# has neither for the login account. That is not an exotic configuration, and
# what it produced here was actively misleading: every `docker` call failed with
# "permission denied", the container check below read that as absence, and the
# script reported the agent was not running while it was answering people.
#
# So resolve the command once, and keep the two failures distinct — "I cannot
# reach Docker" is a different problem from "the container is not there", and
# only one of them means the threat model is unverified.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    DOCKER="sudo docker"
  fi
fi
if ! $DOCKER info >/dev/null 2>&1; then
  echo "$(basename "$0"): cannot reach the Docker daemon (tried 'docker' and 'sudo docker')." >&2
  echo "  Containment is UNVERIFIED. That is not a pass — fix access and run it again." >&2
  exit 2
fi


AGENT=${TULIP_AGENT_CONTAINER:-tulip-agent}
BRIDGE=${TULIP_BRIDGE_CONTAINER:-tulip-bridge}
EGRESS=${TULIP_EGRESS_CONTAINER:-tulip-egress}
WEBPROXY=${TULIP_WEBPROXY_CONTAINER:-tulip-webproxy}
BROWSER=${TULIP_BROWSER_CONTAINER:-tulip-browser}
# Fixed in docker-compose.yml, like the agent's proxy address.
EGRESS_IP=172.31.240.10
WEBPROXY_IP=${TULIP_WEBPROXY_IP:-172.31.250.10}

pass=0
fail=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

# `check_in <container> <description> <expectation> <command…>`, where the
# expectation is `fails` or `succeeds`. `check` is the same, against the agent.
check_in() {
  local container=$1 description=$2 expectation=$3
  shift 3
  local output status
  output=$($DOCKER exec "$container" sh -lc "$*" 2>&1)
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

check() { check_in "$AGENT" "$@"; }

note_pass() { printf '  %s %s\n' "$(green '✓')" "$1"; pass=$((pass + 1)); }
note_fail() { printf '  %s %s\n' "$(red '✗')" "$1"; fail=$((fail + 1)); }

# Properties Docker enforces, read from Docker rather than tested from inside.
inspect_hardening() {
  local container=$1
  if [ "$($DOCKER inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ]; then
    note_pass "$container root filesystem is read-only"
  else
    note_fail "$container root filesystem is writable"
  fi
  if $DOCKER inspect -f '{{.HostConfig.CapDrop}}' "$container" | grep -qi all; then
    note_pass "$container drops all capabilities"
  else
    note_fail "$container does not drop all capabilities"
  fi
}

# The names of the networks a container is on, space-separated.
networks_of() {
  $DOCKER inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$1" 2>/dev/null
}

# `connect_via <proxy address> <authority>` prints a command, for check_in, that
# exits 0 only when the proxy answers the CONNECT with a 200.
connect_via() {
  printf '%s' "timeout 15 node -e \"
    const net=require('node:net');
    const s=net.connect(3128,'$1',()=>s.write('CONNECT $2 HTTP/1.1\\r\\nHost: $2\\r\\n\\r\\n'));
    s.on('data',d=>{ process.exit(/ 200 /.test(d.toString())?0:1); });
    s.on('error',()=>process.exit(1)); s.setTimeout(12000,()=>process.exit(1));\""
}

# `tcp_to <address> <port>` prints a command that exits 0 only if a direct TCP
# connection succeeds.
tcp_to() {
  printf '%s' "timeout 5 node -e \"require('node:net').connect({host:'$1',port:$2}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(4000,()=>process.exit(1))\""
}

if ! $DOCKER inspect "$AGENT" >/dev/null 2>&1; then
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

# The browser's proxy allows any public host. The agent must not be able to
# reach it, or its own allowlist would be decoration.
check "the browser's proxy is unreachable from the agent" fails \
  "$(tcp_to "$WEBPROXY_IP" 3128)"

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
check "there are no setuid or setgid binaries" succeeds \
  "test -z \"\$(find / -xdev -type f \\( -perm -4000 -o -perm -2000 \\) 2>/dev/null | head -1)\""
# cap_drop: [ALL] — this is the capability that would let it re-mount things.
check "CAP_SYS_ADMIN is not held" fails \
  "grep -q 'CapEff:\\s*0000000000200000' /proc/self/status"

echo
echo "Bridge — hardened too, being the side that holds the credentials"
if $DOCKER inspect "$BRIDGE" >/dev/null 2>&1; then
  if [ "$($DOCKER inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$BRIDGE")" = true ]; then
    printf '  %s bridge root filesystem is read-only\n' "$(green '✓')"; pass=$((pass + 1))
  else
    printf '  %s bridge root filesystem is writable\n' "$(red '✗')"; fail=$((fail + 1))
  fi
  if $DOCKER inspect -f '{{.HostConfig.CapDrop}}' "$BRIDGE" | grep -qi all; then
    printf '  %s bridge drops all capabilities\n' "$(green '✓')"; pass=$((pass + 1))
  else
    printf '  %s bridge does not drop all capabilities\n' "$(red '✗')"; fail=$((fail + 1))
  fi
else
  printf '  ! %s is not running; skipped\n' "$BRIDGE"
fi

echo
echo "Proxies — hardened like everything else"
for proxy in "$EGRESS" "$WEBPROXY"; do
  if $DOCKER inspect "$proxy" >/dev/null 2>&1; then
    inspect_hardening "$proxy"
  else
    printf '  ! %s is not running; skipped\n' "$proxy"
  fi
done

echo
echo "Browser — renders hostile pages, so contained like the agent"
if $DOCKER inspect "$BROWSER" >/dev/null 2>&1; then
  inspect_hardening "$BROWSER"

  browser_nets=$(networks_of "$BROWSER")
  if printf ' %s ' "$browser_nets" | grep -qE ' [^ ]*_(lan|wan) '; then
    note_fail "browser is on lan or wan: $browser_nets"
  else
    note_pass "browser is on neither lan nor wan (${browser_nets% })"
  fi
  # The bridge's panel listens on 0.0.0.0 inside its container; a network the
  # two shared would put it within reach of a page's JavaScript.
  bridge_nets=$(networks_of "$BRIDGE")
  shared=""
  for n in $browser_nets; do
    case " $bridge_nets " in *" $n "*) shared="$shared $n" ;; esac
  done
  if [ -z "$shared" ]; then
    note_pass "browser and bridge share no network"
  else
    note_fail "browser and bridge share a network:$shared"
  fi

  check_in "$BROWSER" "has no default route" succeeds \
    "node -e \"const r=require('node:fs').readFileSync('/proc/net/route','utf8').split('\\n').slice(1);process.exit(r.some(l=>l.split(/\\s+/)[1]==='00000000')?1:0)\""
  check_in "$BROWSER" "DNS resolution of an external name fails" fails \
    "getent hosts example.com"
  check_in "$BROWSER" "a direct connection to a public address fails" fails \
    "$(tcp_to 1.1.1.1 443)"
  check_in "$BROWSER" "a direct connection to the bridge's network fails" fails \
    "$(tcp_to 172.17.0.1 8791)"
  check_in "$BROWSER" "a direct connection to the agent's proxy fails" fails \
    "$(tcp_to "$EGRESS_IP" 3128)"
  check_in "$BROWSER" "the process is not uid 0" succeeds \
    "test \"\$(id -u)\" -ne 0"
  check_in "$BROWSER" "no capabilities are held" succeeds \
    "grep -q 'CapEff:[[:space:]]*0000000000000000' /proc/self/status"
  check_in "$BROWSER" "the root filesystem is read-only" fails \
    "touch /root-write-test 2>/dev/null"
  check_in "$BROWSER" "the request volume is read-only" fails \
    "touch /browse/req/tamper 2>/dev/null"
  check_in "$BROWSER" "there are no setuid or setgid binaries" succeeds \
    "test -z \"\$(find / -xdev -type f \\( -perm -4000 -o -perm -2000 \\) 2>/dev/null | head -1)\""

  echo
  echo "Web proxy — any public host, and nothing else"
  check_in "$BROWSER" "CONNECT to a public site on 443 succeeds" succeeds \
    "$(connect_via "$WEBPROXY_IP" example.com:443)"
  check_in "$BROWSER" "CONNECT to a port other than 443 is refused" fails \
    "$(connect_via "$WEBPROXY_IP" example.com:22)"
  check_in "$BROWSER" "CONNECT to a loopback address is refused" fails \
    "$(connect_via "$WEBPROXY_IP" 127.0.0.1:443)"
  check_in "$BROWSER" "CONNECT to the cloud metadata address is refused" fails \
    "$(connect_via "$WEBPROXY_IP" 169.254.169.254:443)"
  # A public name whose A record is 127.0.0.1. This is the check that exercises
  # the address filter itself rather than the hostname parser; if the name ever
  # stops resolving, it still fails, which is the right direction to be wrong in.
  check_in "$BROWSER" "CONNECT to a public name that resolves to loopback is refused" fails \
    "$(connect_via "$WEBPROXY_IP" localtest.me:443)"
else
  printf '  ! %s is not running; skipped (fetch falls back to the search provider)\n' "$BROWSER"
fi

echo
if [ $fail -eq 0 ]; then
  printf '%s %d checks passed.\n\n' "$(green '✓')" "$pass"
  exit 0
fi
printf '%s %d of %d checks FAILED — the threat model does not currently hold.\n\n' \
  "$(red '✗')" "$fail" "$((pass + fail))"
exit 1
