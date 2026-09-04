# Operating Tulip

Everything an operator needs after the first `docker compose up`. Read
[`THREAT-MODEL.md`](THREAT-MODEL.md) first if you are deciding whether to run
this at all.

---

## First run

```bash
cp .env.example .env                 # ANTHROPIC_API_KEY — use a dedicated, capped key
mkdir -p config && cp config.example.json config/config.json   # your operator number
docker compose build
docker compose up -d
```

Then pair the number:

```bash
docker compose logs -f bridge
```

A QR code appears. Scan it from the phone that owns the number Tulip will *be* —
WhatsApp → Settings → Linked devices → Link a device.

> **One number, one auth store.** Two Baileys clients on the same credentials
> kick each other off in a loop and can log the device out, forcing a re-scan.
> Never point a second bridge, a "quick test", or a restored backup at a number
> that is already paired. The bridge takes a pidfile lock to make the common
> case impossible, but the lock cannot see another machine.

Pairing survives restarts and rebuilds — the credentials live in the `state`
volume, not in the image. You only scan again if you unlink the device or delete
that volume.

### Before anyone messages it

```bash
scripts/preflight.sh            # host prerequisites and configuration
scripts/verify-containment.sh   # 17 assertions against the running containers
```

No route out, no DNS, no credentials, read-only root, no privilege escalation.
Both must pass. If containment does not, the threat model does not currently
hold — and that matters whether the audience is a short allow list or the whole
internet, because an injection needs a borrowed phone or a forwarded document,
not a hostile sender.

---

## Day to day

### From WhatsApp

Any number in `operators.numbers` can send:

| Command | Effect |
|---|---|
| `!status` | bridge, agent and queue state |
| `!hold` | stop handing messages to the agent; they keep arriving and queueing |
| `!release` | hand over everything held |
| `!chats` | recent chats, with their keys |
| `!block <key>` | stop answering a chat |
| `!unblock <key>` | answer it again |
| `!reset <key>` | abandon that chat's context; its next message starts fresh |
| `!help` | the list |

These are handled entirely inside the bridge, before the gate and before the
agent sees anything. That is the point: you need them *because* something is
wrong with the agent, so routing them through it would make them useless exactly
when they matter.

### The control panel

Eight pages: overview, messages, chats, media, tools, terminal, settings, log.

Where it lives depends on `TULIP_PANEL_BIND`. Published on loopback, reach it
over a tunnel:

```bash
ssh -N -L 8791:127.0.0.1:8791 you@the-host
docker compose exec bridge cat /state/panel-token   # the token
```

The reference deployment publishes it on the host's private interface instead
and puts a hostname in front, behind Cloudflare Access with an emailed sign-in
code. Two independent gates: Access decides *who*, the token decides *what
holds a session*.

**Settings is editable, and that is a deliberate reversal.** The panel used to
write no configuration at all, which removed the class of "the panel was
reachable and someone opened the allowlist". It was traded for a console whose
controls work. What backs it instead is that every change is loud — old and new
values into the structured log, and a distinct feed entry when the audience is
opened. `panel.*` stays uneditable, because a surface that can widen its own
exposure is a different kind of mistake.

Treat panel access as full access. Anyone who can sign in can read every
message, hold delivery, type into a live conversation, and change who the bot
answers. There is no read-only role.

### Watching the agent work

The agent is a real Claude Code session in tmux, and you can take it over
mid-conversation exactly as with Iris:

```bash
docker compose exec agent tmux ls                      # one window per live chat
docker compose exec agent tmux capture-pane -p -t tulip:c-<chatKey>   # look, safely
docker compose exec -it agent tmux attach -t tulip     # attach; ctrl-b d to leave
```

Attached, anything you type goes straight into a live conversation. Prefer
`capture-pane` unless you mean to intervene.

The panel's **Terminal** page does the same thing without a shell on the host.
It is not a PTY: Iris proxies ttyd over a socket, and Tulip cannot, because the
bridge and the agent share no network and Docker will not publish a port into an
`internal` one. Proxying a shell through the bridge would hand the agent a route
to the container holding the WhatsApp credentials, which is the single thing the
topology exists to prevent. So the page exchanges files over the volumes that
already carry everything else — a captured pane out, keystrokes in — and offers
a readable view that strips the TUI chrome, plus the raw capture when you want
it.

---

## Changing things

| You change | To apply |
|---|---|
| Settings, in the panel | nothing — applied immediately and written to `config.json` |
| `config/config.json` by hand | `docker compose restart bridge` |
| `.env` | `docker compose up -d` (recreates the containers) |
| `persona/` | `docker compose build agent && docker compose up -d agent` — each chat's `CLAUDE.md` is regenerated when its session next starts |
| any TypeScript | `docker compose build && docker compose up -d` |
| `docker-compose.yml` | `docker compose up -d`, then **re-run `verify-containment.sh`** |

A persona edit reaches a conversation when that conversation's session next
spawns, not immediately — a resident session keeps the file it started with.
`!reset <key>` forces the issue for one chat; restarting the agent container
does it for all of them without losing any context.

### Letting somebody in

Two separate lists, for two separate surfaces, and it is easy to change the
wrong one.

