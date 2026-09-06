#!/usr/bin/env bash
# A real terminal into the agent, without giving the agent a way back.
#
# The panel used to ship pane bytes over a file and re-render them. That is a
# reconstruction of a terminal: always a beat behind, and never quite the state
# the agent is in. This is the terminal — ttyd allocates a pty and `docker exec`
# attaches it to the agent's tmux session.
#
# WHY THIS RUNS ON THE HOST AND NOT IN THE AGENT IMAGE. The agent container is
# the one the threat model assumes an attacker owns. Putting a shell server
# inside it and letting the bridge dial in would need a network path between the
# two, and the absence of that path is the single property the whole topology
# exists to protect. Here nothing is added to that container at all: the flow is
# bridge -> host -> `docker exec`, and the agent cannot initiate any of it.
#
# WHY A UNIX SOCKET AND NEVER A PORT. What is behind this is an interactive
# shell in a container running with permissions bypassed. A loopback port is
# reachable by anything else on the box; a socket in a 0700 directory is not.
# The directory carries the permission because ttyd creates the socket
# world-writable and has no mode flag of its own.
#
# The socket is bind-mounted into the bridge, which proxies it behind the same
# token check as the rest of the panel.
set -euo pipefail

CONTAINER="${TULIP_AGENT_CONTAINER:-tulip-agent}"
SESSION="${TULIP_TMUX_SESSION:-tulip}"
SOCKET_DIR="${TULIP_TTYD_DIR:-/run/tulip}"
SOCKET="${SOCKET_DIR}/ttyd.sock"
# The bridge runs as uid 1000; it must be able to connect, and nothing else
# should be able to.
OWNER_UID="${TULIP_TTYD_UID:-1000}"

mkdir -p "$SOCKET_DIR"
chown "$OWNER_UID":"$OWNER_UID" "$SOCKET_DIR"
chmod 700 "$SOCKET_DIR"
rm -f "$SOCKET"

# Read-only, deliberately. This pane is for *reading* the session when something
# has gone wrong — a stack trace, a wedged turn, what the agent actually ran. It
# is not where an operator talks to a conversation any more; the Chat page is,
# and it types one reviewed line through `sendToChat` rather than handing
# somebody a raw keyboard pointed at a stranger's chat.
#
# `--writable` is on, which is a deliberate reversal and worth recording rather
# than quietly flipping. It was dropped on the reasoning above: a keystroke here
# goes into a live tmux session carrying every open conversation, with no
# confirmation and no record of who typed it, and a mistyped one lands in
# whichever chat happens to be focused. All of that is still true.
#
# It is on because a read-only terminal is not the thing this was asked to be.
# Iris and the council wall are both writable, and it is what makes their
# controls work at all — paste has nothing to paste into otherwise, and
# scrollback needs copy-mode, which needs a keystroke. A pane an operator can
# only watch is a log with extra steps.
#
# What bounds it is that reaching this needs the panel's token, and Cloudflare
# Access in front of that; the operator is a named person by the time they are
# looking at it. The care is now a human one rather than a mechanical one, which
# is a real trade and the one that was chosen.
#
# `mouse on` is set by the agent, so the wheel scrolls the pane into copy-mode
# the way it does everywhere else — that only works because input reaches tmux.
exec ttyd \
  --interface "$SOCKET" \
  --ping-interval 30 \
  --client-option 'fontSize=13' \
  --client-option 'theme={"background":"#0d0d0f","foreground":"#fafafa","cursor":"#21d2ed"}' \
  --writable \
  --client-option 'enableClipboard=true' \
  docker exec -it "$CONTAINER" tmux new-session -A -s "$SESSION"
