# Tulip on Microsoft Teams

How to put an instance on Teams instead of WhatsApp: from no Microsoft tenant at
all to an agent that answers in a channel, with the reasons for each step. It
assumes you have read [`INSTANCES.md`](INSTANCES.md) — a Teams instance is an
ordinary instance whose transport is different — and it does not repeat
[`DEPLOYMENT.md`](DEPLOYMENT.md), which still covers the host, the build and the
containment check.

Two things are different enough from WhatsApp to state up front:

- **There is no pairing.** A WhatsApp instance *is* a phone number and proves it
  by scanning a QR code. A Teams instance is an *application registered in a
  tenant*, and proves it with a client secret. Nothing is scanned; the identity
  is a GUID and a password in `.env`.
- **Microsoft has to reach the Pi.** WhatsApp is an outbound socket the bridge
  opens. Teams is the other way round: Microsoft's bot service `POST`s every
  message to a URL you give it. That URL is a Cloudflare tunnel hostname with
  **no Access application in front of it**, and the bridge checks the signature
  on every request itself. Why that is safe is in [Tunnel and DNS](#tunnel-and-dns).

Everything below matches the transport as built under `TULIP_TRANSPORT=teams`.
Where a portal's menu names are quoted, they were checked against the Microsoft
pages listed at the end on the date in the footer — portals move, so when a
name here is not on the screen, the linked page is the authority, not this one.

---

## What a Teams bot is

Three registrations, and it helps to keep them apart because each has its own
id and its own place to break:

| | What it is | Where it lives | What Tulip needs from it |
|---|---|---|---|
| **Entra app registration** | The identity: an application object in your tenant with a client id and a client secret | Microsoft Entra ID | `TULIP_TEAMS_APP_ID`, `TULIP_TEAMS_APP_SECRET`, `TULIP_TEAMS_TENANT_ID` |
| **Bot registration** | Binds that identity to a *messaging endpoint* and turns on the Teams channel | Developer Portal for Teams, or an Azure Bot resource | the endpoint set to `https://<bot host>/api/messages` |
| **App package** | What a person installs: a zip of `manifest.json` and two icons, naming the bot id and the scopes and permissions it wants | Uploaded to your org's app catalogue | built by `teams-app/build.mjs` |

**A bot is not a user.** It has no mailbox, no licence and no sign-in. It cannot
be added to a chat by email address; it exists only where its *app* has been
installed — a person's personal scope, a group chat, or a team. Someone who has
not installed it cannot message it, and it cannot message them: a proactive
send to a user without the app in personal scope is refused with a `403`.

**A bot is bound to its tenant.** The registration you make below is
single-tenant. People in another organisation cannot install it unless the app
is published to the Microsoft Teams Store or their own admin uploads the
package — and even then a single-tenant registration will not issue them
tokens. That is the right shape for 2lp, which is one organisation, and it is
also the only shape Microsoft still supports for new bots: multi-tenant bot
creation was deprecated after 31 July 2025.

**In a channel or group chat it hears only its own name.** By default a bot in
a channel or group chat receives a post only when it is @mentioned; it does not
receive replies to its own messages, or the rest of the conversation. Tulip's
`observe` group mode needs the whole conversation, so the package requests two
*resource-specific consent* (RSC) permissions, `ChannelMessage.Read.Group` and
`ChatMessage.Read.Chat`, and whoever installs it into a team or chat grants
them for that team or chat at install. Without the grant the mode degrades to
mentions-only, silently, so [Installing it](#installing-it) says how to check.

**Not on Teams in this version**, each degrading rather than failing: a voice
note in is passed on as a note that one arrived and could not be read; a voice
note out is sent as its words; a file send and a reaction are logged and
skipped. The feed says which.

---

## Getting a tenant

A *tenant* is one organisation's directory in Microsoft's cloud: its users,
its Teams, its app catalogue. You do not have one. Everything below creates one
and puts one paid seat in it.

### Which subscription

**Microsoft 365 Business Basic**, one seat. At the time of writing it is
US$6.00 per user per month paid yearly, includes Teams, and supports up to 300
users. It is the cheapest plan on Microsoft's own list of subscriptions that
can develop Teams apps: *Basic, Standard, Enterprise E1/E3/E5, Developer,
Education*. Three things to watch when buying:

- **Teams is sold unbundled in some SKUs, and the name says so.** Since April
  2024 every Microsoft 365 business suite has a "(no Teams)" variant worldwide,
  and since 1 November 2025 those variants are cheaper (Business Standard (no
  Teams) is US$9.29, for instance). The plan you buy must not have "(no Teams)"
  in its name. Business Basic *with* Teams did not change price.
- **Teams Essentials is not the answer**, even though it is the cheaper
  standalone Teams SKU (US$4.00). It is not on Microsoft's list of plans that
  can develop Teams apps, and whether it can host a custom app at all could not
  be confirmed from Microsoft's documentation. Do not buy it for this.
- **The free developer tenant is mostly gone.** The Microsoft 365 Developer
  Program's E5 sandbox is now restricted to Visual Studio Enterprise and
  Professional subscribers and some partners. Do not plan on it. There is a
  one-month trial of the business plans if you want to test before paying.

**One seat is enough.** The bot needs no licence — it is an application, not a
user — and the seat is for the human admin who does the uploading.

### The admin account

Buying the subscription creates the tenant and its first account, which is a
**Global Administrator**. That account does everything in this runbook:
registering the app (needs at least *Application Developer*), uploading the
package org-wide (needs *Teams Administrator* or *Global Administrator*), and
granting RSC in a team (the team's owner). Give it multi-factor authentication
on day one; it owns the tenant.

Use it as an admin account, not a daily one. If somebody else will operate the
instance, add them as a user later rather than sharing this sign-in.

### Domain

The tenant is created as `<something>.onmicrosoft.com`. That name is permanent
and nothing in this runbook needs anything else — the bot's hostnames are on
Cloudflare, not in Microsoft's DNS, and the app id is a GUID. Add a custom
domain only if you want sign-in addresses at it. If you do: the Microsoft 365
admin center, **Settings → Domains → Add domain**, prove ownership with a TXT
record (Cloudflare supports the automatic *Domain Connect* route), and **do not
let it add MX records** for a domain whose mail lives somewhere else — the
wizard offers to, and it moves mail.

### Azure

**Not required.** The Developer Portal route below creates the app registration
and the bot registration without an Azure subscription. The alternative is an
*Azure Bot* resource in the Azure portal, which does need a subscription but
costs nothing for this use: Teams is a "standard channel", and standard-channel
messages are unlimited and free on both the Free and S1 tiers. Use it if you
already live in Azure; otherwise there is no reason to.

---

## Registering

Two routes to the same three ids. Take the first unless you have Azure already.

### Route A — Developer Portal for Teams

1. Sign in to <https://dev.teams.microsoft.com> with the admin account.
2. **Tools → Bot management → + New Bot**, give it the agent's name, **Add**.
   This creates the Entra app registration for you (a service principal appears
   in your tenant), single-tenant by default, and the bot registration with it.
3. On the bot's page, set the **endpoint address** to
   `https://<bot host>/api/messages` — the hostname you will create in
   [Tunnel and DNS](#tunnel-and-dns). It can be set before the tunnel exists;
   nothing is checked until a message is sent.
4. Create a **client secret** on the same page and copy its value immediately;
   it is shown once.
5. Record the **bot id** shown on the page. It is the app registration's
   *Application (client) ID*, and it is `TULIP_TEAMS_APP_ID`.
6. The **tenant id**: Microsoft Entra admin center (<https://entra.microsoft.com>)
   → **Overview**, *Tenant ID*. That is `TULIP_TEAMS_TENANT_ID`.

If the bot page's fields have moved by the time you read this, the same values
are reachable from the Entra side: **Entra ID → App registrations**, the app
with the bot's name, *Application (client) ID* on **Overview** and
**Certificates & secrets → Client secrets → New client secret** for the secret.

### Route B — Azure Bot

1. Azure portal → **Create a resource** → search `bot` → **Azure Bot** → **Create**.
2. Under *Microsoft App ID* choose **Single Tenant** and create a new app id.
   Azure generates a password with it.
3. After deployment, on the bot resource: **Configuration** → *Messaging
   endpoint* = `https://<bot host>/api/messages`. The same blade shows the
   *Microsoft App ID* and *App Tenant ID*.
4. **Manage** next to the app id opens **Certificates & secrets**; create a new
   client secret there and copy it.
5. **Channels → Microsoft Teams**, agree to the terms, **Apply**.

Route A enables the Teams channel for you; Route B needs step 5, and deleting
that channel later regenerates the ids stored for every conversation.

### Single-tenant, and why

Choose single-tenant (Developer Portal's default; "Single tenant only" in Entra).
Three reasons:

- Only this tenant will ever install the app.
- Microsoft no longer creates multi-tenant bots.
- It narrows what the bridge accepts. With `TULIP_TEAMS_TENANT_ID` set the
  bridge fetches its own tokens from
  `https://login.microsoftonline.com/<tenant id>/oauth2/v2.0/token` rather than
  the shared `botframework.com` endpoint. Leave it unset only for a
  multi-tenant registration you already had.

### The secret

The secret is a password for the app. Microsoft caps its lifetime at 24 months
and recommends less than 12; pick 12 and put the expiry date somewhere you will
see it, because an expired secret looks exactly like a dead bot — the bridge
can no longer get a token, so it cannot reply, while inbound messages still
arrive and are verified fine. Microsoft also recommends certificates over
secrets for production; Tulip v1 uses a secret, held only in the bridge
container, on the same principle as every other key in `.env`: it never enters
the agent.

Rotating it is in [Operating](#operating). It is four steps and no downtime.

---

## Tunnel and DNS

A Teams instance needs **two hostnames**, and they are gated differently on
purpose.

| Hostname | Points at | Cloudflare Access | Why |
|---|---|---|---|
| `teams-<handle>.2lp.chat` — the bot | `http://<tailnet-ip>:<TULIP_TEAMS_PORT>` | **none** | Microsoft's bot service must be able to `POST` to it, and it cannot sign in |
| `<handle>.2lp.chat` — the panel | `http://<tailnet-ip>:<TULIP_PANEL_PORT>` | **yes**, its own application | the operator console, exactly as for every other instance |

Both go through the same tunnel that carries `2lp.chat` today. The tunnel
runs on another machine and reaches the Pi over the tailnet, which is why the
origins are the Pi's tailnet address — the same pattern `INSTANCES.md`
describes for a panel: `maria.2lp.chat → http://<tailnet-ip>:<port>`.

### Adding the two ingresses

In the Zero Trust dashboard, **Networks → Tunnels**, open the tunnel, **Public
Hostname → Add a public hostname**:

1. `teams-<handle>` on `2lp.chat`, service **HTTP**, URL
   `<tailnet-ip>:<TULIP_TEAMS_PORT>` (8792 for the first Teams instance).
2. `<handle>` on `2lp.chat`, service **HTTP**, URL
   `<tailnet-ip>:<TULIP_PANEL_PORT>`.

Saving a public hostname creates the DNS record for it. If the tunnel turns out
to be configured from a file rather than the dashboard (`cloudflared` running
with a `config.yml` and an `ingress:` list), add the two rules there instead,
restart `cloudflared`, and create the records with
`cloudflared tunnel route dns <tunnel> <hostname>`.

Then the panel's Access application, as for any instance: **Access →
Applications → Add an application → Self-hosted**, domain `<handle>.2lp.chat`,
the One-time PIN identity provider, a policy allowing the operators' addresses.
Copy the application's **AUD** tag into the instance's `TULIP_ACCESS_AUD`, and
the team domain into `TULIP_ACCESS_TEAM_DOMAIN`. Both or neither — see
`.env.example`.

### Why the bot hostname has no Access, and why that is fine

Access authenticates *people*. Microsoft's bot service is a machine that will
never see a sign-in page; put Access in front of `/api/messages` and every
message from Teams gets a 302 to a login form, and Teams reports the bot as not
responding.

What stands in Access's place is the signature Microsoft puts on every request.
The bot service sends a JWT in the `Authorization` header, and the bridge
verifies it the way Microsoft specifies before reading a byte of the body:

- signed with a key from `https://login.botframework.com/v1/.well-known/keys`,
  fetched via the OpenID metadata document and refreshed;
- `iss` is `https://api.botframework.com`;
- `aud` is this instance's `TULIP_TEAMS_APP_ID` — a token minted for any other
  bot is refused;
- within its validity window, with the standard five-minute clock skew;
- the token's `serviceUrl` claim matches the `serviceUrl` in the activity, so a
  valid token cannot be replayed against a body that points replies elsewhere.

A request without a token, or with one that fails any check, gets a `401` and
is not recorded. Nothing else is served on that port — no panel, no pages, no
terminal — so the hostname exposes one route whose every request must carry
Microsoft's signature. That is a narrower surface than the panel's, not a
wider one.

Two Cloudflare settings can break it without touching Tulip:

- **A wildcard Access application.** An application whose domain is
  `*.2lp.chat` would catch the bot hostname. Check **Access → Applications**
  for anything that matches `teams-<handle>.2lp.chat`.
- **Bot Fight Mode, or a WAF rule that challenges non-browser clients.**
  Microsoft's requests are not a browser and cannot solve a challenge; they
  would receive a challenge page, the bridge would see nothing, and Teams would
  show "something went wrong". If the zone has such a rule, add a WAF exception
  for the bot hostname.

The verification step in [Creating the instance](#creating-the-instance) tells
these apart from a Tulip fault.

---

## Creating the instance

Everything in `INSTANCES.md` applies. What follows is only what Teams adds.

```bash
scripts/2lp new <handle>            # instances/<handle>/ on a free subnet and port
$EDITOR instances/<handle>/.env
```

The `.env`, complete. A value left out is **unset**, not inherited — the point
of the layout — so set every line:

```bash
# Transport
TULIP_TRANSPORT=teams
TULIP_TEAMS_APP_ID=<Application (client) ID>
TULIP_TEAMS_APP_SECRET=<client secret value>
TULIP_TEAMS_TENANT_ID=<Directory (tenant) ID>       # set for a single-tenant registration
TULIP_TEAMS_BIND=<tailnet-ip>                       # where the /api/messages listener publishes
TULIP_TEAMS_PORT=8792                               # 8792 is the default; next instance takes 8793

# The instance (2lp new fills these)
TULIP_INSTANCE=<handle>
TULIP_AGENT_NAME=<Name>
TULIP_LAN_SUBNET=172.31.24x.0/24
TULIP_EGRESS_IP=172.31.24x.10
TULIP_PANEL_PORT=879x
TULIP_PANEL_BIND=<tailnet-ip>
TULIP_HOST_CONFIG=./instances/<handle>/config
TULIP_HOST_PLUGINS=./instances/<handle>/plugins
TULIP_HOST_RUN=/run/tulip-<handle>

# The model, as for any instance
ANTHROPIC_API_KEY=...                               # or ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + TULIP_MODEL
TULIP_EGRESS_ALLOW=api.anthropic.com,platform.claude.com

# Capabilities (each optional; voice out is text on Teams whatever is set here)
EXA_API_KEY=...
MINIMAX_API_KEY=...

# The panel behind Access
TULIP_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
TULIP_ACCESS_AUD=<the panel application's AUD>
```

`TULIP_TEAMS_BIND` should be the same address as `TULIP_PANEL_BIND`: the
tailnet address, so the tunnel can reach it and nothing else can. Never
`0.0.0.0`.

Then, as for any instance:

```bash
$EDITOR instances/<handle>/config/config.json       # operators, group mode, limits — or use the panel
scripts/2lp deploy <handle>
sudo scripts/install-units.sh                       # its terminal unit
scripts/verify-containment.sh                       # unchanged by the transport; must still pass
```

`config.json` differs from a WhatsApp instance in one respect: **operators and
the audience are Teams identities, not phone numbers.** The Log page records
the identifier the gate saw for every refused message, exactly as it does for a
WhatsApp linked id, so the first thing to do after the first message is to copy
yours out of the refusal into `operators` — the same copy-not-guess step
`OPERATIONS.md` describes.

The persona lives in `instances/<handle>/config/persona/` and is edited on the
panel; the starter in `persona/` is what it begins as. Plugins drop into
`instances/<handle>/plugins/`.

### Verify the endpoint before the package exists

There is no QR code to wait for. What replaces it is one request:

```bash
# From the Pi, straight at the listener:
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://<tailnet-ip>:8792/api/messages -H 'content-type: application/json' -d '{}'
# → 401

# From anywhere, through the tunnel:
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://teams-<handle>.2lp.chat/api/messages -H 'content-type: application/json' -d '{}'
# → 401
```

**`401` is the answer you want.** It is the JWT gate refusing an unsigned
request, which is what it will do to anyone who is not Microsoft. Anything else
is a specific fault:

| You get | It means |
|---|---|
| `401` on the tailnet, `302` through the tunnel | an Access application is in front of the bot hostname — remove it |
| `401` on the tailnet, `403` or an HTML challenge through the tunnel | the WAF or Bot Fight Mode is challenging the request — add an exception |
| `401` on the tailnet, `502`/`530` through the tunnel | the public hostname points at the wrong address or port |
| connection refused on the tailnet | the bridge is not up, or `TULIP_TEAMS_BIND`/`TULIP_TEAMS_PORT` are wrong — `scripts/2lp <handle> logs` |
| `404` | the listener is up but `TULIP_TRANSPORT` is not `teams` — the panel answered |

---

## Building and uploading the app package

### Build it

```bash
node teams-app/build.mjs instances/<handle>/.env
# → teams-app/dist/<handle>.zip
```

The script reads the instance's `.env` for two values — `TULIP_TEAMS_APP_ID`
and `TULIP_AGENT_NAME` — fills them into `teams-app/manifest.json`, checks the
result (GUIDs where GUIDs are required, the length limits Teams enforces, the
icons present at their required sizes), and writes a zip with `manifest.json`,
`color.png` and `outline.png` at its root, which is where Teams insists they
are. It never reads the secret, and nothing in the zip is sensitive; hand it to
whoever holds the admin account.

Node has no zip writer and the repository has no zip library, so the script
writes the archive itself — uncompressed, which Teams accepts, with fixed
timestamps so the same inputs give the same bytes. `teams-app/dist/` is
ignored by git.

Five more placeholders have defaults and can be overridden in the same `.env`;
the bridge never reads them:

| Placeholder | Default | Change it when |
|---|---|---|
| `TULIP_TEAMS_PACKAGE_VERSION` | `1.0.0` | every re-upload — Teams treats a package with the same version as the same app and will not update installs |
| `TULIP_TEAMS_PACKAGE_DEVELOPER` | `2lp` | the org's name should show instead |
| `TULIP_TEAMS_PACKAGE_WEBSITE` | `https://2lp.chat/` | |
| `TULIP_TEAMS_PACKAGE_PRIVACY` | `https://2lp.chat/privacy` | **these two pages do not exist yet.** Teams requires the URLs to be `https` and does not fetch them at upload, so the placeholders work — but they are shown to anyone who opens the app's details, so put a page behind each before people see it |
| `TULIP_TEAMS_PACKAGE_TERMS` | `https://2lp.chat/terms` | as above |

The manifest is schema **v1.30**, the current version at the time of writing:
`https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json`.
The bot declares scopes `personal`, `team` and `groupChat`, `supportsFiles:
false` (files are not supported in this version, and saying so stops Teams
offering the attach button), `isNotificationOnly: false` (it answers), an empty
`validDomains` (the app has no tab and loads nothing), `webApplicationInfo`
carrying the app id (required for RSC; its `resource` is inert but must be a
value), and exactly two RSC permissions:

| Permission | Why it is there |
|---|---|
| `ChannelMessage.Read.Group` | receive every post in a team's channels without an @mention — `observe` mode in channels |
| `ChatMessage.Read.Chat` | the same for group chats |

And what is *not* there, because it is not needed: `ChannelMessage.Send.Group`
is for posting through the Graph API — a bot replies through the bot service
into any conversation it is installed in, with no permission beyond being
installed. `TeamsAppInstallation.Read.*` lists installations through Graph;
Tulip does not. `TeamsActivity.Send.*` sends activity-feed notifications,
which Tulip does not use. There is no `ChatMessage.Send.Chat` — it does not
exist. Every permission in the manifest is shown to the person installing, so
the list is kept to what is used.

The icons are placeholders drawn by `teams-app/icons.mjs`; replace the two
PNGs with real artwork at the same sizes whenever there is some.

### Turn on custom apps in the tenant

One-time, in the Teams admin center (<https://admin.teams.microsoft.com>). The
**Teams** entry in the admin center can take up to 24 hours to appear after
purchase.

1. **Teams apps → Manage apps → Actions → Org-wide app settings → Custom apps**:
   turn on *Let users interact with custom apps in preview*.
2. **Teams apps → Setup policies → Global**: turn on *Upload custom apps* if you
   want to sideload straight into a team or chat from the client for testing
   (below). Not needed for the org-wide route.

### Upload it

Two ways in; the first is the one to use.

**Org-wide, from the admin center.** **Teams apps → Manage apps → Upload new
app** (or **Actions → Upload new app**), choose the zip. The app appears in the
org's catalogue — the *Built for your org* section of the Teams app store —
with no approval step, because an admin uploaded it. Microsoft says it can take
a few hours to show for users. Updating later is the same page: open the app,
**Upload file**, a package with a higher `version`.

**From the Developer Portal.** **Apps → Import app**, the zip, then **Publish →
Publish to org**. That files a request that the *same* admin then approves in
the admin center under **Manage apps**. It is the long way round when one
person holds both roles; its one advantage is **Publish → App validation**,
which runs Microsoft's own package checks and is worth a look the first time.

**Sideloading**, for a quick test without touching the catalogue: in the Teams
client, **Apps → Manage your apps → Upload an app → Upload a custom app**, the
zip, then pick a scope. Needs *Upload custom apps* on in the setup policy. A
sideloaded app is not in the catalogue and has to be uploaded again per
context; use it to try things, not to deploy.

### Installing it

Once it is in the catalogue, people add it from **Apps → Built for your org**.
Three scopes, and each is a separate install:

- **Personal.** *Add* opens a one-to-one chat. One conversation, one chat key.
- **Group chat.** In the chat, **⋯ → Manage apps → Add**, or *Add to a chat*
  from the app's page. One conversation.
- **Team.** **⋯ → Manage team → Apps**, or *Add to a team*. Every channel's
  every *post* becomes its own conversation — a thread is a chat key. Replying
  in the thread continues it; a new post starts a new one, which is the
  granularity Teams itself uses.

**RSC is granted at install, and it is granted for that team or chat only.** The
install dialog for a team or a group chat lists the two permissions and asks
for consent. Who may say yes is a tenant setting whose default,
`ManagedByMicrosoft`, currently lets a team owner (or member) consent for a
team and a chat member for a chat. If the dialog shows no permissions, or the
agent only ever answers when mentioned, one of these is the reason:

- the package was installed **before** RSC was added to the manifest. RSC is
  read at install; remove the app from that team or chat and add it again.
- the tenant has RSC turned off (`DisabledForAllApps`). Microsoft's
  recommendation is to leave the default, and this runbook agrees.
- the install failed with `WebApplicationInfoIdOfSideloadedAppMustBeInTheSameTenantAsUser`:
  the app registration is in a different tenant from the person installing, or
  they are not an admin. Register and install in the same tenant.

To see what a team actually granted, Graph Explorer with the admin account:
`GET https://graph.microsoft.com/beta/teams/{groupId}/permissionGrants` — the
`clientAppId` should be the app id.

### The first message

Personal scope first. Send anything; then, in order, the panel's **Messages**
page shows it (accepted or refused, with the reason), **Terminal** shows a
turn, Teams shows a reply. If it is refused for not being on the allow list,
copy the identifier from the **Log** page's `gate.deny` line into
`operators` or `audience`, exactly as with a WhatsApp linked id.

Then a team: @mention it in a channel and expect a threaded reply. Then, with
`groups.replyTo` set to `observe` on the panel, post in the channel *without*
mentioning it and watch the feed — the post should arrive whether or not the
agent chooses to answer. If it does not arrive, RSC was not granted; see above.

---

## Operating

### What you see

The feed records every inbound activity before gating, as on WhatsApp, and the
`!` commands and the panel work unchanged. What is different is the shape of a
chat key: a Teams conversation id rather than a JID, long and opaque —
`19:…@thread.tacv2;messageid=…` for a channel thread, `19:…@thread.v2` for a
group chat, `a:…` for a personal chat. `!chats` prints them; `!block`,
`!unblock` and `!reset` take them as they are.

Delivery to Teams is the bridge calling Microsoft's bot service with a token it
fetched using the secret. Two failures look alike from the outside and are told
apart in the log:

- **Inbound arrives, nothing goes out.** The token fetch is failing — the
  secret has expired or was deleted, or the tenant id is wrong. Rotate the
  secret below.
- **Nothing arrives at all.** The bot service cannot reach the endpoint. Run the
  `curl` checks in [Verify the endpoint](#verify-the-endpoint-before-the-package-exists);
  the table there names the fault.

Rate limits are Microsoft's as well as Tulip's: the bot service returns `429`
above roughly seven sends a second into one conversation and 50 requests a
second per app per tenant. The bridge backs off; a burst that hits it is
delayed, not lost, and the log says so.

### Rotating the secret

No downtime, four steps, in this order:

1. Create a second secret on the app registration (Developer Portal, or Entra
   → **Certificates & secrets → New client secret**). Both are valid at once.
2. Put the new value in `instances/<handle>/.env` as `TULIP_TEAMS_APP_SECRET`.
3. `scripts/2lp deploy <handle>` — `.env` changes need the container recreated.
   Confirm a reply goes out.
4. Delete the old secret.

Do it before the expiry date you wrote down. Set the new one to 12 months.

### Revoking

In order of how much it stops:

- **Stop it answering:** delete every client secret on the app registration.
  Inbound still arrives and is recorded; nothing can go out, because the bridge
  can no longer get a token.
- **Stop it hearing:** remove the public hostname from the tunnel. The bot
  service's `POST`s fail at Cloudflare and never reach the Pi.
- **Remove it from Teams:** admin center → **Manage apps** → the app → **Delete**.
  It is uninstalled everywhere at once.
- **Remove the identity:** delete the app registration in Entra. The GUID is
  gone for good; a new registration is a new bot with new ids.

`scripts/2lp <handle> stop` still holds delivery from the Tulip side, and is
the thing to do first when the problem is what the agent is *saying*.

### Changing the package

Anything in the manifest — name, description, icons, permissions — is a new
package: bump `TULIP_TEAMS_PACKAGE_VERSION`, rebuild, **Upload file** on the
app's page in the admin center. People get an *Update* prompt in **Manage your
apps** and the update applies to every context they have it in. An RSC change
is the exception noted above: it takes effect where the app is re-added, not
where it is updated.

### A second Teams instance

Everything from [Registering](#registering) again, separately. Specifically:

- **A new app registration.** Microsoft requires a one-to-one mapping between a
  Teams app and an Entra app id; two packages sharing one id fail to install or
  fail at runtime. New GUID, new secret, new bot registration, new endpoint.
- **A new bot hostname on the next port** (`TULIP_TEAMS_PORT=8793`), and a new
  panel hostname with its own Access application and AUD. Neither instance may
  reuse the other's `TULIP_ACCESS_AUD`, for the reason `INSTANCES.md` gives.
- **The same tenant is fine.** Both apps sit in the same catalogue as separate
  entries, and a team can install either or both.
- **The same `.env` discipline.** Nothing is inherited; a Teams value left out
  is unset.

`scripts/2lp deploy` with no handle still rebuilds once and recreates every
instance, Teams and WhatsApp alike.

---

## How it flows

```
  Teams client ──► Microsoft bot service ──► Cloudflare tunnel (no Access)
                                                        │
                                          POST /api/messages, JWT in header
                                                        ▼
                      ┌──────────────────────────────────────────────────────┐
                      │  tulip-bridge · Teams listener  (:TULIP_TEAMS_PORT)  │
                      │                                                      │
                      │  verify JWT ─── fail ──► 401, nothing recorded       │
                      │      │                                               │
                      │     ok ──► 200 to Microsoft                          │
                      │      │     (before any work; Microsoft will not      │
                      │      │      wait for the agent)                      │
                      │      ▼                                               │
                      │  record in feed ─► gate ─► limits ─► envelope        │
                      └───────────────────────────────┬──────────────────────┘
                                                      │ writes
                                                      ▼
                                          ╔═══════════════════╗
                                          ║  volume: in       ║
                                          ╚═════════╤═════════╝
                                                    │ reads
                                                    ▼
                      ┌───────────────────────────────────────────────────────┐
                      │  tulip-agent · one shared Claude Code session          │
                      │  the turn runs; tulip-wa reply / quiet / …            │
                      └───────────────────────────────┬───────────────────────┘
                                                      │ writes
                                                      ▼
                                          ╔═══════════════════╗
                                          ║  volume: out      ║
                                          ╚═════════╤═════════╝
                                                    │ reads + deletes
                                                    ▼
                      ┌───────────────────────────────────────────────────────┐
                      │  tulip-bridge · outbox sender                          │
                      │  turn → conversation (the bridge's mapping, never the  │
                      │  agent's) · token from login.microsoftonline.com       │
                      │  (client secret) · POST {serviceUrl}/v3/conversations/ │
                      │  {id}/activities/{replyToId}                            │
                      └───────────────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                             Microsoft bot service ──► Teams client
```

Two things the picture is making a point of. The `200` goes back to Microsoft
as soon as the request is verified and recorded, and the reply is a *separate*
outbound call later — the bot service does not hold the request open for an
agent turn, and community reports put its patience at around fifteen seconds.
And the outbound call names a conversation the **bridge** looked up from the
turn: the agent still cannot choose who it talks to, exactly as on WhatsApp
(control 5 in the README).

The agent's containment is untouched by the transport. It has no network, no
DNS and no credentials; the secret, the tokens and the endpoint all live in the
bridge.

---

## Checklist

**Tenant**

- [ ] Microsoft 365 Business Basic, one seat, with Teams — the SKU name does not say "(no Teams)"
- [ ] Admin account has MFA; its sign-in is not shared
- [ ] Tenant id recorded

**Registration**

- [ ] Bot created (Developer Portal → Tools → Bot management, or Azure Bot), single-tenant
- [ ] Endpoint address set to `https://teams-<handle>.2lp.chat/api/messages`
- [ ] Teams channel on (automatic via Developer Portal; Channels → Microsoft Teams on Azure Bot)
- [ ] Client secret created, 12 months, expiry date written down where you will see it
- [ ] `TULIP_TEAMS_APP_ID`, `TULIP_TEAMS_APP_SECRET`, `TULIP_TEAMS_TENANT_ID` in the instance `.env`

**Tunnel**

- [ ] Public hostname `teams-<handle>.2lp.chat` → `<tailnet-ip>:<TULIP_TEAMS_PORT>`, **no** Access application, no wildcard catching it
- [ ] Public hostname `<handle>.2lp.chat` → `<tailnet-ip>:<TULIP_PANEL_PORT>`, Access application created, AUD in `.env`
- [ ] No WAF or Bot Fight rule challenging the bot hostname

**Instance**

- [ ] `scripts/2lp new <handle>`; every variable in `.env` set, none left to inherit
- [ ] `scripts/2lp deploy <handle>`; `sudo scripts/install-units.sh`
- [ ] `scripts/verify-containment.sh` passes
- [ ] Unauthenticated `POST` answers `401` on the tailnet **and** through the tunnel

**Package**

- [ ] Custom apps on in Org-wide app settings
- [ ] `node teams-app/build.mjs instances/<handle>/.env`
- [ ] Uploaded: Teams admin center → Manage apps → Upload new app
- [ ] Privacy and terms pages exist at the URLs in the manifest, or the placeholders were changed

**Proof**

- [ ] Personal chat: message in feed, turn in Terminal, reply in Teams
- [ ] Your identifier copied from the first refusal into `operators`
- [ ] Team: @mention answered in a thread
- [ ] Team, `observe` mode: an unmentioned post reaches the feed (RSC granted at install)
- [ ] Secret rotation rehearsed once, so the first real one is not the first

---

## Sources

Every Microsoft page relied on above, checked 2026-09-15.

**Manifest and package**

- App manifest schema (v1.30 current): <https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema>
- The schema itself: <https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json>
- Upload a custom app (sideloading from the client): <https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload>
- Manage apps with Developer Portal (Bot management, Publish to org, single-tenant by default, multi-tenant deprecation): <https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/manage-your-apps-in-developer-portal>

**RSC**

- Resource-specific consent (permission list, who can consent): <https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent>
- Grant RSC permissions (manifest shape, tenant states, the same-tenant error, verifying grants): <https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/grant-resource-specific-consent>
- Receive all channel and chat messages with RSC: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents>
- Channel and group conversations (mention-only by default, threads): <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations>
- Proactive messages (install requirement, `403`, conversation ids): <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages>

**Registration and identity**

- Register an app in Microsoft Entra ID (account types, where the ids are): <https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app>
- Add credentials (secret lifetime cap and recommendation, shown once): <https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials>
- Azure Bot resource, app types, single-tenant (and the multi-tenant deprecation date): <https://learn.microsoft.com/en-us/azure/bot-service/bot-builder-authentication>
- Connect a bot to Teams (Channels → Microsoft Teams; re-enabling regenerates ids): <https://learn.microsoft.com/en-us/azure/bot-service/channel-connect-teams>
- Azure AI Bot Service pricing (standard channels unlimited and free): <https://azure.microsoft.com/en-us/pricing/details/bot-services/>

**The wire**

- Authenticate requests with the Bot Connector API (token endpoints, single-tenant variant, OpenID metadata, the seven checks): <https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication>
- Send and receive messages (reply endpoint, `serviceUrl`): <https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-send-and-receive-messages>
- Rate limiting for agents: <https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit>

**Tenant, licensing, admin**

- Get started with a Microsoft 365 tenant (plans that can develop Teams apps; developer program eligibility; enabling custom app upload): <https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/prepare-your-o365-tenant>
- Manage custom app policies and settings (admin upload, org-wide settings, setup policies): <https://learn.microsoft.com/en-us/microsoftteams/teams-custom-app-policies-and-settings>
- Microsoft 365 Business Basic (price, Teams included, 300-user cap): <https://www.microsoft.com/en-us/microsoft-365/business/microsoft-365-business-basic>
- Update to Microsoft 365 and Teams licensing, 1 November 2025: <https://www.microsoft.com/en-us/licensing/news/microsoft365-teams-2025>
- Realigning global licensing for Microsoft 365 (the April 2024 unbundling): <https://www.microsoft.com/en-us/licensing/news/microsoft365-teams-ww>
- Teams Essentials quickstart: <https://learn.microsoft.com/en-us/microsoftteams/get-started-with-teams-essentials>
- Add a custom domain to Microsoft 365: <https://learn.microsoft.com/en-us/microsoft-365/admin/setup/add-domain>

**Not from Microsoft's documentation, and marked as such above:** the
~15-second response budget is from Microsoft Q&A threads
(<https://learn.microsoft.com/en-us/answers/questions/5488609/microsoft-teams-azure-bot-not-sending-events-to-me>),
not a reference page.
