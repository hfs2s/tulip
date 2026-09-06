# Deploying Tulip

From an empty machine to a WhatsApp number that answers, with the containment
verified rather than assumed. Allow about an hour, most of it waiting for an
image to build on slow hardware.

If something breaks after it is running, the runbook is
[`OPERATIONS.md`](OPERATIONS.md). If you want to understand *why* the topology
is shaped like this before you run it, read [`THREAT-MODEL.md`](THREAT-MODEL.md)
— particularly §T4, which describes a control that was deliberately removed.

> **Deploy this with an agent instead.** [`DEPLOY-PROMPT.md`](DEPLOY-PROMPT.md)
> is the same procedure written to be handed to Claude Code or a similar agent
> with shell access. It stops and asks at each point a human decision is needed.

---

## 0 · What you need before you start

**A machine that stays on.** A Raspberry Pi 5 with 8 GB is the reference
deployment and is comfortable. Anything running 64-bit Linux with Docker will
do. It needs ~4 GB free disk for images and volumes.

**A WhatsApp number that Tulip will *be*.** Its own number, not your personal
one — pairing links a device to that account, and the agent answers as it. A
cheap prepaid SIM or a second WhatsApp Business account is the usual answer.

**An Anthropic API key**, or credentials for an Anthropic-compatible provider.
Use a dedicated, budget-capped key: it is the only credential inside the agent
container, and the threat model assumes an attacker reaches it.

**Optional, each adding one capability:** MiniMax (pictures and voice notes),
OpenAI (transcribing inbound voice notes — the one deliberate exception to
MiniMax-only), Exa (web search), Giphy. Everything works without them; the
agent is told what it cannot do rather than failing silently.

---

## 1 · Prepare the host

```bash
# Docker with the Compose plugin. Skip if you already have it.
curl -fsSL https://raw.githubusercontent.com/hfs2s/tulip/main/scripts/install-docker.sh | sh
# or, from a clone: scripts/install-docker.sh
```

Then **log out and back in**, so your account picks up the `docker` group.
Without that every `docker` command needs `sudo`, which works but makes the
helper scripts noisier.

On a Raspberry Pi, enable the memory cgroup controller — Raspberry Pi OS ships
with it **disabled**, and Docker silently discards a memory limit it cannot
enforce:

```bash
sudo sed -i '1 s/$/ cgroup_enable=memory cgroup_memory=1/' /boot/firmware/cmdline.txt
sudo reboot
```

`scripts/preflight.sh` checks this for you in step 4 and will tell you if it is
still off.

---

## 2 · Get the code

```bash
git clone https://github.com/hfs2s/tulip.git
cd tulip
```

---

## 3 · Configure it

Two files, and the split is deliberate: `.env` is what a deployment *is*
(credentials, hostnames, the model) and needs a restart; `config/config.json` is
what an operator *tunes* (audience, limits, capabilities) and is editable live
from the panel.

```bash
cp .env.example .env
mkdir -p config && cp config.example.json config/config.json
```

**In `.env`, the only thing you must set:**

```
ANTHROPIC_API_KEY=sk-ant-...
```

Every other variable is documented where it is declared, and every default is
the restrictive one. Two worth deciding now:

- `TULIP_PANEL_BIND` — defaults to `127.0.0.1`, so the panel is reachable only
  from the host. Reach it over an SSH tunnel to start with. **Never `0.0.0.0`**:
  that publishes an operator console, which can read every message, to every
  network the host is on.
- `TULIP_EGRESS_ALLOW` — the agent's only path out. The default is the two
  hosts Claude Code needs to start. Every addition is another channel out of the
  jail; add one only with a reason.

**In `config/config.json`, set your operator number:**

```json
"operators": { "numbers": ["15551234567"] }
```

Bare international digits, no `+` and no spaces. This is who may run `!`
commands and who receives watchdog alerts, and it is never widened by
`audience.everyone`. **Leave it empty and you have no way to hold delivery or
block somebody from your phone.**

Decide the audience while you are here. `audience.everyone: true` means anyone
who messages the number is answered — the configuration Tulip is designed for
and the one the threat model assumes. Set it `false` and list numbers if you
want to start closed.

---

## 4 · Preflight

```bash
scripts/preflight.sh
```

This checks what the host must provide and the compose file merely *asks* for.
The important one is the memory cgroup: Docker discards a limit it cannot
enforce with a single warning during startup, so a cap can be absent for months
while your configuration still claims it. **A resource cap written down but not
in force is worse than one never claimed.**

Fix anything it reports before continuing.

---

## 5 · Build and start

```bash
docker compose build      # 10–25 minutes on a Pi, a couple on a laptop
docker compose up -d
```

Three containers come up: `tulip-bridge` (holds the WhatsApp credentials),
`tulip-agent` (holds nothing, runs untrusted input by design) and `tulip-egress`
(the one hole in the wall).

---

## 6 · Pair the WhatsApp number

```bash
docker compose logs -f bridge
```

A QR code appears. Scan it from the phone that owns the number Tulip will *be*:
**WhatsApp → Settings → Linked devices → Link a device.**

Pairing survives restarts and rebuilds — the credentials live in the `state`
volume, not in the image. You only scan again if you unlink the device or delete
that volume.

