# Several agents, one codebase

Tulip was written as one deployment: one WhatsApp number, one agent, one panel.
It now runs as several — Juan and Maria are two instances on the same host — and
the rule that makes that manageable is that **they share code and nothing else.**

| | Shared | Per instance |
|---|---|---|
| Images (`tulip-bridge`, `tulip-agent`, `tulip-egress`) | ✓ | |
| Compose project, containers, volumes | | ✓ |
| WhatsApp number and credentials | | ✓ |
| Internal network and egress proxy | | ✓ |
| Panel (port, token, Access application) | | ✓ |
| `config.json`, persona, memory, plugins | | ✓ |
| `.env` — keys, hostnames, the agent's name | | ✓ |

Two instances cannot see each other at all. Their agents sit on different
internal networks, their bridges hold different state volumes, and nothing in
either is mounted in the other.

## Running them

`scripts/2lp` is the one entry point:

```bash
scripts/2lp list                 # every instance and its containers
scripts/2lp deploy               # build once, recreate every instance
scripts/2lp deploy maria         # … or only some
scripts/2lp maria status         # what it is doing
scripts/2lp maria stop           # interrupt the turn and hold (Esc, from a shell)
scripts/2lp maria start          # release it
scripts/2lp maria logs           # follow the bridge
scripts/2lp maria compose ps     # anything else
```

**`deploy` is how a change reaches every agent.** The images carry fixed names
and every instance uses them, so the build happens once; then each instance is
recreated on it. Rebuilding with a plain `docker compose up --build` for one
instance retags the shared images and leaves the others running the old code
until they are recreated — which is exactly the drift `deploy` exists to prevent.

`scripts/juan --stop-juan` still works. It is now a thin wrapper that takes the
instance from the name it was run as, so `scripts/maria` (a link to it) stops
Maria.

## Where an instance lives

**The default instance** keeps the repository's own `.env` and `./config`. Its
compose project is `tulip`, its containers are `tulip-bridge` and so on, and
every variable below defaults to its values — so nothing about it had to move.
Its handle in `2lp` is its `TULIP_AGENT_NAME` in lower case, or `default`.

**Every other instance** is a directory: `instances/<handle>/` with its own
`.env`, `config/` and `plugins/`. All of it is ignored by git.

## What makes an instance different

In its `.env`:

| Variable | Default (the original instance) | Why it has to differ |
|---|---|---|
| `TULIP_INSTANCE` | `tulip` | Compose project and container prefix |
| `TULIP_AGENT_NAME` | `Tulip` | What the panel and operator commands call it |
| `TULIP_LAN_SUBNET` | `172.31.240.0/24` | Two projects cannot share an internal subnet |
| `TULIP_EGRESS_IP` | `172.31.240.10` | The proxy's pinned address, inside that subnet |
| `TULIP_PANEL_PORT` | `8791` | Host port the panel is published on |
| `TULIP_HOST_CONFIG` | `./config` | config.json and the persona |
| `TULIP_HOST_PLUGINS` | `./plugins` | Plugin drop-boxes — see [PLUGINS.md](PLUGINS.md) |
| `TULIP_HOST_RUN` | `/run/tulip` | The ttyd socket for the Terminal page |
| `TULIP_TRANSPORT` | `whatsapp` | Which platform the instance talks on: `whatsapp` or `teams` |
| `TULIP_TEAMS_APP_ID` | *(unset)* | Teams only: the bot registration's application (client) id |
| `TULIP_TEAMS_APP_SECRET` | *(unset)* | Teams only: a client secret from that registration. Read by the bridge, never printed |
| `TULIP_TEAMS_TENANT_ID` | *(unset)* | Teams only, optional: the tenant, for a single-tenant registration |
| `TULIP_TEAMS_BIND` | `127.0.0.1` | Host address the Teams endpoint is published on, like `TULIP_PANEL_BIND` |
| `TULIP_TEAMS_PORT` | `8792` | Host port for it. Must differ per instance, like the panel's |

And, not inherited from anywhere: the model credentials, the MiniMax/OpenAI/Exa
keys, `TULIP_PAGES_HOST` and the Access pair. A value left out of an instance's
`.env` is **unset**, not borrowed from the default — deliberately, because a
second instance that quietly served pages on the first one's hostname, or
accepted the first one's Access tokens, is the failure this layout exists to
make impossible.

`TULIP_PAGES_HOST` must be the instance's own, and must not be its panel's
hostname. `TULIP_ACCESS_AUD` is the AUD of *that instance's* Access application.

**A Teams instance has no WhatsApp number.** `TULIP_TRANSPORT=teams` replaces
the Baileys socket with a listener Microsoft's bot service posts to; there is
no pairing code in its logs, no `session/` directory worth copying, and the
panel shows the bot's name where a WhatsApp instance shows the paired number.
The Teams endpoint is published on its own port — it is not the panel, and
cannot sit behind the panel's Cloudflare Access policy, because the bot service
cannot sign in — so each Teams instance needs its own `TULIP_TEAMS_PORT` and its
own tunnel route with no Access in front. Operators and the audience are listed
by Entra object id rather than by number. See [TEAMS.md](TEAMS.md).

## Adding one

```bash
scripts/2lp new rosa          # instances/rosa/ on the next free subnet and port
$EDITOR instances/rosa/.env   # keys, name, bind address
$EDITOR instances/rosa/config/config.json   # or leave it for the panel
scripts/2lp deploy rosa
sudo scripts/install-units.sh # its terminal unit: tulip-ttyd@rosa
```

The first start has no WhatsApp session, so the bridge prints a pairing code in
`scripts/2lp rosa logs`. To move an existing number from another bridge instead,
stop the other one for good first — two clients on one auth store gets the
device logged out — then copy its Baileys `session/` directory into the new
instance's state volume, owned by uid 1000, before the first start.

Then give it a hostname. The reference deployment publishes each panel on the
host's tailnet address and puts a Cloudflare tunnel route and an Access
application in front of it: `maria.2lp.chat → http://<tailnet-ip>:<port>`.
The Access application's AUD goes in the instance's `TULIP_ACCESS_AUD`.

`tulip-boot` starts every instance at boot; it reads `instances/*/.env` itself,
so there is no unit to add for that.
