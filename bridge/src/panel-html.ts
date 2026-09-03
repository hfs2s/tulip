/**
 * The panel's page and script, as strings.
 *
 * ── The design, and why ──────────────────────────────────────────────────────
 *
 * One operator, usually on a phone, usually looking because something feels
 * wrong. So the hero is not a number: it is a plain-language verdict —
 * "Answering people." or "Not answering — the agent is out of credit." — set
 * large enough to read across a room. Everything else is quiet around it.
 *
 * The one structural idea: **material encodes affordance.** Surfaces you press
 * are neumorphic — extruded from the ground with a light and a dark shadow, and
 * genuinely depressed (shadows inverted to inset) while held. Surfaces you read
 * are glass — translucent, blurred, floating above the colour behind. Nothing is
 * both. A glance tells you what you can act on before you have read a word.
 *
 * Neumorphism's known weakness is contrast, so it is confined to *surfaces*:
 * every piece of text sits at a normal contrast ratio against its background,
 * and the soft shadow language does the work of separating planes.
 *
 * ── Two rules that make it safe to display strangers' messages ───────────────
 *
 *   - **Nothing is ever assigned to `innerHTML`.** Every value from the API
 *     reaches the DOM through `textContent`, so a message containing
 *     `<img onerror=…>` is displayed as those characters and never parsed as
 *     markup. This is the actual defence; the CSP is the backstop for a slip.
 *   - **The script is a separate resource, not inline.** That lets the CSP say
 *     `script-src 'self'` rather than `'unsafe-inline'`, which is the difference
 *     between a policy that stops injected script and one that looks like it.
 *
 * No external fonts, images or stylesheets: the CSP forbids them, and every
 * visual here is a gradient or a shadow, which is what the style wants anyway.
 */

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tulip</title>
<style>
  :root {
    /* The ground. In neumorphism the surface and the background are the same
       colour — shapes are extruded from the page, not laid on top of it. */
    --ground: #e8e4ef;
    --ground-lit: #f6f3fa;
    --ground-dim: #c5bfd6;

    /* Blooms behind the glass. Without something vivid back there, a frosted
       panel is just a grey box. */
    --bloom-a: #f0a8c0;
    --bloom-b: #9fb8e8;

    --ink: #2c2740;
    --ink-soft: #6b6486;
    --ink-faint: #918ba8;

    /* Stem green for answering, deep rose for stopped. Both drawn from the
       flower rather than from a framework's success/danger pair. */
    --stem: #3d8168;
    --alarm: #b04a61;

    --glass: rgba(255, 255, 255, 0.42);
    --glass-edge: rgba(255, 255, 255, 0.65);
    --glass-shadow: rgba(58, 44, 82, 0.10);

    --lift: -5px -5px 11px var(--ground-lit), 5px 5px 11px var(--ground-dim);
    --lift-sm: -3px -3px 7px var(--ground-lit), 3px 3px 7px var(--ground-dim);
    --press: inset -3px -3px 7px var(--ground-lit), inset 3px 3px 7px var(--ground-dim);

    --r-lg: 26px;
    --r-md: 18px;
    --r-sm: 12px;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #221f2f;
      --ground-lit: #2e2a3f;
      --ground-dim: #16141f;
      --bloom-a: #8e3f60;
      --bloom-b: #35507f;
      --ink: #efecf7;
      --ink-soft: #b3acc8;
      --ink-faint: #837c9c;
      --stem: #6fc79f;
      --alarm: #ef8ba0;
      --glass: rgba(60, 54, 82, 0.44);
      --glass-edge: rgba(255, 255, 255, 0.12);
      --glass-shadow: rgba(0, 0, 0, 0.30);
    }
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    background: var(--ground);
    color: var(--ink);
    font: 400 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }

  /* The colour the glass is made of. Fixed, so panels drift over it on scroll. */
  .bloom {
    position: fixed;
    inset: 0;
    z-index: -1;
    overflow: hidden;
  }
  .bloom::before, .bloom::after {
    content: "";
    position: absolute;
    width: 62vmax;
    height: 62vmax;
    border-radius: 50%;
    filter: blur(70px);
    opacity: 0.5;
  }
  .bloom::before { background: var(--bloom-a); top: -22vmax; right: -14vmax; }
  .bloom::after  { background: var(--bloom-b); bottom: -26vmax; left: -18vmax; }

  .shell { max-width: 1080px; margin: 0 auto; padding: 22px 20px 56px; }

  /* ── Header ─────────────────────────────────────────────────────────────── */
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 26px;
  }
  .mark {
    font-size: 21px;
    font-weight: 640;
    letter-spacing: -0.015em;
    margin: 0;
  }
  .mark span { color: var(--alarm); }
  .reach {
    font-size: 13px;
    color: var(--ink-soft);
    margin-right: auto;
  }

  /* ── The verdict: the one thing worth reading from across a room ────────── */
  .verdict {
    background: var(--glass);
    border: 1px solid var(--glass-edge);
    border-radius: var(--r-lg);
    backdrop-filter: blur(22px) saturate(150%);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    box-shadow: 0 10px 34px var(--glass-shadow);
    padding: 30px 30px 28px;
    margin-bottom: 18px;
  }
  .headline {
    font-size: clamp(27px, 5.2vw, 40px);
    line-height: 1.16;
    font-weight: 620;
    letter-spacing: -0.025em;
    margin: 0 0 6px;
    color: var(--stem);
    transition: color .2s ease;
  }
  .headline.stopped { color: var(--alarm); }
  .subhead {
    font-size: 15px;
    color: var(--ink-soft);
    margin: 0;
    max-width: 54ch;
  }

  /* ── Counts: pressed wells, because they are readouts, not buttons ───────
     They sit on the bare ground, not inside a glass card. A neumorphic shape
     is *extruded from its background*, so putting one on a translucent panel
     breaks the premise and it flattens into a plain rectangle — which is what
     happened when these lived inside the verdict card. */
  .counts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 13px;
    margin-bottom: 20px;
  }
  .count {
    background: var(--ground);
    border-radius: var(--r-md);
    box-shadow: var(--press);
    padding: 15px 12px 13px;
    text-align: center;
  }
  .count b {
    display: block;
    font-size: 25px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .count small {
    display: block;
    margin-top: 3px;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .count.flag b { color: var(--alarm); }

  /* ── Controls: extruded, and they really depress ────────────────────────── */
  .controls { display: flex; gap: 11px; flex-wrap: wrap; }
  button {
    font: inherit;
    font-size: 14.5px;
    font-weight: 550;
    color: var(--ink);
    background: var(--ground);
    border: 0;
    border-radius: var(--r-sm);
    box-shadow: var(--lift-sm);
    padding: 10px 18px;
    cursor: pointer;
    transition: box-shadow .14s ease, color .14s ease;
  }
  button:hover { color: var(--alarm); }
  button:active, button[aria-pressed="true"] { box-shadow: var(--press); }
  button:focus-visible { outline: 2px solid var(--alarm); outline-offset: 3px; }
  button.small { font-size: 13px; padding: 7px 13px; }

  /* ── Reading surfaces ───────────────────────────────────────────────────── */
  .panels {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 20px;
  }
  @media (max-width: 860px) { .panels { grid-template-columns: minmax(0, 1fr); } }

  section {
    background: var(--glass);
    border: 1px solid var(--glass-edge);
    border-radius: var(--r-lg);
    backdrop-filter: blur(22px) saturate(150%);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    box-shadow: 0 10px 34px var(--glass-shadow);
    padding: 22px 24px 20px;
    min-width: 0;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0 0 4px;
  }
  .hint { font-size: 13px; color: var(--ink-faint); margin: 0 0 16px; }

  /* Conversations */
  .chat {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 0;
    border-top: 1px solid var(--glass-edge);
  }
  .chat:first-of-type { border-top: 0; }
  .chat-main { min-width: 0; flex: 1; }
  .chat-name {
    font-weight: 540;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chat-meta { font-size: 12.5px; color: var(--ink-faint); }
  /* Monospace only here: comparing two 16-character keys is the actual task,
     and alignment is what makes that possible. */
  .key {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .blocked .chat-name { color: var(--alarm); }

  /* Stream */
  .stream { max-height: 460px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
  .line {
    display: grid;
    grid-template-columns: 52px 1fr;
    gap: 12px;
    padding: 9px 0;
    border-top: 1px solid var(--glass-edge);
  }
  .line:first-child { border-top: 0; }
  .when { font-size: 12.5px; color: var(--ink-faint); padding-top: 1px; }
  .what { min-width: 0; overflow-wrap: anywhere; }
  .who { font-weight: 540; }
  .said { white-space: pre-wrap; }
  .line.refused .said { color: var(--ink-faint); }
  .why { font-size: 12.5px; color: var(--alarm); }
  .line.sent .who { color: var(--stem); }

  .empty { color: var(--ink-faint); padding: 18px 0; }
  footer { margin-top: 22px; font-size: 12.5px; color: var(--ink-faint); }

  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
</style>
</head>
<body>
  <div class="bloom"></div>
  <div class="shell">
    <header>
      <h1 class="mark">Tulip<span>.</span></h1>
      <p class="reach" id="reach">Checking…</p>
      <div class="controls">
        <button id="hold" type="button">Hold delivery</button>
        <button id="release" type="button">Resume</button>
      </div>
    </header>

    <div class="verdict">
      <p class="headline" id="headline">Connecting…</p>
      <p class="subhead" id="subhead">Reading the bridge's state.</p>
    </div>

    <div class="counts">
      <div class="count"><b id="c-in">–</b><small>received</small></div>
      <div class="count"><b id="c-answered">–</b><small>answered</small></div>
      <div class="count flag"><b id="c-refused">–</b><small>refused</small></div>
      <div class="count"><b id="c-sent">–</b><small>sent</small></div>
      <div class="count"><b id="c-waiting">–</b><small>waiting</small></div>
    </div>

    <div class="panels">
      <section>
        <h2>Conversations</h2>
        <p class="hint">Each one is a separate session. They cannot see each other.</p>
        <div id="chats"><p class="empty">Nobody has messaged yet.</p></div>
      </section>

      <section>
        <h2>What's happening</h2>
        <p class="hint">Every message that arrives, including the ones turned away.</p>
        <div class="stream" id="stream"><p class="empty">Nothing yet.</p></div>
      </section>
    </div>

    <footer id="foot">Connecting…</footer>
  </div>
  <script src="/panel.js"></script>
</body>
</html>
`;

export const PANEL_JS = `'use strict';
// Every value from the API reaches the DOM through textContent. Message text is
// written by strangers; assigning it to innerHTML anywhere here would make this
// page the softest target in the deployment.

function el(id) { return document.getElementById(id); }
function set(id, value) { var n = el(id); if (n) n.textContent = value; }

function ago(ms) {
  var s = Math.round(ms / 1000);
  if (s < 60) return s + ' seconds ago';
  var m = Math.round(s / 60);
  if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  var h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  var d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function node(tag, className, text) {
  var n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

async function act(action, key) {
  var url = '/api/action/' + encodeURIComponent(action) + (key ? '?key=' + encodeURIComponent(key) : '');
  try {
    var res = await fetch(url, { method: 'POST' });
    var body = await res.json();
    if (!body.ok) set('foot', body.message);
  } catch (err) {
    set('foot', 'That did not go through. ' + err.message);
    return;
  }
  refresh();
}

/**
 * The verdict. One sentence, in the order an operator needs it: stopped for a
 * reason they must fix, stopped because they asked, or working.
 */
function verdict(s) {
  var head = el('headline');
  var stopped = true;

  if (!s.whatsapp.connected) {
    head.textContent = 'Not answering — WhatsApp is disconnected.';
    set('subhead', 'The bridge is reconnecting on its own. If this persists, the number may have been unlinked.');
  } else if (s.agent.fatal) {
    head.textContent = 'Not answering — ' + s.agent.fatal + '.';
    set('subhead', 'Only you can clear this. Messages keep arriving and are recorded meanwhile.');
  } else if (!s.agent.reporting) {
    head.textContent = 'Not answering — the agent is silent.';
    set('subhead', 'Its container may be down or restarting. Nothing is lost; messages queue until it returns.');
  } else if (s.hold.active) {
    head.textContent = 'Holding.';
    set('subhead', s.queue.queued
      ? s.queue.queued + ' message' + (s.queue.queued === 1 ? '' : 's') + ' waiting. Resume to hand them over.'
      : 'Nothing waiting. New messages will queue rather than reach the agent.');
  } else {
    stopped = false;
    head.textContent = 'Answering people.';
    var open = s.agent.sessions;
    set('subhead', open === 0
      ? 'Idle and listening. Nobody is mid-conversation.'
      : open + ' conversation' + (open === 1 ? '' : 's') + ' open right now.');
  }

  head.classList.toggle('stopped', stopped);
  el('hold').setAttribute('aria-pressed', s.hold.active ? 'true' : 'false');
}

function renderChats(chats, now) {
  var box = el('chats');
  box.textContent = '';
  if (!chats.length) {
    box.appendChild(node('p', 'empty', 'Nobody has messaged yet.'));
    return;
  }
  chats.forEach(function (c) {
    var row = node('div', 'chat' + (c.blocked ? ' blocked' : ''));
    var main = node('div', 'chat-main');
    main.appendChild(node('div', 'chat-name',
      (c.name || 'Someone') + (c.isGroup ? ' (group)' : '') + (c.blocked ? ' — blocked' : '')));

    var meta = node('div', 'chat-meta');
    meta.appendChild(node('span', 'key', c.chatKey));
    meta.appendChild(node('span', null, '  ' + c.messages + ' messages, '
      + c.turnsToday + ' answered today, last ' + ago(now - c.lastSeenAt)));
    main.appendChild(meta);
    row.appendChild(main);

    var button = node('button', 'small', c.blocked ? 'Unblock' : 'Block');
    button.type = 'button';
    button.addEventListener('click', function () { act(c.blocked ? 'unblock' : 'block', c.chatKey); });
    row.appendChild(button);
    box.appendChild(row);
  });
}

function lineFor(e) {
  var kind = e.kind === 'in' ? (e.accepted ? 'in' : 'refused') : e.kind;
  var row = node('div', 'line ' + (kind === 'out' ? 'sent' : kind));
  row.appendChild(node('div', 'when', new Date(e.ts).toTimeString().slice(0, 5)));

  var what = node('div', 'what');
  if (e.kind === 'event') {
    what.appendChild(node('span', 'who', e.event || 'event'));
    if (e.detail) what.appendChild(node('div', 'said', e.detail));
  } else if (e.kind === 'delivered') {
    what.appendChild(node('div', 'said',
      'Handed over ' + e.count + ' message' + (e.count === 1 ? '' : 's') + '.'));
  } else if (e.kind === 'out') {
    what.appendChild(node('span', 'who', 'Tulip replied'));
    if (e.text) what.appendChild(node('div', 'said', e.text));
  } else {
    what.appendChild(node('span', 'who', e.chatName || e.from || 'Someone'));
    if (e.text) what.appendChild(node('div', 'said', e.text));
    if (e.reason) what.appendChild(node('div', 'why', 'Turned away: ' + e.reason));
  }
  row.appendChild(what);
  return row;
}

async function refresh() {
  var res;
  try {
    res = await fetch('/api/state');
  } catch (err) {
    set('foot', 'Lost contact with the bridge. Retrying.');
    return;
  }
  if (!res.ok) { set('foot', 'The bridge answered ' + res.status + '.'); return; }
  var s = await res.json();

  verdict(s);
  set('reach', s.audience.everyone ? 'Open to anyone' : 'Open to a set list');
  set('c-in', s.today.in);
  set('c-answered', s.today.accepted);
  set('c-refused', s.today.refused);
  set('c-sent', s.today.out);
  set('c-waiting', s.queue.queued);
  renderChats(s.chats, s.now);
  set('foot', 'Last checked ' + new Date(s.now).toTimeString().slice(0, 8) + '. Counts cover the last 24 hours.');
}

async function loadStream() {
  var res = await fetch('/api/feed?n=120');
  if (!res.ok) return;
  var rows = await res.json();
  var box = el('stream');
  box.textContent = '';
  if (!rows.length) { box.appendChild(node('p', 'empty', 'Nothing yet.')); return; }
  rows.reverse().forEach(function (e) { box.appendChild(lineFor(e)); });
}

el('hold').addEventListener('click', function () { act('hold'); });
el('release').addEventListener('click', function () { act('release'); });

var stream = new EventSource('/api/stream');
stream.onmessage = function (event) {
  var box = el('stream');
  var first = box.firstChild;
  if (first && first.className === 'empty') box.textContent = '';
  box.insertBefore(lineFor(JSON.parse(event.data)), box.firstChild);
  while (box.childNodes.length > 200) box.removeChild(box.lastChild);
};

refresh();
loadStream();
setInterval(refresh, 5000);
`;