> **One number, one auth store.** Two Baileys clients on the same credentials
> kick each other off in a loop and can log the device out, forcing a re-scan.
> Never point a second bridge, a "quick test", or a restored backup at a number
> that is already paired. The bridge takes a pidfile lock to make the common
> case impossible, but the lock cannot see another machine.

---

## 7 · Verify the containment

```bash
scripts/verify-containment.sh
```

Seventeen assertions against the *running* containers: no route out, no DNS, no
credentials, read-only root, no path to privilege, and the bridge hardened too.

**This must pass before you give the number to anyone.** If it does not, the
threat model does not currently hold — and that matters whether your audience is
three friends or the open internet, because an injection needs a borrowed phone
or a forwarded document, not a hostile sender.

If it reports that it cannot reach the Docker daemon, that is not a pass — fix
the access and run it again.

---

## 8 · Reach the panel

With the default `TULIP_PANEL_BIND=127.0.0.1`, tunnel to it:

```bash
ssh -L 8791:127.0.0.1:8791 you@your-host
```

Then open `http://127.0.0.1:8791/`. The bearer token is printed in the bridge's
logs on first start and stored in the `state` volume:

```bash
docker exec tulip-bridge cat /state/panel-token
```

If you want it reachable without a tunnel, put something that authenticates in
front of it. `TULIP_ACCESS_TEAM_DOMAIN` and `TULIP_ACCESS_AUD` let the panel
accept a person Cloudflare Access has already authenticated, so adding an
operator becomes a policy change rather than a shared secret. **Both are
required together** — the AUD tag is what binds an assertion to *this*
application, and without it a token minted for any other app on the same
Cloudflare account would be accepted.

---

## 9 · Make it survive a reboot

```bash
sudo scripts/install-units.sh
sudo systemctl start tulip-boot tulip-ttyd
```

Two units. `tulip-ttyd` is the operator terminal — optional, and without it the
panel's Terminal page answers 503 and says why.

`tulip-boot` is the one that looks unnecessary and is not. Every service carries
`restart: unless-stopped`, which reads like the reboot case is covered. It is
not: **Docker restarts a container that *exited*, and a container whose port
bind failed has never started**, so it is left in `created` and nothing touches
it again — not even once the address it wanted appears. That is reachable
whenever `TULIP_PANEL_BIND` is an address something slower assigns, such as a
tailnet or a VPN. `tulip-boot` waits for the address, then starts the stack.

---

## 10 · Make it yours

`persona/` holds four files, assembled in order into the agent's brief:
`IDENTITY.md` (who it is), `VOICE.md` (how it talks), `OPERATING.md` (what it
can do), `BOUNDARIES.md` (what it will not do).

**Rewrite IDENTITY and VOICE.** What ships is one deployment's own character and
will introduce itself by that name. Keep BOUNDARIES largely as it is unless you
understand what each rule is holding up — since Tulip moved to a single shared
session, the discretion rules in that file are the *only* thing keeping one
person's conversation out of another's, and there is no longer an architectural
backstop under them.

The composed brief must stay under **40,000 characters**, which is Claude Code's
limit for a `CLAUDE.md`. Past it the brief is not carried whole and the agent
quietly stops following the parts that fell off. The shared memory is folded in
too, so leave headroom.

Changes take effect when the agent restarts:

```bash
docker compose up -d --force-recreate agent
```

---

## 11 · Check it end to end

Message the number from a phone that is not the one it is paired to. You should
see, in order: the message in the panel's **Messages** page, a turn in
**Terminal**, and a reply in WhatsApp.

If the message arrives and nothing happens, the panel's **Messages** page shows
refused messages *with the reason*, which is almost always the answer — a
silently dropped message is otherwise indistinguishable from one that never
arrived.

---

## Upgrading

```bash
git pull
docker compose build
docker compose up -d
scripts/verify-containment.sh
```

**Verify a deploy from the compiled output inside the running container**, not
from the build log. A push that silently fails to reach the remote produces a
pull that fetches nothing, a rebuild that yields an identical image, and an
`up -d` that does not recreate — every step reporting success while the old code
keeps answering.

Recreating the agent ends its tmux session. The conversation resumes with full
context on the next message, because the session id is derived rather than
stored, but the terminal is empty until then.

---

## Optional capabilities

Each is off until a key is present, and each is independently switchable from
the panel's Settings page so you can turn one off without editing `.env`.

| Set in `.env` | Turns on |
|---|---|
| `MINIMAX_API_KEY`, `MINIMAX_GROUP_ID` | pictures, and voice notes out |
| `OPENAI_API_KEY` | transcribing voice notes *in* |
| `EXA_API_KEY` | web search and page reading |
| `GIPHY_API_KEY` | GIFs |
| `TULIP_PAGES_HOST` | the agent can publish small static pages |

**Every one of these runs in the bridge, not the agent.** The agent names what
it wants and the trusted side performs it, so no billed credential enters the
container an attacker is assumed to own, and the egress allowlist gains no host.

`TULIP_PAGES_HOST` **must not be the panel's hostname.** Agent-authored
JavaScript served from the panel's origin would be same-origin with your
session: one `fetch('/api/settings')` from a page you opened would carry your
cookie.
