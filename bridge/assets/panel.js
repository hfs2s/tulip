'use strict';
// Every value from the API reaches the DOM through textContent. Message text is
// written by strangers; assigning it to innerHTML anywhere here would make this
// page the softest target in the deployment. The one exception is the inline SVG
// for nav icons, which is a fixed literal defined in this file and never data.

var state = null;
var route = 'overview';
var feedFilter = 'all';
var chatQuery = '';
var termWindow = null;
var termTimer = null;

function el(id) { return document.getElementById(id); }
function node(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
function hhmm(ts) { return new Date(ts).toTimeString().slice(0, 5); }
function ago(ms) {
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's ago';
  var m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  var h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function bytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

var toastTimer = null;
function toast(message) {
  var t = el('toast');
  t.textContent = message;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
}

async function api(path, options) {
  var res = await fetch(path, options);
  if (!res.ok) throw new Error('the bridge answered ' + res.status);
  return res.json();
}
async function act(action, key) {
  try {
    var body = await api('/api/action/' + encodeURIComponent(action) + (key ? '?key=' + encodeURIComponent(key) : ''), { method: 'POST' });
    toast(body.message || 'Done.');
  } catch (err) { toast(err.message); return; }
  refresh();
}

// ── Navigation ──────────────────────────────────────────────────────────────
// Icons are a fixed literal in this file. They are the only markup assigned as
// HTML anywhere on the page, and they never contain a value from the API.
var ICONS = {
  overview: '<path d="M3.5 18a8.5 8.5 0 1 1 17 0"/><path d="M12 18l4.4-5.6"/>',
  messages: '<path d="M20 4H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3v4l5-4h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"/>',
  chats: '<path d="M16.2 12.5H18a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H7.6a1 1 0 0 0-1 1v1.4"/><path d="M13 7.8H4.6a1 1 0 0 0-1 1v6.6a1 1 0 0 0 1 1H6v3.1l3.9-3.1H13a1 1 0 0 0 1-1V8.8a1 1 0 0 0-1-1z"/>',
  media: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.6" cy="9.9" r="1.4"/><path d="M3.5 16.2l4.4-3.9 3.6 3.1 3-2.6 6 4.9"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 0 5 5L15 16l-3 3-4-4 3-3z"/><path d="M6 18l1.5-1.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M12.5 15h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"/>',
  log: '<path d="M6 4.5h9l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M14.5 4.5v4.5H19"/><path d="M8.5 13h7M8.5 16.5h5"/>'
};
var PAGES = [
  ['overview', 'Overview'], ['messages', 'Messages'], ['chats', 'Chats'], ['media', 'Media'],
  ['tools', 'Tools'], ['terminal', 'Terminal'], ['settings', 'Settings'], ['log', 'Log']
];

function buildNav() {
  var nav = clear(el('nav'));
  PAGES.forEach(function (p) {
    var b = node('button', 'nav');
    b.type = 'button';
    b.dataset.route = p[0];
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = ICONS[p[0]];
    b.appendChild(svg);
    b.appendChild(node('span', null, p[1]));
    if (p[0] === 'chats') { var c = node('span', 'count', '0'); c.id = 'navChats'; b.appendChild(c); }
    b.addEventListener('click', function () { go(p[0]); });
    nav.appendChild(b);
  });
}

function go(next) {
  route = next;
  if (location.hash !== '#/' + next) location.hash = '#/' + next;
  PAGES.forEach(function (p) {
    var page = el('p-' + p[0]);
    if (p[0] === route) { page.classList.add('on'); page.classList.remove('reveal'); void page.offsetWidth; page.classList.add('reveal'); }
    else page.classList.remove('on');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (b) {
    if (b.dataset.route === route) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (route === 'terminal') startTerminal(); else stopTerminal();
  window.scrollTo(0, 0);
  render();
}

// ── Masthead verdict ────────────────────────────────────────────────────────
function verdict(s) {
  var h = el('headline'), stopped = true, lede;
  if (!s.whatsapp.connected) {
    h.textContent = 'Not answering — WhatsApp is disconnected.';
    lede = 'The bridge reconnects on its own. If this persists, the number may have been unlinked.';
  } else if (s.agent.fatal) {
    h.textContent = 'Not answering — ' + s.agent.fatal + '.';
    lede = 'Only you can clear this. Messages keep arriving and are recorded meanwhile.';
  } else if (!s.agent.reporting) {
    h.textContent = 'Not answering — the agent is silent.';
    lede = 'Its container may be down or restarting. Nothing is lost; messages queue until it returns.';
  } else if (s.hold.active) {
    h.textContent = 'Holding.';
    lede = s.queue.queued ? plural(s.queue.queued, 'message') + ' waiting. Resume to hand them over.'
                          : 'Nothing waiting. New messages queue rather than reach the agent.';
  } else {
    stopped = false;
    h.textContent = 'Answering people.';
    lede = s.agent.sessions === 0 ? 'Idle and listening. Nobody is mid-conversation.'
         : plural(s.agent.sessions, 'conversation') + ' open right now.';
  }
  h.className = stopped ? 'stopped' : '';
  el('lede').textContent = lede;
  el('whoami').textContent = s.whatsapp.name || 'not paired';
  el('railfoot').textContent = (s.audience.everyone ? 'Open to anyone' : 'Allow list only')
    + (s.audience.groups ? ' · groups ' + s.audience.groupMode : ' · groups off');
  var badge = el('navChats');
  if (badge) badge.textContent = String(s.chats.length);
}

// ── Pages ───────────────────────────────────────────────────────────────────
function head(page, title, sub) {
  var p = clear(el('p-' + page));
  p.appendChild(node('h2', null, title));
  p.appendChild(node('p', 'sub', sub));
  return p;
}

function renderOverview(s) {
  var p = head('overview', 'Overview', 'What has happened in the last twenty-four hours.');
  var stats = node('div', 'stats');
  [['in', s.today.in, 'received', ''], ['accepted', s.today.accepted, 'answered', 'accent'],
   ['refused', s.today.refused, 'refused', s.today.refused ? 'bad' : ''],
   ['out', s.today.out, 'sent', ''], ['queued', s.queue.queued, 'waiting', '']
  ].forEach(function (row) {
    var d = node('div', 'stat' + (row[3] ? ' ' + row[3] : ''));
    d.appendChild(node('b', null, row[1]));
    d.appendChild(node('small', null, row[2]));
    stats.appendChild(d);
  });
  p.appendChild(stats);

  var card = node('div', 'card');
  card.appendChild(node('h2', null, 'Delivery'));
  card.appendChild(node('p', 'sub', 'Holding keeps receiving and recording; the agent simply sees nothing until you resume.'));
  var controls = node('div', 'controls');
  var hold = node('button', s.hold.active ? '' : 'primary', s.hold.active ? 'Holding' : 'Hold delivery');
  hold.type = 'button';
  hold.disabled = s.hold.active;
  hold.addEventListener('click', function () { act('hold'); });
  var release = node('button', s.hold.active ? 'primary' : '', 'Resume');
  release.type = 'button';
  release.disabled = !s.hold.active;
  release.addEventListener('click', function () { act('release'); });
  controls.appendChild(hold); controls.appendChild(release);
  card.appendChild(controls);
  p.appendChild(card);
}

function lineFor(e) {
  var kind = e.kind === 'in' ? (e.accepted ? 'in' : 'refused') : e.kind;
  var row = node('div', 'line');
  row.appendChild(node('div', 'when', hhmm(e.ts)));
  row.appendChild(node('div', 'tag ' + kind, kind === 'out' ? 'Tulip' : kind === 'in' ? 'received' : kind));
  var body = node('div', 'said');
  if (e.kind === 'event') body.textContent = (e.event || 'event') + (e.detail ? ' — ' + e.detail : '');
  else if (e.kind === 'delivered') body.textContent = 'Handed over ' + plural(e.count, 'message') + '.';
  else body.textContent = (e.chatName || e.from || 'Someone') + ': ' + (e.text || '');
  var wrap = node('div');
  wrap.appendChild(body);
  if (e.reason) wrap.appendChild(node('div', 'why', 'Turned away: ' + e.reason));
  row.appendChild(wrap);
  return row;
}

async function renderMessages() {
  var p = head('messages', 'Messages', 'Every message that arrives, including the ones turned away. A silently dropped message is indistinguishable from one that never came.');
  var controls = node('div', 'controls');
  var seg = node('div', 'seg');
  [['all', 'All'], ['in', 'Received'], ['refused', 'Refused'], ['out', 'Sent']].forEach(function (f) {
    var b = node('button', null, f[1]);
    b.type = 'button';
    b.setAttribute('aria-pressed', feedFilter === f[0] ? 'true' : 'false');
    b.addEventListener('click', function () { feedFilter = f[0]; renderMessages(); });
    seg.appendChild(b);
  });
  controls.appendChild(seg);
  p.appendChild(controls);

  var card = node('div', 'card');
  p.appendChild(card);
  var rows;
  try { rows = await api('/api/feed?n=250'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  var shown = rows.filter(function (e) {
    if (feedFilter === 'all') return true;
    if (feedFilter === 'in') return e.kind === 'in' && e.accepted;
    if (feedFilter === 'refused') return e.kind === 'in' && !e.accepted;
    return e.kind === 'out';
  }).reverse();
  if (!shown.length) { card.appendChild(node('p', 'empty', 'Nothing here yet.')); return; }
  shown.forEach(function (e) { card.appendChild(lineFor(e)); });
}

function renderChats(s) {
  var p = head('chats', 'Chats', 'Each conversation runs as its own Claude Code session. They cannot see one another.');
  var controls = node('div', 'controls');
  var search = node('input', 'search');
  search.type = 'search';
  search.placeholder = 'Filter by name or key';
  search.value = chatQuery;
  search.addEventListener('input', function () { chatQuery = search.value; renderChats(state); });
  controls.appendChild(search);
  p.appendChild(controls);

  var card = node('div', 'card');
  var q = chatQuery.trim().toLowerCase();
  var list = s.chats.filter(function (c) {
    return !q || (c.name || '').toLowerCase().indexOf(q) >= 0 || c.chatKey.indexOf(q) >= 0;
  });
  if (!list.length) { card.appendChild(node('p', 'empty', 'Nobody has messaged yet.')); p.appendChild(card); return; }

  var table = document.createElement('table');
  var thead = document.createElement('tr');
  ['Name', 'Key', 'Messages', 'Turns today', 'Last seen', ''].forEach(function (h) {
    thead.appendChild(node('th', null, h));
  });
  table.appendChild(thead);
  list.forEach(function (c) {
    var tr = document.createElement('tr');
    tr.appendChild(node('td', null, (c.name || 'Someone') + (c.isGroup ? ' (group)' : '') + (c.blocked ? ' — blocked' : '')));
    tr.appendChild(node('td', 'key', c.chatKey));
    tr.appendChild(node('td', null, c.messages));
    tr.appendChild(node('td', null, c.turnsToday));
    tr.appendChild(node('td', 'muted', ago(s.now - c.lastSeenAt)));
    var td = document.createElement('td');
    var b = node('button', 'sm' + (c.blocked ? '' : ' danger'), c.blocked ? 'Unblock' : 'Block');
    b.type = 'button';
    b.addEventListener('click', function () { act(c.blocked ? 'unblock' : 'block', c.chatKey); });
    td.appendChild(b);
    tr.appendChild(td);
    table.appendChild(tr);
  });
  card.appendChild(table);
  p.appendChild(card);
}

async function renderMedia() {
  var p = head('media', 'Media', 'Everything people have sent. Files are served from the bridge and never leave it.');
  var card = node('div', 'card');
  p.appendChild(card);
  var data;
  try { data = await api('/api/media/list?n=200'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  if (!data.items.length) { card.appendChild(node('p', 'empty', 'No attachments yet.')); return; }
  var grid = node('div', 'grid');
  data.items.forEach(function (m) {
    var tile = node('div', 'tile');
    var src = '/api/media?key=' + encodeURIComponent(m.chatKey) + '&name=' + encodeURIComponent(m.name);
    if (m.kind === 'image') { var img = document.createElement('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; tile.appendChild(img); }
    else if (m.kind === 'video') { var v = document.createElement('video'); v.src = src; v.controls = true; tile.appendChild(v); }
    else if (m.kind === 'audio') { var a = document.createElement('audio'); a.src = src; a.controls = true; a.style.width = '100%'; tile.appendChild(a); }
    else tile.appendChild(node('div', 'none', m.kind));
    tile.appendChild(node('div', 'meta', (m.chatName || m.chatKey) + ' · ' + bytes(m.bytes)));
    grid.appendChild(tile);
  });
  card.appendChild(grid);
}

function renderTools() {
  var p = head('tools', 'Tools', 'Maintenance actions. None of these change who the agent answers — that lives in a file on disk.');
  var card = node('div', 'card');
  [['pump', 'Kick delivery', 'Re-runs the delivery loop if something looks stuck.', ''],
   ['hold', 'Hold delivery', 'Stop handing messages over. They keep arriving and are recorded.', ''],
   ['release', 'Resume delivery', 'Hand over everything that queued while held.', '']
  ].forEach(function (t) {
    var row = node('div', 'toolrow');
    var left = node('div');
    left.appendChild(node('div', null, t[1]));
    left.appendChild(node('div', 'hint', t[2]));
    row.appendChild(left);
    var b = node('button', 'sm', 'Run');
    b.type = 'button';
    b.addEventListener('click', function () { act(t[0]); });
    row.appendChild(b);
    card.appendChild(row);
  });
  p.appendChild(card);
}

// ── Terminal ────────────────────────────────────────────────────────────────
function renderTerminal() {
  var p = head('terminal', 'Terminal', 'The agent’s live session. This is a pane view with key injection, not a shell on the host.');

  var warn = node('div', 'warnbar', 'Anything you type goes into a live conversation with a member of the public.');
  p.appendChild(warn);

  var controls = node('div', 'controls');
  var select = document.createElement('select');
  select.id = 'termWindows';
  select.addEventListener('change', function () { termWindow = select.value || null; pollTerminal(); });
  controls.appendChild(select);

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'search';
  input.id = 'termInput';
  input.placeholder = 'Type a line and press Enter to send it into the session';
  input.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var text = input.value;
    if (!text) return;
    sendKeys([{ text: text, literal: true }]);
    input.value = '';
  });
  controls.appendChild(input);

  ['Enter', 'Escape', 'C-c'].forEach(function (k) {
    var b = node('button', 'sm', k);
    b.type = 'button';
    b.addEventListener('click', function () { sendKeys([{ text: k === 'Escape' ? 'Escape' : k, literal: false }]); });
    controls.appendChild(b);
  });
  p.appendChild(controls);

  var slab = node('div', 'slab', 'Waiting for the agent to publish a frame…');
  slab.id = 'termSlab';
  p.appendChild(slab);
}

async function sendKeys(keys) {
  try {
    await api('/api/terminal/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: termWindow, keys: keys })
    });
    toast('Sent.');
  } catch (err) { toast(err.message); }
  setTimeout(pollTerminal, 600);
}

async function pollTerminal() {
  if (route !== 'terminal') return;
  try {
    await api('/api/terminal/watch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: termWindow })
    });
    var screen = await api('/api/terminal');
    var slab = el('termSlab');
    if (slab) slab.textContent = screen.content || '(no session is running)';
    var select = el('termWindows');
    if (select && screen.windows) {
      var want = screen.windows.join('|');
      if (select.dataset.have !== want) {
        select.dataset.have = want;
        clear(select);
        screen.windows.forEach(function (w) {
          var o = document.createElement('option');
          o.value = w; o.textContent = w;
          select.appendChild(o);
        });
        if (screen.window) select.value = screen.window;
      }
    }
    if (!termWindow && screen.window) termWindow = screen.window;
  } catch (err) { /* the agent may be restarting */ }
}
function startTerminal() { stopTerminal(); pollTerminal(); termTimer = setInterval(pollTerminal, 2000); }
function stopTerminal() { if (termTimer) clearInterval(termTimer); termTimer = null; }

// ── Settings ────────────────────────────────────────────────────────────────
function field(parent, name, hint, control) {
  var row = node('div', 'field');
  var left = node('div');
  left.appendChild(node('div', null, name));
  if (hint) left.appendChild(node('div', 'hint', hint));
  row.appendChild(left);
  row.appendChild(control);
  parent.appendChild(row);
  return row;
}
function readOnlySwitch(on) {
  var label = node('label', 'switch');
  var input = document.createElement('input');
  input.type = 'checkbox'; input.checked = !!on; input.disabled = true;
  label.appendChild(input);
  label.appendChild(node('span', 'track'));
  return label;
}

async function renderSettings() {
  var p = head('settings', 'Settings', 'What this deployment is configured to do. Read-only on purpose: who may talk to the agent is decided by a file on disk, which removes the whole class of "the panel was reachable and someone changed the allowlist".');
  var s;
  try { s = await api('/api/settings'); } catch (err) { p.appendChild(node('p', 'empty', err.message)); return; }

  var audience = node('div', 'card');
  audience.appendChild(node('h2', null, 'Audience'));
  audience.appendChild(node('p', 'sub', 'Edit config.json on the host and restart the bridge to change any of this.'));
  field(audience, 'Open to anyone', 'When on, every inbound message is untrusted input to an agent holding a shell.', readOnlySwitch(s.audience.everyone));
  field(audience, 'Allow list', 'Numbers and linked ids permitted when not open to everyone.', node('span', 'value', plural(s.audience.numbers, 'number') + ', ' + plural(s.audience.jids, 'linked id')));
  field(audience, 'Operators', 'Who may run ! commands and receives alerts. Never widened by the switch above.', node('span', 'value', plural(s.operators.numbers, 'number') + ', ' + plural(s.operators.jids, 'linked id')));
  field(audience, 'Groups', 'Groups do not consult the allow list — being in the room is the consent signal.', readOnlySwitch(s.groups.enabled));
  field(audience, 'Group mode', 'observe delivers every message; mention only when addressed.', node('span', 'value', s.groups.replyTo));
  p.appendChild(audience);

  var limits = node('div', 'card');
  limits.appendChild(node('h2', null, 'Limits'));
  limits.appendChild(node('p', 'sub', 'Turns are the expensive unit — each is a model call.'));
  [['messagesPerHour', 'Messages per hour', 1000], ['burst', 'Burst', 50],
   ['turnsPerDay', 'Turns per day', 200], ['outboundPerTurn', 'Sends per turn', 100]
  ].forEach(function (row) {
    var wrap = node('div');
    wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.gap = '12px';
    var range = document.createElement('input');
    range.type = 'range'; range.className = 'range'; range.disabled = true;
    range.min = '0'; range.max = String(row[2]); range.value = String(s.limits[row[0]]);
    wrap.appendChild(range);
    wrap.appendChild(node('span', 'value', s.limits[row[0]]));
    field(limits, row[1], null, wrap);
  });
  p.appendChild(limits);

  var tools = node('div', 'card');
  tools.appendChild(node('h2', null, 'Capabilities'));
  tools.appendChild(node('p', 'sub', 'Web search and GIFs are performed by the bridge, so their keys never enter the agent container.'));
  field(tools, 'Web search', 'Exa. Read docs/THREAT-MODEL.md T6 before enabling.', readOnlySwitch(s.tools.search));
  field(tools, 'GIFs', 'Giphy, rating ' + s.tools.gifRating + '.', readOnlySwitch(s.tools.gifs));
  field(tools, 'Model', 'What answers people.', node('span', 'value', s.model.name));
  field(tools, 'Provider', 'Where inference goes.', node('span', 'value', s.model.provider));
  p.appendChild(tools);
}

async function renderLog() {
  var p = head('log', 'Log', 'The bridge’s structured events for today. Credentials are masked before writing.');
  var card = node('div', 'card');
  p.appendChild(card);
  var rows;
  try { rows = await api('/api/logs?n=250'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  if (!rows.length) { card.appendChild(node('p', 'empty', 'Nothing logged yet today.')); return; }
  rows.reverse().forEach(function (r) {
    var line = node('div', 'logline');
    line.appendChild(node('b', null, (r.at || '').slice(11, 19) + '  '));
    var rest = Object.keys(r).filter(function (k) { return k !== 'at' && k !== 'event'; })
      .map(function (k) { return k + '=' + (typeof r[k] === 'string' ? r[k] : JSON.stringify(r[k])); }).join(' ');
    line.appendChild(document.createTextNode((r.event || '') + '  ' + rest));
    card.appendChild(line);
  });
}

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
  if (!state) return;
  if (route === 'overview') renderOverview(state);
  else if (route === 'messages') renderMessages();
  else if (route === 'chats') renderChats(state);
  else if (route === 'media') renderMedia();
  else if (route === 'tools') renderTools();
  else if (route === 'terminal') renderTerminal();
  else if (route === 'settings') renderSettings();
  else if (route === 'log') renderLog();
}

async function refresh() {
  try { state = await api('/api/state'); } catch (err) { el('lede').textContent = 'Lost contact with the bridge. Retrying.'; return; }
  verdict(state);
  if (route === 'overview' || route === 'chats') render();
}

// ── Shader backdrop ─────────────────────────────────────────────────────────
// Optional by design: the bundle is vendored at image build time and is simply
// absent in a development tree, so this is wrapped rather than assumed. The
// library already pauses itself when the tab is hidden.
function mountShader() {
  try {
    if (typeof PaperShaders === 'undefined' || !PaperShaders.ShaderMount) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var host = el('shader');
    var sizing = PaperShaders.defaultPatternSizing || {};
    var uniforms = Object.assign({}, sizing, {
      u_colorBack: [0.051, 0.051, 0.059, 1],
      u_colors: [[0.13, 0.82, 0.93, 1], [0.08, 0.28, 0.36, 1], [0.05, 0.05, 0.06, 1]],
      u_colorsCount: 3,
      u_softness: 0.9,
      u_intensity: 0.32,
      u_noise: 0.28,
      u_shape: 3,
      u_scale: 0.7
    });
    new PaperShaders.ShaderMount(host, PaperShaders.grainGradientFragmentShader, uniforms, undefined, 0.14);
  } catch (err) { /* a backdrop is never worth a broken page */ }
}

// ── Boot ────────────────────────────────────────────────────────────────────
buildNav();
mountShader();
go((location.hash || '#/overview').replace('#/', '') || 'overview');
window.addEventListener('hashchange', function () { go((location.hash || '#/overview').replace('#/', '')); });

var stream = new EventSource('/api/stream');
stream.onmessage = function () { if (route === 'messages') renderMessages(); };

refresh();
setInterval(refresh, 5000);
