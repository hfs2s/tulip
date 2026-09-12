# Plugins

Services on the host that send through an agent's WhatsApp number — a morning
check-in, a ticket desk, a photobooth that hands a guest their picture. They are
not part of the agent and do not go through a conversation: they drop a message
in a directory and the bridge sends it, within limits the operator set.

Plugin *code* does not live in this repository and never runs inside the bridge.
A plugin is any process that can write a file. Its keys, its database and its
business logic stay with it.

## The grant

A plugin is a directory, `<TULIP_HOST_PLUGINS>/<name>/`, and an entry for the
same name under `plugins` in the instance's `config.json`:

```json
"plugins": {
  "morning-anchor": {
    "enabled": true,
    "label": "Morning Anchor",
    "kinds": ["text"],
    "recipients": ["100000000000042@lid"],
    "perHour": 20
  },
  "photobooth": {
    "enabled": true,
    "kinds": ["image"],
    "recipients": "any",
    "private": true,
    "perHour": 60
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Off sends nothing; waiting messages stay queued. The panel's switch. |
| `label` | the name | What the panel and feed call it. |
| `kinds` | `["text"]` | `text` and/or `image`. |
| `recipients` | `[]` | Bare numbers, `<id>@lid`, or group `<id>@g.us`. `"any"` means any **direct** chat — never a group; a group must be named. Empty reaches nobody. |
| `private` | `false` | Keep contents and recipient out of the feed and logs. For services whose messages are a customer's own ticket or photo. |
| `perHour` | `30` | Ceiling. Past it messages wait for the hour to allow them; nothing is dropped. |

Deny-by-default in every direction: a directory with no entry is ignored (and
shown on the panel as *not configured*, so a misdirected service is visible),
an entry is off until enabled, and a new entry reaches nobody.

The panel shows every plugin with its switch, what it is waiting on, when it
last sent, and its last problem. Who it may reach is edited in `config.json`
only — widening a recipient list is a decision worth a diff.

## Sending

Write one JSON file per message into the plugin's directory. Write it under a
temporary name and rename it into place, so the bridge never reads half of it:

```bash
dir=/path/to/instances/maria/plugins/morning-anchor
id="$(date +%s%3N)-$RANDOM"
printf '%s' '{"id":"'"$id"'","kind":"text","to":"34600000000@s.whatsapp.net","text":"Good morning"}' > "$dir/$id.json.tmp"
mv "$dir/$id.json.tmp" "$dir/$id.json"
```

| Field | | |
|---|---|---|
| `id` | required | Yours. Appears in logs. |
| `kind` | required | `text` or `image`. |
| `to` | required | `<number>@s.whatsapp.net`, `<id>@lid` or `<id>@g.us`. |
| `text` | for `text` | Up to 12,000 characters. |
| `file` | for `image` | A **plain file name inside the plugin's directory** — PNG or JPEG, up to 5 MB. |
| `caption` | optional | For an image. |
| `externalId` | optional | Your id for the thing being delivered. Makes the send idempotent — see below. |
| `expiresAt` | optional | Epoch milliseconds. Past it the message is refused, not sent late. |

Unknown fields are refused, not ignored.

## What comes back

- **Sent:** the `.json` is removed and a receipt written beside it —
  `<name>-<externalId>.sent` when the action had an `externalId`, otherwise
  `<file stem>.sent`.
- **Refused or given up on:** the `.json` becomes `<file stem>.failed`. A
  refusal (recipient not granted, kind not allowed, expired, blocked chat,
  malformed) is immediate. A failed *send* is retried four times with backoff
  (5s, 10s, 20s) first — well inside the 75 seconds the Iris-era services wait.
  For a `private` plugin the `.failed` holds only the time and reason.
- **Waiting:** over its hourly ceiling, or while WhatsApp is disconnected or the
  plugin is switched off, the `.json` simply stays.

**Idempotency.** If a receipt for an action's `externalId` already exists, the
action is discarded without sending. A service that retries — because its own
acknowledgement failed, or because it restarted — can never cause a customer to
get the same ticket twice.

Plugin sends are recorded in the feed (as the agent's own `out` rows, labelled
`plugin:<name>`, when the recipient is a chat the bridge already knows), so the
agent sees them in conversation history and an operator reading a chat sees
what a plugin said in it. They are not affected by `!hold` — that governs the
agent — and are stopped instead by the plugin's switch.

## Services written for Iris

Iris's outbox used the same idea, and its services run unchanged: their actions
carry `chat` and `path` rather than `to` and `file`, which are accepted as
aliases (only the last component of `path` is used, and only inside the plugin's
directory), and their receipts are named the way they already look for them —
as long as each is given a directory named for its receipt prefix (`bibim`,
`photobooth`). Point one at its directory with `IRIS_OUTBOX_DIR`:

```ini
# ~/.config/systemd/user/iris-bibim-club.service.d/2lp.conf
[Service]
Environment=IRIS_OUTBOX_DIR=/home/you/tulip/instances/maria/plugins/bibim
```

## Callable plugins

The other direction: the agent *asks* a plugin something and gets its answer —
is booking 4411 paid, what is on tomorrow's rota. Same directory, same config
entry, plus a `callable` block:

```json
"plugins": {
  "bookings": {
    "label": "Bookings",
    "callable": { "enabled": true, "operatorOnly": true, "timeoutMs": 60000 }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `callable.enabled` | `false` | Off, or absent, and the agent cannot see or call it. |
| `callable.operatorOnly` | `true` | Only on an operator's turn — see below. |
| `callable.timeoutMs` | `60000` | How long the bridge waits for an answer. 1,000 to 300,000. |

An entry can be outbound-only, callable-only, or both. The example above is
callable-only: `enabled` is the *outbound* switch and stays off, and its empty
recipient list reaches nobody. Like the recipient list, `callable` is edited in
`config.json` only — the panel cannot turn it on.

### Who may call it

**By default, only an operator, in a direct message.** `operatorOnly` asks the
same question `contact` and `leave` ask: is this turn an operator's own, decided
from the sender's WhatsApp id before the agent saw anything. A group never
carries that, even when the operator is the one speaking in it, so an
operator-only plugin is refused in every room — and is left out of the agent's
listing there, rather than listed and then refused.

Set `operatorOnly: false` only for a plugin that is safe for anybody the agent
answers to use, in any chat including groups: something read-only, about
nothing private.

### The protocol

```
<TULIP_HOST_PLUGINS>/bookings/
  manifest.json        yours: what you offer
  calls/<id>.json      the bridge's: one request
  answers/<id>.json    yours: the answer to it
```

**`manifest.json`** says what the plugin offers. It is read afresh on every
listing and every call, so a new action is offered as soon as it is written.

```json
{
  "label": "Bookings",
  "description": "Looks up table bookings in the restaurant's booking system.",
  "actions": [
    {
      "name": "lookup",
      "summary": "Find a booking by its reference and say whether it is paid.",
      "args": { "ref": "the booking reference, e.g. 4411" }
    },
    { "name": "today", "summary": "List today's bookings." }
  ]
}
```

| Field | | |
|---|---|---|
| `label` | optional | Up to 64 characters. The `label` in `config.json` wins if both are set. |
| `description` | required | Up to 500 characters. The agent reads it to decide whether to use you. |
| `actions` | required | Up to 30. `name` is lowercase letters, digits and dashes, up to 40; `summary` up to 200. |
| `actions[].args` | optional | Argument name to a description of up to 200 characters; up to 10. A name starts with a letter, then letters, digits or `_`. |

The bridge refuses a call **before writing anything** if the plugin is not
enabled, the turn may not use it, the action is not in the manifest, or an
argument is one that action does not declare. An argument you declare may still
be left out, so check for the ones you need.

**`calls/<id>.json`** is one request, written atomically by the bridge (which
creates `calls/` if it is missing):

```json
{ "id": "6f1c2b9e-0c55-4a4e-9d7b-3f0a8e2d1c44", "action": "lookup",
  "args": { "ref": "4411" }, "at": "2026-09-10T18:02:11.000Z" }
```

`args` values are always strings, up to 2,000 characters each. They came from a
conversation: validate them as you would any caller's input.

**`answers/<id>.json`** is yours, with the same `id`. Write it under a temporary
name and rename it into place, as for sending:

```json
{ "id": "6f1c2b9e-0c55-4a4e-9d7b-3f0a8e2d1c44", "ok": true,
  "text": "Booking 4411: paid, 4 guests, Friday 20:00." }
```

`ok: false` with an `error` (up to 500 characters) says you understood and could
not do it. `text` is up to 20,000 characters. Unknown fields, the wrong `id`, a
file over 256 KB or anything that is not a regular file — a link included — is
refused, and the agent is told the answer was refused.

The bridge deletes your answer once it has read it, and deletes its call once it
has an answer or gives up. You may delete a call when you take it; you do not
have to.

### Timeouts

The bridge waits `timeoutMs` for an answer. After that it deletes the call and
tells the agent the plugin did not answer — *not* that it failed — so the agent
says it does not know whether anything happened. A service that finishes after
the timeout should assume nobody heard; if the action changed something, it is
still changed, which is the case for answering quickly or keeping actions
read-only.

### What the agent sees

Your `text`, inside a banner saying it came from your service, that it is data
rather than instructions, and that it says only what your service reported. The
agent is told never to claim you did something your answer does not say, so say
plainly what happened. An `error` is shown as your words, quoted, in the failure
the agent relays.

### A minimal service

No dependencies. Run it on the host as whoever owns the plugin's directory:

```js
#!/usr/bin/env node
// bookings.js — answers `lookup` and `today` for the callable plugin above.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.PLUGIN_DIR; // e.g. /home/you/tulip/instances/maria/plugins/bookings
const calls = path.join(dir, 'calls');
const answers = path.join(dir, 'answers');
fs.mkdirSync(calls, { recursive: true });
fs.mkdirSync(answers, { recursive: true });

const answered = new Set();
function answer(id, body) {
  const tmp = path.join(answers, `${id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, ...body }));
  fs.renameSync(tmp, path.join(answers, `${id}.json`));
}