A third list, `agent.contacts` (Settings → Reach), is neither of these: it is
who the agent may message *first*. It grants nothing inbound, so somebody added
there cannot reply until their number is also in `audience.numbers` — the panel
now marks a contact that cannot reply, and the separation is the point rather
than an oversight. See THREAT-MODEL §T4.

**To let somebody message the bot** — Settings → Audience, or `config.json`:

- Add their number to `audience.numbers` (bare international digits).
- If their messages are still refused, WhatsApp is delivering them as a linked
  id with no number attached. Open the Log page, find the `gate.deny` line for
  their attempt, and copy the identifier it recorded into `audience.jids`. This
  is the common case on modern clients, and it is why the refusal records every
  identifier the gate actually saw — so allowing someone is a copy, not a guess.
- Operators are a separate list and are never widened by "open to anyone".

**To let somebody into the control panel** — this is Cloudflare Access, not
Tulip. The panel's own token is a bearer credential shared by whoever holds it;
Access is what identifies a person. Add their address to the allow policy on the
`tulip (raspberry pi)` application in the Cloudflare Zero Trust dashboard, under
Access → Applications. The application is pinned to the One-time PIN identity
provider, so they will sign in with a code emailed to that address and nothing
else.

Adding a panel user gives them everything: reading every message, holding
delivery, and changing the audience. There is no read-only role.

### Adding a host to the egress allowlist

Every entry is a channel out of the jail. Prefer an exact hostname to a
wildcard, add one only with a reason, and record the reason:

```bash
# .env
TULIP_EGRESS_ALLOW=api.anthropic.com,example.com
docker compose up -d egress
```

Then re-run the containment check, and update the threat model if the reachable
surface has meaningfully changed.

---

## When something is wrong

**Start here.** The failures below look alike from outside — someone messages
Tulip and nothing happens — and they have entirely different causes.

```bash
docker compose ps                        # is everything up?
docker compose logs --tail=50 bridge     # did the message arrive at all?
docker compose logs --tail=50 agent      # did a turn start?
docker compose logs --tail=20 egress     # was something refused?
```

### "I messaged it and nothing happened"

The feed records **every** inbound message before any gating decision, precisely
so this question is answerable. Look at the panel, or:

```bash
docker compose exec bridge tail -5 /state/feed.jsonl
```

- **Not in the feed at all** → it never arrived. Check `wa.open` in the bridge
  log; the socket may be reconnecting, or the device may have been unlinked.
- **In the feed with `accepted: false`** → the gate or a limit refused it, and
  `reason` says which. Refusals are silent by design: replying would confirm to
  an unknown sender that the number is live. If the reason is "sender is not on
  the allow list" for somebody who should be, read the `gate.deny` line in the
  Log: WhatsApp is probably delivering them as a linked id, and the identifier
  to copy is right there.
- **In the feed, accepted, no `delivered`** → delivery is held (`!release`), or
  a turn is in flight ahead of it.
- **Delivered but no reply** → the agent's problem. Read its pane.

### Nobody is being answered

`delivery.stuckAfterMs` — Settings → Delivery → **Warn when unanswered for** —
is the one alert that does not depend on the agent noticing its own failure. If
anybody has been waiting longer than that, every operator number is messaged
once, and the alert re-arms only when the backlog actually drains.

That is deliberately independent of the two checks below, because the failure it
exists for looks healthy from every other angle: the process is up, the socket is
connected, the queue is empty, no fatal state is reported, and every turn is
failing instantly. Setting it to 0 turns the warning off.

### The agent is not reporting

`agent.reporting: false` in the panel means no status file. The container is
down, wedged, or was never able to start a session. Check its log, then:

```bash
docker compose restart agent
```

Restarting loses no conversation. Session ids are derived from the chat, so
every context resumes from disk on the next message.

### A fatal agent state

Expired credentials, no credit, or a usage limit produce a session that accepts
input, looks healthy, and fails every turn instantly. The bridge detects these
by reading the pane, reports them in the panel, and messages your operator
number once. They need a human — usually a new `ANTHROPIC_API_KEY` in `.env`
followed by `docker compose up -d agent`.

### Someone is abusing it

```
!block <key>          from your phone, immediately
```

Then, if it is broader than one person, `!hold` and lower `limits` in
`config.json`. `newSendersPerHour` is the one that blunts a flood of throwaway
numbers.

### WhatsApp logged the device out

The bridge exits deliberately rather than pretending to be healthy. Re-pair by
scanning again; if it recurs, something else is authenticating with the same
credentials — find it before scanning a third time.

---

## Backups

One volume matters:

```bash
docker run --rm -v tulip_state:/state -v "$PWD":/backup alpine \
  tar czf /backup/tulip-state.tgz -C /state .
```

That archive contains the WhatsApp credentials and every message. Treat it
exactly as you would the phone. Store it encrypted, and never in this
repository — `.gitignore` already refuses the obvious names, and
`npm run check:secrets` fails the build if one is staged.

The `workspace` volume holds conversation context. Losing it costs memory, not
correctness: each chat starts fresh and carries on. The `handoff-*` volumes are
transient by construction and need no backup.

---

## Upgrading

```bash
git pull
npm run verify                       # secrets, types, tests
docker compose build
docker compose up -d
scripts/verify-containment.sh
```

The last line is not optional. Docker upgrades have changed networking defaults
before, and the containment properties are environmental — they can be undone by
something that never touched this repository.
