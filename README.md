# Tulip

**A public-facing WhatsApp assistant backed by a real Claude Code session, built
so that fully compromising the agent buys an attacker nothing.**

Tulip is a hardened descendant of [Iris](#relationship-to-iris), a private
WhatsApp→Claude Code bridge. Iris answers six allow-listed people. Tulip answers
*anyone*, which changes the security problem completely: every inbound message is
untrusted input to a process holding a shell, so the containment has to be the
product, not a wrapper around it.

The design premise is a single sentence:

> Assume a stranger's message achieves arbitrary code execution inside the agent.
> Nothing they can reach from there is worth having.

Everything below is in service of making that sentence true.

---

## The problem

A WhatsApp→Claude Code bridge runs an agent with `--dangerously-skip-permissions`
— full Bash, full filesystem, full network — and feeds it text written by other
people. That is fine when "other people" is a handful of friends. It stops being
fine the moment the allowlist opens, because prompt injection stops being a
curiosity and becomes remote code execution with a delivery mechanism anyone can
use for free.

Run naively on a home server, one hostile message reaches:

| Asset | Why it is exposed | What it costs you |
|---|---|---|
| Host credentials (`~/.env`) | agent runs as a normal user with a normal HOME | every API key on the machine |
| WhatsApp auth store | the bridge and the agent share a filesystem | account takeover — the attacker *becomes* the bot |
| `sudo` | most home-server accounts have it, passwordless | root |
| Private network / VPN | the host is on it | lateral movement to everything else you own |
| Unrestricted egress | nothing stops outbound connections | silent exfiltration of all of the above |
| Other people's conversations | one agent session serves every chat | every user's messages leak to every other user |

Tulip closes each of these structurally — at the kernel and the filesystem, not
in the prompt. A persona that asks an agent nicely not to leak things is not a
security control; it is a hope.

---

## Architecture

Three containers, two of which hold nothing worth stealing, connected by two
one-directional volumes and no shared network at all.

```
                      ┌──────────────────────────────────────────┐
   WhatsApp  ◄──────► │  tulip-bridge                            │
                      │                                          │
                      │  Baileys socket · router · gate ·        │
                      │  rate limits · outbox sender · panel     │
                      │                                          │
                      │  HOLDS: WhatsApp credentials             │
                      │  RUNS:  no untrusted code, no LLM        │
                      │  NET:   tulip-wan (internet)             │
                      └───────┬──────────────────────────▲───────┘
                              │                          │
                writes        │                          │  reads + deletes
                              ▼                          │
                  ╔═══════════════════╗      ╔═══════════════════╗
                  ║   volume: in      ║      ║   volume: out     ║
                  ║   bridge:  rw     ║      ║   bridge:  rw     ║
                  ║   agent:   RO     ║      ║   agent:   rw     ║
                  ╚═════════╤═════════╝      ╚═════════▲═════════╝
                            │                          │
                       reads│                          │writes
                            ▼                          │
                      ┌─────┴──────────────────────────┴───────┐
                      │  tulip-agent                            │
                      │                                         │
                      │  tmux · claude --dangerously-skip-…     │
                      │  one Claude session PER CHAT            │
                      │                                         │
                      │  HOLDS: nothing but its own workspace   │
                      │  RUNS:  untrusted input, by design      │
                      │  NET:   tulip-lan (internal: no route)  │
                      │  DNS:   127.0.0.1 — fails closed        │
                      └────────────────────┬────────────────────┘
                                           │ HTTPS_PROXY, pinned IP
                                           ▼
                      ┌─────────────────────────────────────────┐
                      │  tulip-egress                           │
                      │  CONNECT proxy, deny-by-default          │
                      │  allowlist: api.anthropic.com            │
                      │  NET: tulip-lan + tulip-wan              │
                      └─────────────────────────────────────────┘
```

**The bridge and the agent share no network.** They communicate only by writing
files into two Docker volumes with opposite permissions. There is no RPC, no
Docker socket, no `docker exec` from one into the other, and no port either can
dial on the other. The entire interface between the trusted half and the
untrusted half is "one process writes a JSON file, the other reads it".

### The seven controls

Each is enforced by the kernel or the filesystem. None depends on the agent
behaving.

1. **Credential isolation.** The WhatsApp auth store is mounted only in the
   bridge. The agent container has no path to it, so no amount of code execution
   inside the agent yields the WhatsApp account. This is the single biggest
   improvement over the design Tulip is forked from.

2. **No route out.** `tulip-lan` is declared `internal: true`, so the agent's
   network namespace has no default route. Packets to the internet are dropped by
   the kernel, not by a policy the agent could talk its way around.

3. **DNS fails closed.** The agent's resolver is `127.0.0.1`, where nothing
   listens. Every external name lookup fails instantly. This closes DNS
   tunnelling, which is the usual way out of an HTTP-proxy-only jail. The one
   name the agent needs — the egress proxy — is pinned in `/etc/hosts` at a
   static IP.

4. **Deny-by-default egress proxy.** The only reachable peer is a ~200-line
   CONNECT proxy that allows exactly the hosts in its allowlist and logs every
   decision. Compromising the agent does not compromise the proxy: they are
   separate containers, and the proxy parses nothing but a hostname.

5. **The agent cannot choose who it talks to.** Outbound actions name a
   *turn*, never a destination. The bridge — the only writer of that mapping —
   resolves turn → chat itself. An injected agent physically cannot address a
   message to a chat other than the one it is answering. See
   [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#t4).

6. **One Claude session per chat.** Chat isolation is structural, not
   prompt-level: stranger A's messages are never in the context window that
   answers stranger B, because they are different sessions with different
   derived UUIDs. Iris shares one session across every chat and relies on the
   persona for discretion; for a public bot that is not good enough.

7. **Least-privilege container.** Non-root (uid 1000), `read_only` root
   filesystem, `no-new-privileges`, **all** capabilities dropped, tmpfs `/tmp`,
   and pids/memory/CPU limits. There is no `sudo`, no package manager at
   runtime, and no writable path outside the two volumes and `/tmp`.

The residual risks these do *not* close — and why — are written down honestly in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md#residual-risks). A threat model
that claims to close everything is a threat model nobody checked.

---

## Repository layout

| Path | What it is |
|---|---|
| `bridge/` | The trusted half. WhatsApp socket, gate, rate limits, outbox, panel. |
| `agent/` | The untrusted half. Session pool, tmux driver, the `tulip-wa` CLI, hooks. |
| `egress/` | The deny-by-default CONNECT proxy. |
| `shared/` | Types and schemas describing the handoff contract, used by both halves. |
| `persona/` | Tulip's identity, assembled into the agent's `CLAUDE.md`. No personal data. |
| `docs/` | Threat model, architecture notes, operations runbook. |
| `scripts/` | Docker installation, pairing, health checks. |

---

## Quickstart

Requires Docker with the Compose plugin. `scripts/install-docker.sh` sets that up
on Debian/Raspberry Pi OS.

```bash
git clone https://github.com/hfs2s/tulip.git
cd tulip

cp .env.example .env                 # add ANTHROPIC_API_KEY
mkdir -p config && cp config.example.json config/config.json   # add your operator number

scripts/preflight.sh                 # host prerequisites and configuration
docker compose build
docker compose up -d
scripts/verify-containment.sh        # 17 assertions against the running containers

docker compose logs -f bridge        # a QR code appears on first run
```

`preflight.sh` checks what the host must provide and the compose file merely
asks for — Docker discards a resource limit it cannot enforce with one warning
line, so a cap can be absent for months while the configuration still claims it.
`verify-containment.sh` checks the running containers: no route out, no DNS, no
credentials, read-only root, no path to privilege. **Both should pass before the
number is given to anyone.**

Scan the QR with the WhatsApp account Tulip will *be* — a number of its own, not
a personal one. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for pairing,
the control panel, upgrades, and what to do when something breaks.

> **One number, one auth store.** Two Baileys clients on the same credentials
> kick each other off in a loop and can log the device out. Never point Tulip at
> a number another bridge is already using.

---

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit, strict, across all three services
npm test              # vitest
npm run check:secrets # fails if a gitignored secret file is staged
```

TypeScript throughout, `strict` with `noUncheckedIndexedAccess`. Every value
crossing a trust boundary — WhatsApp messages, agent outbox actions, config
files, HTTP requests — is parsed with Zod at the boundary and is a typed value
afterwards. There is no `any` in the trust-relevant path.

---

## Relationship to Iris

Tulip is a fork of a private bridge called Iris, which remains in service for a
small allow-listed group. Tulip keeps Iris's good ideas:

- WhatsApp as pure transport; the intelligence is an ordinary Claude Code session
  you can attach to and take over.
- Derived session UUIDs, so context survives a killed container with no state to
  back up.
- Record every message *before* gating, because a silently dropped message is
  indistinguishable from one that never arrived.
- The pane is the authority on whether a turn is running — hooks are a courtesy
  that can stop firing.

And changes what a public audience makes untenable:

| | Iris | Tulip |
|---|---|---|
| Audience | six allow-listed numbers | an allow list that can be opened to anyone |
| Deployment | one process on the host | three containers, disjoint networks |
| WhatsApp credentials | same filesystem as the agent | unreachable from the agent |
| Egress | unrestricted | deny-by-default proxy, no route, no DNS |
| Chat isolation | one shared session, persona-level | one session per chat, structural |
| Host privileges | user account with passwordless sudo | uid 1000, all caps dropped, read-only root |
| Abuse controls | none needed | per-sender token buckets, turn budgets, size caps |
| Language | JavaScript | TypeScript strict, Zod at every boundary |
| Terminal | ttyd proxied over a socket | a file exchange over the handoff volumes — no network between the halves |
| Paid capabilities | keys in the agent's reach | performed by the bridge; no key enters the agent |

Iris's bespoke business integrations — a morning-accountability bridge, a
ticketing integration — are deliberately **not** carried over.

Its paid capabilities *are*, but rebuilt rather than copied. Image generation,
speech, web search and GIFs all run in the **bridge**: the agent names what it
wants and the trusted side produces it, so no billed credential enters the
container the threat model assumes an attacker owns, and the agent's egress
allowlist gains no host. The original objection — that a paid per-message
feature reachable by strangers is a cost-denial-of-service — is answered by
bounding them, not by omitting them: each spends the same per-turn and per-chat
allowance as an ordinary reply, and each has an operator switch independent of
whether a key is configured.

## Licence

MIT. See [`LICENSE`](LICENSE).