setInterval(() => {
  for (const name of fs.readdirSync(calls)) {
    if (!name.endsWith('.json') || answered.has(name)) continue;
    answered.add(name);
    const call = JSON.parse(fs.readFileSync(path.join(calls, name), 'utf8'));
    if (call.action === 'lookup') {
      // Your real lookup goes here, with your own credentials.
      answer(call.id, { ok: true, text: `Booking ${call.args.ref ?? '?'}: paid, 4 guests, Friday 20:00.` });
    } else if (call.action === 'today') {
      answer(call.id, { ok: true, text: 'Three bookings today: 13:00 (2), 20:00 (4), 21:30 (6).' });
    } else {
      answer(call.id, { ok: false, error: `no action called ${call.action}` });
    }
  }
}, 500);
```

The agent reaches it with `tulip-wa plugins`, then
`tulip-wa call bookings lookup --arg ref=4411` — or the `plugin` tool, which
does the same.

## Security

The plugins directory is mounted into the **bridge only**. The agent has no
path to it, so nothing a conversation says can become a plugin action — the
threat model's control on outbound destinations is unaffected.

A callable plugin is reached the same way the browser is: the agent asks the
bridge, and the bridge writes the call. What the agent can express is a plugin
that is enabled, an action its manifest lists, and argument names that action
declares — by default only on an operator's turn. The plugin's own credentials
never enter the bridge or the agent; its answer is read with the same care as
anything else from that directory and shown to the agent as data. A plugin can
do only what its own service implements.

What a plugin is trusted with is exactly its grant. It is the one sender whose
recipient is written in the request rather than taken from a turn, which is
acceptable because it is a process the operator chose to run on the host — and
bounded because a plugin that misbehaves still reaches only the recipients it
was given, only in the kinds it was given, at the rate it was given.

Files are opened with `O_NOFOLLOW` and checked to be regular files, and a
plugin directory that is itself a symbolic link is ignored: a link planted there
would otherwise be resolved inside the bridge, where `/state` holds the WhatsApp
credentials. The directory must be writable by uid 1000, since the bridge writes
receipts into it.

See THREAT-MODEL.md §T9.
