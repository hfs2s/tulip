/**
 * The panel's page and script, as strings.
 *
 * Two rules hold throughout, and together they are why the panel can safely
 * display text written by strangers:
 *
 *   - **Nothing is ever assigned to `innerHTML`.** Every value from the API
 *     reaches the DOM through `textContent`, so a message containing
 *     `<img onerror=…>` is displayed as those characters and is never parsed as
 *     markup. This is the actual defence; the CSP is the backstop for a mistake.
 *   - **The script is a separate resource, not inline.** That lets the CSP say
 *     `script-src 'self'` rather than `'unsafe-inline'`, which is the
 *     difference between a policy that stops injected script and one that
 *     merely looks like it does.
 */

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tulip</title>
<style>
  :root {
    --bg: #14121a; --panel: #1d1a25; --line: #2f2a3d; --ink: #ece9f3;
    --dim: #9c93b3; --accent: #d98cb3; --ok: #7fd6a2; --warn: #f0c674; --bad: #ef7a85;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
    padding: 16px 20px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font-size: 17px; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  .public { font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
    border: 1px solid var(--warn); color: var(--warn); border-radius: 999px; padding: 2px 9px; }
  main { display: grid; gap: 16px; padding: 16px 20px; max-width: 1180px;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  section h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: .13em;
    text-transform: uppercase; color: var(--dim); font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
  .row span:last-child { color: var(--dim); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .wide { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--dim); font-weight: 600; padding: 5px 8px 5px 0; }
  td { padding: 5px 8px 5px 0; border-top: 1px solid var(--line); vertical-align: top; }
  .key { color: var(--accent); }
  .feed { max-height: 420px; overflow-y: auto; }
  .entry { border-top: 1px solid var(--line); padding: 7px 0; display: grid;
    grid-template-columns: 60px 74px 1fr; gap: 10px; }
  .entry:first-child { border-top: 0; }
  .at { color: var(--dim); font-size: 12px; }
  .tag { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
  .text { overflow-wrap: anywhere; white-space: pre-wrap; }
  .reason { color: var(--dim); font-style: italic; }
  button { font: inherit; background: transparent; color: var(--ink);
    border: 1px solid var(--line); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  footer { color: var(--dim); padding: 4px 20px 24px; font-size: 12px; }
</style>
</head>
<body>
  <header>
    <h1>Tulip</h1>
    <span id="audience" class="public" hidden>public</span>
    <span id="held" class="public" hidden>delivery held</span>
  </header>
  <main>
    <section>
      <h2>State</h2>
      <div class="row"><span>WhatsApp</span><span id="wa">—</span></div>
      <div class="row"><span>Agent</span><span id="agent">—</span></div>
      <div class="row"><span>Live sessions</span><span id="sessions">—</span></div>
      <div class="row"><span>Answering</span><span id="inflight">—</span></div>
      <div class="controls">
        <button id="hold">Hold</button>
        <button id="release">Release</button>
      </div>
    </section>
    <section>
      <h2>Last 24 hours</h2>
      <div class="row"><span>Received</span><span id="t-in">—</span></div>
      <div class="row"><span>Answered</span><span id="t-accepted">—</span></div>
      <div class="row"><span>Refused</span><span id="t-refused">—</span></div>
      <div class="row"><span>Sent</span><span id="t-out">—</span></div>
      <div class="row"><span>Queued</span><span id="t-queued">—</span></div>
    </section>
    <section class="wide">
      <h2>Chats</h2>
      <table>
        <thead><tr><th>Key</th><th>Name</th><th>Msgs</th><th>Turns today</th><th>Last seen</th><th></th></tr></thead>
        <tbody id="chats"></tbody>
      </table>
    </section>
    <section class="wide">
      <h2>Messages</h2>
      <div class="feed" id="feed"></div>
    </section>
  </main>
  <footer id="foot">connecting…</footer>
  <script src="/panel.js"></script>
</body>
</html>
`;

export const PANEL_JS = `'use strict';
// Every value from the API reaches the DOM through textContent. Message text is
// written by strangers; assigning it to innerHTML anywhere here would make the
// panel the softest target in the deployment.

function text(id, value, className) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  if (className !== undefined) el.className = className;
}

function ago(ms) {
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

function cell(row, value, className) {
  var td = document.createElement('td');
  td.textContent = value;
  if (className) td.className = className;
  row.appendChild(td);
  return td;
}

async function act(action, key) {
  var url = '/api/action/' + encodeURIComponent(action) + (key ? '?key=' + encodeURIComponent(key) : '');
  try {
    await fetch(url, { method: 'POST' });
  } catch (err) {
    text('foot', 'action failed: ' + err.message);
    return;
  }
  refresh();
}

function renderChats(chats, now) {
  var body = document.getElementById('chats');
  body.textContent = '';
  chats.forEach(function (c) {
    var row = document.createElement('tr');
    cell(row, c.chatKey, 'key');
    cell(row, (c.name || '(unnamed)') + (c.isGroup ? ' (group)' : '') + (c.blocked ? ' — blocked' : ''));
    cell(row, String(c.messages));
    cell(row, String(c.turnsToday));
    cell(row, ago(now - c.lastSeenAt));
    var actions = document.createElement('td');
    var button = document.createElement('button');
    button.textContent = c.blocked ? 'Unblock' : 'Block';
    button.addEventListener('click', function () { act(c.blocked ? 'unblock' : 'block', c.chatKey); });
    actions.appendChild(button);
    row.appendChild(actions);
    body.appendChild(row);
  });
}

function entryNode(e) {
  var node = document.createElement('div');
  node.className = 'entry';

  var at = document.createElement('div');
  at.className = 'at';
  at.textContent = new Date(e.ts).toISOString().slice(11, 19);
  node.appendChild(at);

  var tag = document.createElement('div');
  tag.className = 'tag ' + (e.kind === 'out' ? 'ok' : e.kind === 'in' ? (e.accepted ? '' : 'warn') : 'warn');
  tag.textContent = e.kind === 'in' ? (e.accepted ? 'in' : 'refused') : e.kind;
  node.appendChild(tag);

  var body = document.createElement('div');
  body.className = 'text';
  if (e.kind === 'event') {
    body.textContent = (e.event || '') + (e.detail ? ' — ' + e.detail : '');
  } else if (e.kind === 'delivered') {
    body.textContent = e.chatKey + ' · ' + e.count + ' message(s) handed over';
  } else {
    body.textContent = (e.chatName || e.chatKey || '') + ': ' + (e.text || '');
    if (e.reason) {
      var why = document.createElement('div');
      why.className = 'reason';
      why.textContent = e.reason;
      body.appendChild(why);
    }
  }
  node.appendChild(body);
  return node;
}

async function refresh() {
  var res;
  try {
    res = await fetch('/api/state');
  } catch (err) {
    text('foot', 'disconnected');
    return;
  }
  if (!res.ok) { text('foot', 'panel returned ' + res.status); return; }
  var s = await res.json();

  text('wa', s.whatsapp.connected ? 'connected' + (s.whatsapp.name ? ' — ' + s.whatsapp.name : '') : 'disconnected',
       s.whatsapp.connected ? 'ok' : 'bad');
  text('agent', s.agent.fatal ? s.agent.fatal : s.agent.reporting ? (s.agent.busyTurn ? 'working' : 'idle') : 'not reporting',
       s.agent.fatal ? 'bad' : s.agent.reporting ? 'ok' : 'warn');
  text('sessions', String(s.agent.sessions));
  text('inflight', s.queue.inFlight || 'nothing');

  text('t-in', String(s.today.in));
  text('t-accepted', String(s.today.accepted));
  text('t-refused', String(s.today.refused));
  text('t-out', String(s.today.out));
  text('t-queued', String(s.queue.queued));

  document.getElementById('audience').hidden = !s.audience.everyone;
  document.getElementById('held').hidden = !s.hold.active;

  renderChats(s.chats, s.now);
  text('foot', 'updated ' + new Date(s.now).toISOString().slice(11, 19) + ' UTC');
}

async function loadFeed() {
  var res = await fetch('/api/feed?n=120');
  if (!res.ok) return;
  var rows = await res.json();
  var feed = document.getElementById('feed');
  feed.textContent = '';
  rows.reverse().forEach(function (e) { feed.appendChild(entryNode(e)); });
}

document.getElementById('hold').addEventListener('click', function () { act('hold'); });
document.getElementById('release').addEventListener('click', function () { act('release'); });

var stream = new EventSource('/api/stream');
stream.onmessage = function (event) {
  var feed = document.getElementById('feed');
  feed.insertBefore(entryNode(JSON.parse(event.data)), feed.firstChild);
  while (feed.childNodes.length > 200) feed.removeChild(feed.lastChild);
};

refresh();
loadFeed();
setInterval(refresh, 5000);
`;
