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
var booted = false;

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
/**
 * The only success and failure surface on this page.
 *
 * `urgent` switches it from polite to assertive, because a failed write is not
 * something to mention when the reader next pauses — and it holds for longer,
 * since a failure usually carries a sentence rather than a word.
 */
function toast(message, urgent) {
  var t = el('toast');
  t.textContent = message;
  t.setAttribute('role', urgent ? 'alert' : 'status');
  t.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('on'); }, urgent ? 6000 : 2600);
}

/**
 * A call to the bridge.
 *
 * The body is read whatever the status, because the interesting failures carry
 * one. Every refusal on this surface answers `{ ok: false, message }` with a
 * 400, so throwing on `!res.ok` before parsing reduced "config.json is not
 * valid JSON, so nothing was changed" — the one sentence that tells an operator
 * the truth about a failed write — to "the bridge answered 400".
 */
async function api(path, options) {
  var res = await fetch(path, options);
  var body = null;
  try { body = await res.json(); } catch (err) { /* not JSON: keep the status */ }
  if (!res.ok) {
    var failure = new Error((body && body.message) || 'the bridge answered ' + res.status);
    failure.body = body;
    throw failure;
  }
  return body;
}
async function act(action, key) {
  try {
    var body = await api('/api/action/' + encodeURIComponent(action) + (key ? '?key=' + encodeURIComponent(key) : ''), { method: 'POST' });
    toast(body.message || 'Done.');
  } catch (err) { toast(err.message, true); return; }
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
  ['terminal', 'Terminal'], ['settings', 'Settings'], ['log', 'Log']
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

/**
 * The mobile disclosure.
 *
 * One piece of state, expressed in three places that must agree: the panel's
 * class, the scrim's, and `aria-expanded` on the control. Driving all three
 * from one function is what stops them drifting — a menu whose button says
 * "collapsed" while the panel is open is worse for a screen reader than no
 * menu, because it is confidently wrong.
 */
function setNav(open) {
  var rail = el('rail'), scrim = el('navScrim'), toggle = el('navToggle');
  if (!rail || !toggle) return;
  rail.classList.toggle('open', open);
  if (scrim) { scrim.classList.toggle('open', open); scrim.hidden = !open; }
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.setAttribute('aria-label', open ? 'Hide pages' : 'Show pages');
  // Stops the document scrolling under the scrim: a swipe that began on the
  // backdrop was moving the page rather than the menu.
  document.body.classList.toggle('nav-open', open);
}

function navIsOpen() {
  var toggle = el('navToggle');
  return !!toggle && toggle.getAttribute('aria-expanded') === 'true';
}

function wireNavToggle() {
  var toggle = el('navToggle'), scrim = el('navScrim');
  if (!toggle) return;
  toggle.addEventListener('click', function () { setNav(!navIsOpen()); });
  if (scrim) scrim.addEventListener('click', function () { setNav(false); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && navIsOpen()) { setNav(false); toggle.focus(); }
  });
  // Leaving mobile with the panel open would otherwise strand the state: the
  // rail becomes a column again and `.open` means nothing, but `aria-expanded`
  // would still claim a menu is showing.
  window.addEventListener('resize', function () {
    if (window.innerWidth > 900 && navIsOpen()) setNav(false);
  });
}

function go(next) {
  route = next;
  if (location.hash !== '#/' + next) location.hash = '#/' + next;
  // Choosing a page is the end of the menu's job.
  setNav(false);
  var crumb = el('topbarPage');
  if (crumb) {
    for (var i = 0; i < PAGES.length; i++) {
      if (PAGES[i][0] === next) { crumb.textContent = PAGES[i][1]; break; }
    }
  }
  PAGES.forEach(function (p) {
    var page = el('p-' + p[0]);
    if (p[0] === route) { page.classList.add('on'); page.classList.remove('reveal'); void page.offsetWidth; page.classList.add('reveal'); }
    else page.classList.remove('on');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.nav'), function (b) {
    if (b.dataset.route === route) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  // The terminal page has no chrome of its own, so the wrapper's padding goes
  // too and the emulator fills what is left of the window.
  var wrap = document.querySelector('.page-wrap');
  if (route !== 'terminal') stopTerminal();
  var scroller = document.querySelector('main');
  if (scroller) scroller.scrollTop = 0;
  render();
}

/**
 * Reconcile the chrome with the bridge's state.
 *
 * There is no status banner: the page shows the page, and whether the bot is
 * answering is carried by the dot beside the persona's name in the rail. That
 * dot distinguishes online, replying, holding, offline and a fatal session, and
 * names the state in text beside it — so nothing here is only a colour.
 *
 * What a banner used to add was the sentence after the state: which container to
 * restart, how many messages are queued. That now lives where it is acted on
 * rather than announced — the Overview page's counters, and the Tools page's
 * hold and resume — which is a page away rather than in front of every page.
 */
function verdict(s) {
  el('whoami').textContent = s.whatsapp.name || 'not paired';
  agentStatus(s);
  var badge = el('navChats');
  if (badge) badge.textContent = String(s.chats.length);
}

/**
 * Whether the agent is there, and what it is doing.
 *
 * Read in the order that a person cares about, which is not the order the
 * fields arrive in: the states that mean "nobody is being answered" come first,
 * and the difference between them matters. A silent agent is a container that
 * needs restarting; a fatal state is a session that accepts input, looks
 * perfectly healthy, and fails every turn instantly — the failure this whole
 * deployment learned the expensive way, so it does not get to share a colour
 * with "idle".
 *
 * Holding is amber rather than red because nothing is broken: somebody turned
 * delivery off on purpose, and messages are queueing safely.
 */
function agentStatus(s) {
  var dot = el('agentDot');
  var label = el('agentState');
  if (!dot || !label) return;

  var state;
  if (!s.whatsapp.connected) state = ['down', 'WhatsApp disconnected'];
  else if (s.agent.fatal) state = ['down', 'needs you'];
  else if (!s.agent.reporting) state = ['down', 'offline'];
  else if (s.hold.active) state = ['busy', 'holding'];
  else if (s.agent.busyTurn || s.queue.inFlight) state = ['busy', 'replying'];
  else state = ['live', 'online'];

  dot.className = 'dot ' + state[0];
  label.textContent = state[1];
  // The colour is the glance; the title is what makes it answerable to anyone
  // who cannot use colour to tell three states apart.
  dot.setAttribute('title', 'Agent: ' + state[1]);
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', 'Agent status: ' + state[1]);
}

// ── Pages ───────────────────────────────────────────────────────────────────
/** So a failing poll reports once rather than every few seconds. */
var lostContact = false;

var renderToken = 0;
/**
 * Begin a page render, and take a number.
 *
 * The token used to be stored on the page element and compared back against
 * the global. That cannot tell two overlapping renders of the *same* page
 * apart: the second overwrote the first's token on the shared element, both
 * then compared equal to the global, and both appended their cards. Leaving
 * Settings and coming straight back — or double-tapping it, which is easy on a
 * phone — reliably produced three copies of all six cards.
 *
 * The caller keeps its own token instead, so only the newest render matches.
 */
function head(page, title, sub) {
  var p = clear(el('p-' + page));
  p.appendChild(node('h2', null, title));
  p.appendChild(node('p', 'sub', sub));
  ++renderToken;
  return p;
}
/** Has another render started since the one holding this token began? */
function stale(token) { return token !== renderToken; }

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

  p.appendChild(usageCard(s.usage));
}

/** Compact token counts, e.g. 1.2M / 431k / 940. */
function tokens(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

/**
 * Token spend over three rolling windows.
 *
 * Cache reads are shown apart from input rather than folded in. They are the
 * bulk of the count on any long session and they are billed differently, so a
 * single total makes a mostly-cached day look like a runaway one.
 */
function usageCard(u) {
  var card = node('div', 'card');
  card.appendChild(node('h2', null, 'Token usage'));

  if (!u) {
    card.appendChild(node('p', 'sub', 'The agent has not reported yet. Counts appear within a minute of it starting.'));
    return card;
  }

  card.appendChild(node('p', 'sub', 'Counted from the agent\u2019s own sessions. Rolling windows, not calendar periods.'));

  var table = document.createElement('table');
  var head = document.createElement('tr');
  ['', 'Total', 'In', 'Out', 'Cache write', 'Cache read', 'Replies'].forEach(function (h) {
    var th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);

  [['Last hour', u.hour], ['Last 24 hours', u.day], ['Last 7 days', u.week]].forEach(function (row) {
    var w = row[1];
    var total = w.input + w.output + w.cacheWrite + w.cacheRead;
    var tr = document.createElement('tr');
    [row[0], tokens(total), tokens(w.input), tokens(w.output), tokens(w.cacheWrite), tokens(w.cacheRead), String(w.replies)]
      .forEach(function (v, i) {
        var td = document.createElement('td');
        td.textContent = v;
        if (i === 1) td.className = 'value';
        else if (i > 1) td.className = 'muted';
        tr.appendChild(td);
      });
    table.appendChild(tr);
  });

  var wrap = node('div');
  wrap.style.overflowX = 'auto';
  wrap.appendChild(table);
  card.appendChild(wrap);

  if (u.models && u.models.length) {
    card.appendChild(node('p', 'hint', u.models.map(function (m) {
      return m.name + ' \u00b7 ' + tokens(m.tokens);
    }).join('   ')));
  }
  return card;
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
  var p = head('messages', 'Messages', 'Every message that arrives, including the ones turned away. A silently dropped message is indistinguishable from one that never came.'), mine = renderToken;
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
  if (stale(mine)) return;
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
    tr.appendChild(node('td', null, (c.name || 'Someone') + (c.isGroup ? ' (group)' : '') + (c.contact ? ' — contact' : '') + (c.blocked ? ' — blocked' : '')));
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
  // The same wrapper the usage table gets. Without it this table is 415px wide
  // inside a 350px card and every ancestor up to `main` is `overflow-x:
  // visible`, so the *document* scrolls sideways instead — putting the Block
  // button 56px past the right edge of a 390px screen, reachable only by
  // discovering the page scrolls at all, and dragging the sticky bar off with
  // it on the way.
  var scroller = node('div');
  scroller.style.overflowX = 'auto';
  scroller.appendChild(table);
  card.appendChild(scroller);
  p.appendChild(card);
}

async function renderMedia() {
  var p = head('media', 'Media', 'Every attachment, both directions — what people sent Juan, and what he sent them. Files are served from the bridge and never leave it. Copies of what Juan sent are kept for 14 days; what people sent stays as long as its conversation does.'), mine = renderToken;
  var card = node('div', 'card');
  p.appendChild(card);
  var data;
  try { data = await api('/api/media/list?n=200'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(mine)) return;
  if (!data.items.length) { card.appendChild(node('p', 'empty', 'No attachments yet.')); return; }

  // Audio is not a picture and does not belong in a picture grid. A voice note
  // has no thumbnail, so a square tile shows a player floating in empty space —
  // and, now that they are transcribed, the words are the part worth reading.
  // They get full-width rows; everything with a visual gets the grid.
  var sound = data.items.filter(function (m) { return m.kind === 'audio'; });
  var seen = data.items.filter(function (m) { return m.kind !== 'audio'; });

  // Pictures first: they identify themselves at a glance, which is what a
  // gallery is for. Sound cannot, so it goes underneath as a list you read
  // rather than a wall you scrub through.
  if (seen.length) {
    if (sound.length) card.appendChild(node('h3', 'subhead', 'Pictures and video'));
    var grid = node('div', 'grid');
    seen.forEach(function (m) { grid.appendChild(mediaTile(m)); });
    card.appendChild(grid);
  }
  if (sound.length) {
    card.appendChild(node('h3', 'subhead', sound.length === 1 ? 'Voice note' : 'Voice notes'));
    var voices = node('div', 'voicegrid');
    sound.forEach(function (m) { voices.appendChild(voiceCard(m)); });
    card.appendChild(voices);
  }
}

function mediaSrc(m) {
  return '/api/media?key=' + encodeURIComponent(m.chatKey)
    + '&name=' + encodeURIComponent(m.name)
    + '&dir=' + encodeURIComponent(m.direction || 'in');
}

/** Which way it went, which is the first thing to know about an attachment. */
function directionTag(m) {
  var sent = m.direction === 'out';
  return node('span', 'tag' + (sent ? ' sent' : ''), sent ? 'Juan sent' : 'received');
}

function mediaTile(m) {
  var tile = node('div', 'tile');
  var src = mediaSrc(m);
  if (m.kind === 'image') { var img = document.createElement('img'); img.src = src; img.alt = ''; img.loading = 'lazy'; tile.appendChild(img); }
  else if (m.kind === 'video') { var v = document.createElement('video'); v.src = src; v.controls = true; tile.appendChild(v); }
  else tile.appendChild(node('div', 'none', m.kind));
  tile.appendChild(directionTag(m));
  tile.appendChild(node('div', 'meta', (m.chatName || m.chatKey) + ' · ' + bytes(m.bytes)));
  tile.appendChild(binButton(m));
  return tile;
}

/**
 * One voice note, closed by default.
 *
 * A player per recording meant a column of identical transport bars, none of
 * which said anything until you played it — the slowest possible way to find
 * out whether any of them mattered. The transcript is the recording, in the
 * form you can read: the card leads with it, and the audio is what you open
 * when the words are not enough.
 *
 * The `<audio>` is built on first open rather than up front. Two hundred of
 * them on a page is two hundred media elements the browser has to keep, for
 * something almost none of which will be played.
 */
function voiceCard(m) {
  var card = node('div', 'voice');

  var toggle = node('button', 'voice-open');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');

  var head = node('div', 'voice-head');
  head.appendChild(node('span', 'who', m.chatName || m.chatKey));
  head.appendChild(directionTag(m));
  head.appendChild(node('span', 'meta', bytes(m.bytes)));
  toggle.appendChild(head);

  if (m.transcript) toggle.appendChild(node('blockquote', 'said', m.transcript));
  else toggle.appendChild(node('div', 'said none', 'No transcript — either transcription was off when this arrived, or it failed.'));
  card.appendChild(toggle);

  var slot = node('div', 'voice-player');
  slot.hidden = true;
  card.appendChild(slot);

  toggle.addEventListener('click', function () {
    var open = toggle.getAttribute('aria-expanded') === 'true';
    if (!open && slot.childNodes.length === 0) {
      var player = document.createElement('audio');
      player.src = mediaSrc(m);
      player.controls = true;
      player.preload = 'metadata';
      slot.appendChild(player);
    }
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    slot.hidden = open;
    if (!open) {
      var el = slot.querySelector('audio');
      if (el) void el.play().catch(function () { /* the operator can press play */ });
    }
  });

  // Outside the button: a delete control nested inside a toggle is a mis-tap
  // waiting to happen, and the browser will not allow a button in a button.
  var foot = node('div', 'voice-foot');
  foot.appendChild(binButton(m));
  card.appendChild(foot);
  return card;
}

/**
 * Delete, behind a confirm.
 *
 * The confirm is not politeness. There is no trash, nothing keeps a copy, and
 * the thing being removed is a message somebody sent — so a mis-tap is
 * unrecoverable and the dialog says so in those words.
 */
function binButton(m) {
  var b = node('button', 'bin', '🗑');
  b.type = 'button';
  b.title = 'Delete this attachment';
  b.setAttribute('aria-label', 'Delete this attachment from ' + (m.chatName || m.chatKey));
  b.addEventListener('click', function (ev) {
    ev.stopPropagation();
    openModal('Delete this attachment?', 'It is removed from disk and cannot be recovered.', function (body, modal, dismiss) {
      body.appendChild(node('p', 'hint', (m.chatName || m.chatKey) + ' · ' + m.kind + ' · ' + bytes(m.bytes)
        + (m.transcript ? '\n\n“' + m.transcript + '”' : '')));
      var actions = node('div', 'modal-actions');
      var cancel = node('button', 'sm', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', dismiss);
      var go = node('button', 'sm danger', 'Delete');
      go.type = 'button';
      go.addEventListener('click', async function () {
        go.disabled = true;
        try {
          var r = await api('/api/media/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: m.chatKey, name: m.name, dir: m.direction || 'in' })
          });
          toast(r.message || 'Deleted.');
          dismiss();
          renderMedia();
        } catch (err) { go.disabled = false; toast(err.message); }
      });
      actions.appendChild(cancel);
      actions.appendChild(go);
      body.appendChild(actions);
    });
  });
  return b;
}

// ── Terminal ────────────────────────────────────────────────────────────────
// A real terminal emulator over the agent's pane, not a rendering of it.
//
// What was here before parsed the pane into semantic lines and repainted every
// two seconds from a stripped-text snapshot. It was readable, and it was never
// the session: a TUI is a stream of cursor movements, so a poll of plain text
// can only ever show a summary of one, always a beat behind and never quite in
// the state the agent was actually in.
//
// Now the agent streams the pane's own bytes and xterm.js renders them, which
// is what Iris gets from ttyd — with the difference that no socket and no
// network path exists between the two containers. The bytes travel the same way
// everything else does, over the handoff volume.

var term = null;
var termStream = null;
var termFit = null;

/** The pane's fixed grid. Pinned in agent/src/tmux.ts; never reflowed here. */
var TERM_COLS = 200;
var TERM_ROWS = 50;

/**
 * Keystrokes, in tmux's terms.
 *
 * xterm hands over what a terminal would send down a pty. tmux wants either
 * literal text or a key *name*, so the control bytes are translated and
 * anything printable is passed through as text. Enter is a key rather than a
 * newline in the text: `send-keys -l` with a newline would type one, where the
 * TUI is watching for the key.
 */
var TERM_KEYS = {
  '\r': 'Enter', '\n': 'Enter', '\t': 'Tab', '\x7f': 'BSpace', '\x1b': 'Escape',
  '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
  '\x1b[H': 'Home', '\x1b[F': 'End', '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown',
  '\x1b[3~': 'DC'
};

function termKeyFor(data) {
  if (TERM_KEYS[data]) return { text: TERM_KEYS[data], literal: false };
  // A lone control character: C-a through C-z, and the handful above them.
  if (data.length === 1 && data.charCodeAt(0) < 0x20) {
    var code = data.charCodeAt(0);
    if (code >= 1 && code <= 26) return { text: 'C-' + String.fromCharCode(96 + code), literal: false };
    return null;
  }
  // Everything else is text, including a paste — one entry, not one per
  // character, so a long paste costs a single slot in the bridge's key window.
  return { text: data, literal: true };
}

/**
 * Size the type to the pane rather than the pane to the window.
 *
 * Reflowing would be the usual thing to do and is exactly what must not happen:
 * the supervisor parses this pane to tell whether a turn is running, so the
 * grid stays 200x50 and the font shrinks to fit it. The 0.6 is a monospace
 * advance ratio — close enough for every stack in the font list, and the host
 * scrolls if a face turns out to be wider.
 */
function fitTerminal() {
  var host = el('termHost');
  if (!host || !term) return;
  var width = host.clientWidth - 20;
  if (width <= 0) return;
  var size = Math.max(5, Math.min(16, Math.floor(width / TERM_COLS / 0.6)));
  if (term.options.fontSize !== size) term.options.fontSize = size;
}

/**
 * The terminal, as a launcher and a modal.
 *
 * Inline, it was a frame in a column: the tmux status bar competed with the
 * page's own chrome, and every pixel the panel used was a pixel the session did
 * not get. A terminal wants the whole window, and this is a page you visit to
 * look at one thing.
 *
 * So the page says what is running and opens it full-bleed. Ported from the
 * hfs2s workspace terminal, which solved this already; the skin is the only
 * part that is new.
 */
function renderTerminal() {
  var page = el('p-terminal');
  if (page.dataset.built === '1') { paintTerminalState(); return; }
  clear(page);
  page.dataset.built = '1';

  var card = node('div', 'card');
  card.appendChild(node('h2', null, 'Terminal'));
  card.appendChild(node('p', 'sub', 'The agent’s live tmux session — the real thing, not a picture of it. Anything typed goes into a conversation with a member of the public.'));

  var row = node('div', 'termlaunch');
  var open = node('button', 'primary', 'Open terminal');
  open.type = 'button';
  open.addEventListener('click', openTerminal);
  row.appendChild(open);
  row.appendChild(node('span', 'termstate', ''));
  card.appendChild(row);
  page.appendChild(card);
  paintTerminalState();
}

/** Whether there is anything to attach to, said plainly rather than implied. */
function paintTerminalState() {
  var label = document.querySelector('#p-terminal .termstate');
  if (!label || !state) return;
  var n = state.agent.sessions;
  label.textContent = !state.agent.reporting
    ? 'The agent is not reporting — the window will be empty.'
    : n === 0
      ? 'No chat has a session open right now. A window appears when one gets a message.'
      : plural(n, 'conversation') + ' open.';
}

/**
 * The terminal, full-bleed.
 *
 * The controls float over the frame because xterm paints to a canvas: the
 * browser's own selection, copy and paste have nothing to attach to, so each
 * button here is a workaround for something that genuinely does not work rather
 * than a convenience. Same-origin is what makes them possible at all — the
 * proxy is why this page can reach into the frame and talk to xterm directly.
 */
function openTerminal() {
  var opener = document.activeElement;
  var stage = node('div', 'termstage');
  stage.setAttribute('role', 'dialog');
  stage.setAttribute('aria-modal', 'true');
  stage.setAttribute('aria-label', 'The agent’s terminal');

  var frame = document.createElement('iframe');
  frame.id = 'ptyFrame';
  frame.className = 'ptyframe';
  frame.src = '/pty/';
  frame.title = 'The agent’s terminal';
  // ttyd installs its own "are you sure you want to leave" handler, which turns
  // closing this into a browser prompt. Same-origin, so it can simply go.
  frame.addEventListener('load', function () {
    try { if (frame.contentWindow) frame.contentWindow.onbeforeunload = null; } catch (err) { /* nothing to do */ }
  });
  stage.appendChild(frame);

  /** xterm itself, or null while the frame is still starting. */
  function term() {
    try { return frame.contentWindow && frame.contentWindow.term; } catch (err) { return null; }
  }

  var controls = node('div', 'termcontrols');
  function control(label, glyph, run) {
    var b = node('button', null, glyph);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', run);
    controls.appendChild(b);
    return b;
  }

  control('Copy the selection', '⧉', async function () {
    var t = term();
    var text = t && t.getSelection ? t.getSelection() : '';
    if (!text) { toast('Select something in the terminal first.'); return; }
    try { await navigator.clipboard.writeText(text); toast('Copied.'); }
    catch (err) { toast('The browser would not let me use the clipboard.', true); }
  });

  control('Paste', '⎘', async function () {
    var t = term();
    if (!t || !t.paste) { toast('The terminal is still starting.'); return; }
    try { t.paste(await navigator.clipboard.readText()); }
    catch (err) { toast('The browser would not let me read the clipboard.', true); }
  });

  control('Scroll up', '↑', function () { var t = term(); if (t && t.scrollLines) t.scrollLines(-12); });
  control('Scroll down', '↓', function () { var t = term(); if (t && t.scrollLines) t.scrollLines(12); });
  control('Close', '✕', dismiss);
  stage.appendChild(controls);

  function onKey(ev) {
    // Escape belongs to the terminal — it is how you leave a mode in the TUI —
    // so closing is deliberately a modifier away rather than a keystroke the
    // agent's own interface wants.
    if (ev.key === 'Escape' && (ev.shiftKey || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); dismiss(); }
  }
  function dismiss() {
    document.removeEventListener('keydown', onKey, true);
    stage.remove();
    document.body.classList.remove('term-open');
    if (opener && opener.focus) opener.focus();
  }
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(stage);
  document.body.classList.add('term-open');
  frame.focus();
}

async function sendKeys(keys) {
  try {
    await api('/api/terminal/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: termWindow, keys: keys })
    });
  } catch (err) { toast(err.message); }
}

/**
 * Open the byte stream.
 *
 * `reset` arrives when the agent has repainted — a different chat became
 * active, or the stream file hit its cap — and means the bytes that follow
 * assume a clean screen. Clearing on it is what stops a repaint being drawn
 * over the tail of the previous one.
 */
function openTerminalStream() {
  if (termStream || typeof EventSource !== 'function') return;

  termStream = new EventSource('/api/terminal/stream');
  termStream.addEventListener('reset', function () {
    if (term) term.reset();
  });
  termStream.addEventListener('idle', function () { showTerminal(false); });
  termStream.addEventListener('live', function () { showTerminal(true); });
  termStream.onmessage = function (ev) {
    if (!term || !ev.data) return;
    // base64 because an event stream is line-oriented and a pane emits every
    // byte there is, newlines very much included.
    var raw = atob(ev.data);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    term.write(bytes);
  };
}

/** Swap between the emulator and the note, without disposing either. */
function showTerminal(live) {
  var host = el('termHost'), note = el('termNote');
  if (host) host.hidden = !live;
  if (note) note.hidden = live;
  if (!live || !term) return;
  // The emulator measures nothing while it is display:none, so anything written
  // to it in that state has not been drawn. Re-measure, then repaint.
  fitTerminal();
  term.refresh(0, term.rows - 1);
}

function stopTerminal() {
  if (termStream) { termStream.close(); termStream = null; }
  if (termFit) { window.removeEventListener('resize', termFit); termFit = null; }
  if (term) { term.dispose(); term = null; }
}

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * One labelled row: a name, an optional hint, and the control they describe.
 *
 * The name lives in a sibling element, so nothing connects it to the control
 * unless this function does it. Without that wiring the eight switches on this
 * page all announce as "checkbox, not checked" — including the one that opens a
 * machine holding a shell to the whole internet — and there is no way to tell
 * them apart by ear or by keyboard. A checkbox additionally gets a real
 * `<label for>`, which makes the visible words a hit target rather than
 * decoration next to a 42x24 pixel track.
 */
var fieldSeq = 0;
function field(parent, name, hint, control) {
  var row = node('div', 'field');
  var left = node('div');
  var id = 'fld' + (++fieldSeq);

  var targets = [];
  if (control.matches && control.matches('input,select,button,[role=group]')) targets = [control];
  else if (control.querySelectorAll) {
    targets = Array.prototype.slice.call(control.querySelectorAll('input,select,button,[role=group]'));
  }

  var box = null;
  for (var i = 0; i < targets.length; i++) {
    if (targets[i].type === 'checkbox') { box = targets[i]; break; }
  }
  var title;
  if (box) {
    if (!box.id) box.id = id + 'i';
    title = document.createElement('label');
    title.className = 'field-name';
    title.htmlFor = box.id;
    title.textContent = name;
  } else {
    title = node('div', 'field-name', name);
  }
  title.id = id;
  left.appendChild(title);

  var hintId = null;
  if (hint) {
    var h = node('div', 'hint', hint);
    h.id = hintId = id + 'h';
    left.appendChild(h);
  }
  row.appendChild(left);

  targets.forEach(function (t) {
    if (!t.hasAttribute('aria-label') && !t.hasAttribute('aria-labelledby')) {
      if (t.tagName === 'BUTTON' && t.textContent) {
        // Keep the button's own word: "Allowed numbers, Edit", not either half.
        if (!t.id) t.id = id + 'b' + (++fieldSeq);
        t.setAttribute('aria-labelledby', id + ' ' + t.id);
      } else {
        t.setAttribute('aria-labelledby', id);
      }
    }
    if (hintId && !t.hasAttribute('aria-describedby')) t.setAttribute('aria-describedby', hintId);
  });

  row.appendChild(control);
  parent.appendChild(row);
  return row;
}
function liveSwitch(on, onChange) {
  var label = node('label', 'switch');
  var input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!on;
  input.addEventListener('change', function () { onChange(input.checked, input); });
  label.appendChild(input);
  label.appendChild(node('span', 'track'));
  return label;
}

async function saveSettings(patch, revert) {
  try {
    var body = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!body.ok) { toast(body.message, true); if (revert) revert(); return false; }
    toast(body.message || 'Saved.');
    refresh();
    return true;
  } catch (err) {
    toast(err.message, true);
    if (revert) revert();
    return false;
  }
}

/**
 * A modal.
 *
 * Escape and a backdrop click both close it, focus moves to the first control
 * in the body on open, Tab is confined to the dialog, and focus returns to
 * whatever opened it — a dialog you cannot dismiss from the keyboard is a trap,
 * and one that drops focus on the floor sends a keyboard operator back to the
 * top of the page after every single list edit.
 */
function openModal(title, description, build) {
  var scrim = el('scrim');
  var opener = document.activeElement;
  clear(scrim);

  var modal = node('div', 'modal');
  var head = node('div', 'modal-head');
  var titles = node('div');
  var heading = node('h3', null, title);
  heading.id = 'modalTitle';
  scrim.setAttribute('aria-labelledby', 'modalTitle');
  titles.appendChild(heading);
  if (description) titles.appendChild(node('p', null, description));
  head.appendChild(titles);
  var close = node('button', 'sm', 'Close');
  close.type = 'button';
  head.appendChild(close);
  modal.appendChild(head);

  var body = node('div', 'modal-body');
  modal.appendChild(body);
  scrim.appendChild(modal);
  scrim.classList.add('on');

  // `aria-modal` claims the rest of the page is hidden. `inert` is what makes
  // that true — without it the claim and the tab order disagree.
  var behind = [el('rail'), document.querySelector('main')];
  behind.forEach(function (n) { if (n) n.setAttribute('inert', ''); });

  function dismiss() {
    scrim.classList.remove('on');
    clear(scrim);
    document.removeEventListener('keydown', onKey);
    scrim.removeEventListener('click', onScrim);
    behind.forEach(function (n) { if (n) n.removeAttribute('inert'); });
    if (opener && opener.focus) opener.focus();
  }
  function focusable() {
    return modal.querySelectorAll('input:not([disabled]), button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { dismiss(); return; }
    if (ev.key !== 'Tab') return;
    var f = focusable();
    if (f.length === 0) return;
    var first = f[0];
    var last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  function onScrim(ev) { if (ev.target === scrim) dismiss(); }
  close.addEventListener('click', dismiss);
  scrim.addEventListener('click', onScrim);
  document.addEventListener('keydown', onKey);

  build(body, modal, dismiss);
  // The body, not the head: `modal.querySelector` matches in document order and
  // Close is appended first, so the old version always focused Close.
  var first = body.querySelector('input, button') || close;
  first.focus();
  return dismiss;
}

/**
 * A field that summarises a list and opens it in a modal.
 *
 * Inline editors for five separate lists turned Settings into a column of
 * boxes you had to scroll past to reach anything else. The summary is what an
 * operator reads; the list is what they occasionally change.
 */
function listField(parent, name, hint, values, placeholder, help, onSave, sanitize, opts) {
  opts = opts || {};
  // Per-field, because this editor backs both phone numbers and group trigger
  // words. One shared numeric sanitizer quietly rewrote "call me" to "callme"
  // with no error — the operator saw their trigger accepted and it never fired.
  var clean = sanitize || function (v) { return v.replace(/[^0-9@a-z]/gi, ''); };
  var current = values.slice();
  var summary = node('div', 'summary');
  var count = node('span', 'value');
  var edit = node('button', 'sm', 'Edit');
  edit.type = 'button';

  function label() {
    count.textContent = current.length === 0 ? 'none' : plural(current.length, 'entry', 'entries');
  }
  label();
  summary.appendChild(count);
  summary.appendChild(edit);

  edit.addEventListener('click', function () {
    openModal(name, help, function (body) {
      var list = node('div');

      // The page paints once and is never reconciled, so a tab left open here
      // holds an arbitrarily old list. Saving replaces the array wholesale, so
      // editing from a stale copy would quietly revert every entry added since.
      if (opts.reload) {
        opts.reload().then(function (fresh) {
          if (!fresh || !list.isConnected) return;
          current = fresh.slice();
          paint(); label();
        }, function () { /* keep what we have; the save will still be validated */ });
      }

      function paint() {
        clear(list);
        if (!current.length) list.appendChild(node('p', 'hint', 'Nothing here yet.'));
        current.forEach(function (v, i) {
          var row = node('div', 'entry');
          row.appendChild(node('span', 'value', v));
          var rm = node('button', 'sm danger', 'Remove');
          rm.type = 'button';
          rm.addEventListener('click', function () {
            // Identical buttons, wildly different consequences: removing the
            // last operator entry takes away !hold, !block and every watchdog
            // alert, which is the path you need precisely when something is
            // going wrong. Confirmed only where the loss is categorical.
            if (opts.confirmLast && current.length === 1 && !window.confirm(opts.confirmLast)) return;
            var before = current.slice();
            current = current.slice(0, i).concat(current.slice(i + 1));
            paint(); label();
            onSave(current, function () { current = before; paint(); label(); });
          });
          row.appendChild(rm);
          list.appendChild(row);
        });

        var adder = node('div', 'adder');
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = placeholder;
        var add = node('button', 'primary', 'Add');
        add.type = 'button';
        function commit() {
          var v = clean(input.value.trim());
          if (!v) return;
          if (current.indexOf(v) >= 0) { toast('Already in the list.'); return; }
          var before = current.slice();
          current = current.concat([v]);
          input.value = '';
          paint(); label();
          onSave(current, function () { current = before; paint(); label(); });
        }
        add.addEventListener('click', commit);
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') commit(); });
        adder.appendChild(input);
        adder.appendChild(add);
        list.appendChild(adder);
      }

      paint();
      body.appendChild(list);
    });
  });

  field(parent, name, hint, summary);
}

/**
 * People the agent may write to first.
 *
 * A pair rather than a bare number, because the agent is only ever shown the
 * label — it has no way to see a phone number, and that stays true here. This
 * list is also the only thing that authorises the agent to open a conversation:
 * a WhatsApp message asking it to contact somebody is not evidence of anything,
 * so the operator's list is where the permission actually lives.
 */
function contactsField(parent, values, onSave, ctx) {
  ctx = ctx || {};
  var current = values.slice();
  // Whether a given contact could actually answer. The two lists are separate
  // on purpose — adding a destination must never widen who can reach the agent
  // — but the consequence only ever got stated in one direction, so the
  // operator who correctly concluded "no side effects" was the one who then
  // spent an hour on a one-way conversation.
  function reachable(number) {
    if (!ctx.audience) return true;
    return ctx.audience.everyone || ctx.audience.numbers.indexOf(number) >= 0;
  }
  var summary = node('div', 'summary');
  var count = node('span', 'value');
  var edit = node('button', 'sm', 'Edit');
  edit.type = 'button';

  function label() {
    count.textContent = current.length === 0 ? 'nobody' : plural(current.length, 'contact', 'contacts');
  }
  label();
  summary.appendChild(count);
  summary.appendChild(edit);

  edit.addEventListener('click', function () {
    openModal('Contacts',
      'Somebody here can be messaged first — an introduction, or passing something on. This does not let them message Tulip: that is the Audience list, deliberately separate, so adding a destination can never widen who reaches the agent. If you want them to be able to reply, add their number under Audience as well.',
      function (body) {
        var list = node('div');

        if (ctx.reload) {
          ctx.reload().then(function (fresh) {
            if (!fresh || !list.isConnected) return;
            current = fresh.slice();
            paint(); label();
          }, function () { /* keep what we have */ });
        }

        function save(before) {
          onSave(current.slice(), function () { current = before; paint(); label(); });
        }

        function paint() {
          clear(list);
          if (!current.length) list.appendChild(node('p', 'hint', 'Nobody yet.'));
          current.forEach(function (c, i) {
            var row = node('div', 'entry');
            row.appendChild(node('span', 'value', c.label + ' · +' + c.number));
            if (!reachable(c.number)) {
              row.appendChild(node('span', 'badge off', 'cannot reply — not in Audience'));
            }
            var rm = node('button', 'sm danger', 'Remove');
            rm.type = 'button';
            rm.addEventListener('click', function () {
              var before = current.slice();
              current = current.slice(0, i).concat(current.slice(i + 1));
              paint(); label();
              save(before);
            });
            row.appendChild(rm);
            list.appendChild(row);
          });

          var adder = node('div', 'adder');
          var name = document.createElement('input');
          name.type = 'text';
          name.placeholder = 'Name';
          var number = document.createElement('input');
          number.type = 'text';
          number.placeholder = 'Number, e.g. 15551234567';
          var add = node('button', 'primary', 'Add');
          add.type = 'button';

          function commit() {
            var l = name.value.trim();
            var n = number.value.replace(/[^0-9]/g, '');
            if (!l || !n) { toast('A contact needs a name and a number.'); return; }
            // Refused rather than trimmed: the label is the only thing the
            // agent sees for this person, so a silently shortened one is a
            // person the operator no longer recognises in the transcript.
            if (l.length > 64) { toast('A contact name is limited to 64 characters.'); return; }
            if (n.length < 6) { toast('That number looks too short.'); return; }
            for (var i = 0; i < current.length; i++) {
              if (current[i].number === n) { toast('Already a contact.'); return; }
            }
            var before = current.slice();
            current = current.concat([{ label: l, number: n }]);
            name.value = ''; number.value = '';
            paint(); label();
            save(before);
          }
          add.addEventListener('click', commit);
          function onEnter(ev) { if (ev.key === 'Enter') commit(); }
          name.addEventListener('keydown', onEnter);
          number.addEventListener('keydown', onEnter);

          adder.appendChild(name);
          adder.appendChild(number);
          adder.appendChild(add);
          list.appendChild(adder);
        }

        paint();
        body.appendChild(list);
      });
  });

  var hint = 'The only people Tulip may write to out of the blue. It is shown the name and never the number, so it cannot message anyone who is not on this list — and being asked to, however convincingly, is not the same as being allowed to.';
  if (ctx.crossChat === false) {
    // The dependency was stated on the switch and not here, so a list built
    // with the switch off changed nothing and said nothing.
    hint = 'The only people Tulip may write to out of the blue — but nothing here does anything while “Message other chats” is off. It is shown the name and never the number.';
    summary.insertBefore(node('span', 'badge off', 'not in effect'), summary.firstChild);
  }
  field(parent, 'Contacts', hint, summary);
}

/** 600000 reads as a number. `10m` reads as a length of time. */
function duration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return String(Math.round(ms / 100) / 10).replace(/\.0$/, '') + 's';
  return String(Math.round(ms / 6000) / 10).replace(/\.0$/, '') + 'm';
}

/**
 * A number, as a slider and a box.
 *
 * The slider alone could not express most of these. `turnTimeoutMs` spans 30
 * seconds to an hour across 170 pixels — roughly 20 seconds per pixel — and an
 * unstepped range input moves one millisecond per arrow key, so "set the turn
 * timeout to ten minutes" was not a thing this page could do at all. The box is
 * what makes an exact value reachable; the slider is what makes the range
 * legible; and `format` is what stops the readout being a wall of milliseconds.
 *
 * A value already outside the offered range is shown and refused rather than
 * clamped. Assigning it to the input would silently pin the handle to the
 * boundary while the readout still showed the real number, and the operator's
 * next nudge would write a large reduction they never asked for.
 */
/**
 * A free-text setting, saved when you leave the box.
 *
 * On `change` rather than on every keystroke: a save per character would be a
 * write per character, and half of them would be a value that was never a real
 * setting. Reverts on failure like everything else here, so a rejected value
 * does not sit in the box looking saved.
 */
function textField(value, placeholder, onSave) {
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'textset';
  input.value = value || '';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.addEventListener('change', function () {
    var next = input.value.trim();
    if (next === (value || '')) return;
    var was = value;
    value = next;
    onSave(next, function () { value = was; input.value = was || ''; });
  });
  return input;
}

function numberControl(value, min, max, onSave, opts) {
  opts = opts || {};
  var step = opts.step || 1;
  var format = opts.format || null;
  var outOfRange = value < min || value > max;
  var wrap = node('div', 'numeric');

  var range = document.createElement('input');
  range.type = 'range';
  range.className = 'range';
  range.min = String(min); range.max = String(max); range.step = String(step);
  range.disabled = outOfRange;

  var box = document.createElement('input');
  box.type = 'number';
  box.className = 'numbox';
  box.min = String(min); box.max = String(max);
  // The slider steps coarsely so dragging is usable across an hour of range;
  // the box is the one that has to accept whatever the operator actually means,
  // so it does not inherit that granularity.
  box.step = 'any';
  box.setAttribute('aria-label', 'exact value');

  // Always present, even when there is no unit to show: it holds the third
  // grid column open so the sliders all start and end in the same place down
  // the card, rather than each row sizing itself.
  var out = node('span', 'value unit', '');

  function paint(v) {
    range.value = String(Math.min(max, Math.max(min, v)));
    box.value = String(v);
    if (format) out.textContent = format(v);
    // Announced instead of the bare number, so "10m" reaches a screen reader
    // the same way it reaches the eye.
    range.setAttribute('aria-valuetext', format ? format(v) : String(v));
  }
  paint(value);

  function commit(v) {
    if (!isFinite(v)) { paint(value); return; }
    v = Math.min(max, Math.max(min, Math.round(v)));
    if (v === value) { paint(v); return; }
    var was = value;
    value = v;
    paint(v);
    onSave(v, function () { value = was; paint(was); });
  }

  range.addEventListener('input', function () {
    box.value = range.value;
    if (format) out.textContent = format(Number(range.value));
  });
  range.addEventListener('change', function () { commit(Number(range.value)); });
  box.addEventListener('change', function () { commit(Number(box.value)); });

  wrap.appendChild(range);
  wrap.appendChild(box);
  wrap.appendChild(out);
  if (outOfRange) {
    wrap.appendChild(node('span', 'badge off', 'set to ' + value + ' in config.json, outside this range'));
  }
  return wrap;
}

/** Re-read the server's view, for editors that must not save from a stale copy. */
function freshSettings(pick) {
  return api('/api/settings').then(function (fresh) { return pick(fresh); });
}

async function renderSettings() {
  var p = head('settings', 'Settings', 'What this deployment does. Every change applies the moment you make it, is written to config.json, and is recorded in the log and the feed.'), mine = renderToken;
  var s;
  try { s = await api('/api/settings'); } catch (err) { p.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(mine)) return;

  // "Turn" is the unit half the settings below are counted in, and nobody
  // arrives knowing it. Said once, at the top, rather than in nine hints.
  var primer = node('div', 'card primer');
  primer.appendChild(node('h2', null, 'Before you change anything'));
  primer.appendChild(node('p', 'sub', 'Three words used throughout this page.'));
  [['A turn', 'One reply the agent works on, from reading a message to finishing its answer. It is the expensive unit: each turn is a request to Claude that somebody pays for. Several messages that arrive together are answered in a single turn.'],
   ['A chat', 'One conversation, with one person or one group. Each chat runs as its own separate session, and they cannot see each other.'],
   ['Refused silently', 'When Tulip turns a message away it sends nothing back — no reply, no error. Telling an unknown number that this line is live is itself information, so refusals are invisible from the outside. If somebody says they messaged and got nothing, the Log page is where you find out why.']
  ].forEach(function (row) {
    var d = node('dl', 'define');
    d.appendChild(node('dt', null, row[0]));
    d.appendChild(node('dd', null, row[1]));
    primer.appendChild(d);
  });
  p.appendChild(primer);

  // ── Audience ──────────────────────────────────────────────────────────────
  var audience = node('div', 'card');
  audience.appendChild(node('h2', null, 'Audience'));
  audience.appendChild(node('p', 'sub', 'Who is allowed to message Tulip at all. This is the outermost gate: somebody not on it is refused before the agent is ever asked, and refused silently. Everything else on this page assumes a message got past here.'));

  // Off, with both lists empty, is a legal configuration that answers nobody —
  // and every refusal is silent by design, so from outside it is identical to
  // the bot being down. Said here rather than left to be discovered.
  if (!s.audience.everyone && s.audience.numbers.length === 0 && s.audience.jids.length === 0) {
    var shut = node('div', 'warnbar');
    shut.appendChild(node('strong', null, 'Nobody can reach Tulip.'));
    shut.appendChild(document.createTextNode(' "Open to anyone" is off and both allow lists are empty, so every direct message is refused — silently, as refusals always are.'));
    audience.appendChild(shut);
  }

  field(audience, 'Open to anyone', 'Answer every number that writes in, with no list at all. Worth being deliberate about: it makes every message from a stranger an instruction reaching a machine that runs code. That is what the containment is built for, and it is still a different posture from a short list of people you know.',
    liveSwitch(s.audience.everyone, function (on, input) {
      saveSettings({ audience: { everyone: on } }, function () { input.checked = !on; });
    }));

  listField(audience, 'Allowed numbers', 'The people who may write in. Only used when “Open to anyone” is off.',
    s.audience.numbers, 'e.g. 15551234567',
    'Country code first, then the number, with nothing else: no plus sign, no spaces, no brackets. Written out as +1 (555) 123-4567, it goes in as 15551234567. Each change saves as you make it.',
    function (next, revert) { saveSettings({ audience: { numbers: next } }, revert); },
    null, { reload: function () { return freshSettings(function (f) { return f.audience.numbers; }); } });

  listField(audience, 'Allowed linked ids', 'For people WhatsApp hands over without a phone number. Add one only when a number alone is not working.',
    s.audience.jids, 'e.g. 111111111111111@lid',
    'Newer WhatsApp accounts often arrive as a “linked id” — something like 111111111111111@lid — with no phone number attached, and a list of numbers can never match one. If somebody on your allowed numbers is still being turned away, this is almost always why. Open the Log page, find the gate.deny line from when they tried, and copy the identifier it recorded. It is a copy, not a guess.',
    function (next, revert) { saveSettings({ audience: { jids: next } }, revert); },
    null, { reload: function () { return freshSettings(function (f) { return f.audience.jids; }); } });
  p.appendChild(audience);

  // ── Operators ─────────────────────────────────────────────────────────────
  // A different surface from the audience — who may command the bot, not who
  // may talk to it — and filing them under "Audience" hid them from anyone
  // looking for how to add another admin.
  var ops = node('div', 'card');
  ops.appendChild(node('h2', null, 'Operators'));
  ops.appendChild(node('p', 'sub', 'You, essentially — the numbers that can control Tulip from WhatsApp rather than just talk to it. Send !help from one of them for the list; !hold stops delivery, !block stops one conversation, !status reports what is happening. These commands are handled by the bridge before the agent sees anything, which is the point: you need them precisely when the agent is the problem. This list is never widened by “Open to anyone”.'));

  if (s.operators.numbers.length === 0 && s.operators.jids.length === 0) {
    var noOps = node('div', 'warnbar');
    noOps.appendChild(node('strong', null, 'No operators.'));
    noOps.appendChild(document.createTextNode(' Nobody can hold delivery, block a chat, or be told when something is wrong — including from the phone this account is paired to.'));
    ops.appendChild(noOps);
  }

  var lastOperator = 'Remove the last operator?\n\nYou will have no way to hold delivery, block a chat, or receive watchdog alerts from your phone until you add one back.';

  listField(ops, 'Operator numbers', 'Your own number, in the same bare-digits form as above.',
    s.operators.numbers, 'bare digits',
    'These numbers can hold delivery, block a conversation, reset a chat and ask for status, and they are the ones messaged when something goes wrong. Keep at least one, and keep it a number you actually carry.',
    function (next, revert) { saveSettings({ operators: { numbers: next } }, revert); },
    null, {
      confirmLast: lastOperator,
      reload: function () { return freshSettings(function (f) { return f.operators.numbers; }); },
    });

  listField(ops, 'Operator linked ids', 'The same people, in the form WhatsApp may actually deliver them as.',
    s.operators.jids, 'digits or @lid',
    'Same story as allowed linked ids, and it matters more here: an operator whose commands are silently ignored has no way into their own system. If a ! command does nothing, check the Log for the identifier your message actually arrived with and add it.',
    function (next, revert) { saveSettings({ operators: { jids: next } }, revert); },
    null, {
      confirmLast: lastOperator,
      reload: function () { return freshSettings(function (f) { return f.operators.jids; }); },
    });
  p.appendChild(ops);

  // ── Groups ────────────────────────────────────────────────────────────────
  var groups = node('div', 'card');
  groups.appendChild(node('h2', null, 'Groups'));
  groups.appendChild(node('p', 'sub', 'Group chats work differently from the rest of this page: they do not consult the Audience list. Whoever added Tulip to the room decided who can reach it, so anyone in that group can — including people you have never allowed individually. Turning this on widens the audience independently of everything above.'));
  field(groups, 'Answer in groups', 'Whether Tulip pays attention to group chats at all. Off means group messages are ignored entirely, however Tulip was added to the room.',
    liveSwitch(s.groups.enabled, function (on, input) {
      saveSettings({ groups: { enabled: on } }, function () { input.checked = !on; });
    }));

  // The pressed state is the only feedback this control has, and it used to be
  // painted once and never updated: choosing Observe — the consequential one,
  // which turns every group message into a model call — left Mention
  // highlighted and a `Saved.` toast, so the rational next move was to click
  // again, and again, each one a real config write.
  var modeSeg = node('div', 'seg');
  modeSeg.setAttribute('role', 'group');
  // "Observe" is the config value and a bad label: it reads as passive, as though
  // the agent watches and never speaks, when it is in fact the only mode where
  // the agent gets to use its judgement. An operator read that label, moved off
  // it, and then asked for the mode it describes.
  var modes = [['mention', 'Mentions'], ['trigger', 'Triggers'], ['observe', 'Judgement']];
  function paintModes(active) {
    Array.prototype.forEach.call(modeSeg.children, function (btn, i) {
      btn.setAttribute('aria-pressed', modes[i][0] === active ? 'true' : 'false');
    });
  }
  modes.forEach(function (m) {
    var b = node('button', null, m[1]);
    b.type = 'button';
    b.addEventListener('click', function () {
      var was = s.groups.replyTo;
      if (was === m[0]) return;
      s.groups.replyTo = m[0];
      paintModes(m[0]);
      saveSettings({ groups: { replyTo: m[0] } }, function () {
        s.groups.replyTo = was;
        paintModes(was);
      });
    });
    modeSeg.appendChild(b);
  });
  paintModes(s.groups.replyTo);
  field(groups, 'Group mode', 'When Tulip should speak up in a group.  ·  Mentions: only when somebody @-mentions it — a real WhatsApp mention, the kind you make by tapping the name, not the letters typed out — or replies to one of its messages. The quietest setting, and the one most likely to look broken, because typing “Juan” is not a mention.  ·  Triggers: the above, plus any message containing one of the trigger words below.  ·  Judgement: Tulip follows the whole conversation and decides for itself. It answers a question nobody else has answered when it actually knows, settles a factual disagreement, reacts to something funny — and stays silent for everything else, which is most things. This is the setting that behaves like a person in the room. It is also the expensive one: every message becomes a paid turn whether or not it replies, though messages arriving together are batched into one.', modeSeg);
  listField(groups, 'Trigger words', 'Only used when Group mode is set to Trigger. Ignored otherwise.',
    s.groups.triggers || [], 'e.g. juan',
    'A group message containing any of these is answered; everything else in the room is ignored. Upper and lower case do not matter, and a phrase with spaces works as well as a single word — “hey juan” is a fine trigger. Keep them distinctive: a word like “the” means Tulip answers almost everything.',
    function (next, revert) { saveSettings({ groups: { triggers: next } }, revert); },
    function (v) {
      // Collapse whitespace, but refuse an over-long phrase rather than
      // truncating it: a silently shortened trigger is one the operator watches
      // get accepted and then never fires.
      var t = v.replace(/\s+/g, ' ');
      if (t.length > 32) { toast('Trigger words are limited to 32 characters.'); return ''; }
      return t;
    },
    { reload: function () { return freshSettings(function (f) { return f.groups.triggers || []; }); } });
  p.appendChild(groups);

  // ── Reach ─────────────────────────────────────────────────────────────────
  var reach = node('div', 'card');
  reach.appendChild(node('h2', null, 'Reach'));
  reach.appendChild(node('p', 'sub', 'Whether Tulip can start a conversation, or only ever answer one. By default a reply can go nowhere except back to the person who just wrote — the agent is never told who it is talking to, so it cannot name a different destination even if somebody talks it into trying. This card is where you relax that.'));
  field(reach, 'Message other chats', 'Lets Tulip write to the contacts below, and pass something on to a conversation it already knows. It still cannot read anyone else’s chat — every conversation is a separate session — but it can carry what it was told here into somewhere else. Worth thinking about before turning on: anything somebody tells Tulip can then be repeated elsewhere, and the person who said it will not know.',
    liveSwitch(s.agent && s.agent.crossChat, function (on, input) {
      saveSettings({ agent: { crossChat: on } }, function () { input.checked = !on; });
    }));

  contactsField(reach, s.agent && s.agent.contacts ? s.agent.contacts : [],
    function (next, revert) { saveSettings({ agent: { contacts: next } }, revert); },
    {
      audience: s.audience,
      crossChat: !!(s.agent && s.agent.crossChat),
      reload: function () { return freshSettings(function (f) { return (f.agent && f.agent.contacts) || []; }); },
    });

  p.appendChild(reach);

  // ── Limits ────────────────────────────────────────────────────────────────
  var limits = node('div', 'card');
  limits.appendChild(node('h2', null, 'Limits'));
  limits.appendChild(node('p', 'sub', 'Ceilings on what one person can make Tulip do. These decide what gets refused — they are about volume and cost, never about who is allowed to write in. That is Audience, above. Somebody over a limit is refused silently, and their next message is accepted once they are back under it.'));
  // Bounds match the schema in panel-api.ts exactly. A narrower slider looks
  // like guidance and behaves like a trap: the input clamps a larger configured
  // value to its own maximum, and the first nudge writes the clamp.
  [['messagesPerHour', 'Messages per hour, per person', 1, 1000, null, 1,
    'The steady rate one person may keep up. Beyond it their messages are refused until the hour has moved on.'],
   ['burst', 'Messages back to back', 1, 50, null, 1,
    'How many one person may send in quick succession before the hourly rate starts to bite. People type in bursts of three or four short lines; this is what stops normal typing looking like an attack.'],
   ['turnsPerDay', 'Turns per day, per person', 1, 10000, null, 10,
    'The most one person can cost you in a day. This is the money setting: each turn is a paid request to Claude, so it caps spend per person more directly than anything else here.'],
   ['newSendersPerHour', 'New people per hour', 1, 1000, null, 1,
    'How many numbers that have never written before are taken on in an hour, counted across everyone. This is what blunts a flood of throwaway numbers; it does nothing to people already talking to Tulip.'],
   ['imagesPerDay', 'Pictures per day, everyone', 0, 1000, null, 1,
    'A hard ceiling on generated pictures across all conversations. Unlike the limits above this is not per person — the bill is rarely one sender being expensive, it is many being reasonable, and a per-person cap cannot bound a total. Past it Tulip says it has made as many as it can today. 0 stops pictures entirely.'],
   ['transcriptionsPerDay', 'Voice notes transcribed per day, everyone', 0, 5000, null, 10,
    'The same ceiling for turning inbound voice notes into words, also counted across everybody. Past it a voice note still arrives, and Tulip is told it could not be read — so it says so rather than answering as though nothing was sent. 0 stops transcription entirely.'],
   ['outboundPerTurn', 'Replies Tulip may send per turn', 1, 100, null, 1,
    'One turn can produce several messages — a sentence, then a photo, then a follow-up. This caps how many. It bounds an agent that has been talked into spamming somebody exactly as it bounds a chatty one.'],
   ['outboundPerChatPerHour', 'Replies per conversation, per hour', 1, 1000, null, 1,
    'The same ceiling measured over an hour rather than a turn, so a run of turns cannot add up to a flood.'],
   ['maxInboundChars', 'Longest message read', 200, 100000, null, 100,
    'Anything longer is shortened to this before the agent sees it — not refused. A long question is not an attack, and the person still gets an answer.'],
   ['maxMediaPerMessage', 'Attachments taken per message', 0, 10, null, 1,
    'How many photos, files or voice notes are accepted from a single message. Any beyond this are ignored. Set it to 0 to take none at all.'],
   ['maxMediaBytes', 'Largest attachment accepted', 1024, 104857600, bytes, 262144,
    'Checked before anything is downloaded, so an oversized file is never fetched — it costs no bandwidth and never touches the disk.'],
   ['turnTimeoutMs', 'Give up on a turn after', 30000, 3600000, duration, 30000,
    'How long the agent gets to finish one reply before that turn is abandoned. It is a deadlock guard rather than a speed setting: without it, one stuck reply holds every other conversation shut behind it. Too short and slow answers get cut off.']
  ].forEach(function (row) {
    field(limits, row[1], row[6],
      numberControl(s.limits[row[0]], row[2], row[3], function (v, revert) {
        var patch = { limits: {} };
        patch.limits[row[0]] = v;
        saveSettings(patch, revert);
      }, { format: row[4], step: row[5] }));
  });
  p.appendChild(limits);

  // ── Delivery ──────────────────────────────────────────────────────────────
  var delivery = node('div', 'card');
  delivery.appendChild(node('h2', null, 'Delivery'));
  delivery.appendChild(node('p', 'sub', 'Timing rather than permission. Everything here happens after a message has been accepted, and decides how it is gathered up and handed over. Nothing on this card can refuse anybody — if messages are being turned away, the answer is in Audience or Limits.'));
  [['debounceMs', 'Pause before replying', 0, 60000,
    'When a message arrives, wait this long to see whether more follow, then answer them together. People send three short lines where they meant one sentence — without this they get three separate replies, and pay for three turns. Longer feels more considered; shorter feels quicker.', duration, 250],
   ['maxBatch', 'Messages handed over at once', 1, 50,
    'The most messages the agent is given in a single turn. Anything past this waits for that conversation’s next turn, which is what stops one very busy chat starving everyone else.', null, 1],
   ['stuckAfterMs', 'Warn you if nobody has been answered for', 0, 3600000,
    'If anyone has been waiting longer than this, your operator numbers get a WhatsApp message. It is the one alarm that does not depend on the agent noticing its own failure — a session can look perfectly healthy while answering nobody. Set it to 0 to turn the warning off.', duration, 30000]
  ].forEach(function (row) {
    field(delivery, row[1], row[4], numberControl(s.delivery[row[0]], row[2], row[3], function (v, revert) {
      var patch = { delivery: {} };
      patch.delivery[row[0]] = v;
      saveSettings(patch, revert);
    }, { format: row[5], step: row[6] }));
  });
  p.appendChild(delivery);

  // ── Capabilities ──────────────────────────────────────────────────────────
  var tools = node('div', 'card');
  tools.appendChild(node('h2', null, 'Capabilities'));
  tools.appendChild(node('p', 'sub', 'Extra things Tulip can do beyond sending words. Each one needs two separate permissions: an account key must exist, and you must allow its use. A switch marked “no key set” will not do anything until somebody adds the key — keys live outside this panel and changing one needs the container restarted, while these switches take effect immediately. Tulip itself has no internet connection: it asks, and the bridge performs the request on its behalf, so no key is ever inside the machine running the agent.'));

  [['search', 'Look things up on the web', 'Lets Tulip search the web (through Exa) when it needs a fact it does not have. The thing to know: a web page can be written specifically to be read by an AI and to contain instructions aimed at it. Unlike a message, there is no sender behind it you can block, so this is the widest door on this card.'],
   ['gifs', 'Send GIFs', 'Lets Tulip reply with a GIF from Giphy, filtered at rating ' + s.tools.gifRating + '. Free, and the least consequential switch here.'],
   ['images', 'Generate pictures', 'Lets Tulip make an image and send it. Every picture is billed, so this is the switch most able to cost you money quickly — the per-turn and per-hour reply limits above are what bound it.'],
   ['voice', 'Send voice notes', 'Lets Tulip answer with a spoken voice note instead of text. Also billed per use. If the speech fails, the same words are sent as text, so nobody loses their reply.']
  ].forEach(function (row) {
    var keyed = s.tools.keyed[row[0]];
    var wrap = node('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '12px';
    if (!keyed) wrap.appendChild(node('span', 'badge off', 'no key set'));
    wrap.appendChild(liveSwitch(s.agent[row[0]], function (on, input) {
      var patch = { agent: {} };
      patch.agent[row[0]] = on;
      saveSettings(patch, function () { input.checked = !on; });
    }));
    field(tools, row[1], row[2] + (keyed ? '' : ' Currently unavailable: no key is configured.'), wrap);
  });

  field(tools, 'Voice',
    'Which MiniMax voice speaks. Leave empty for this deployment’s default. A name that does not exist fails the whole request — the provider answers “voice id not exist” — and voice notes quietly fall back to text until it is corrected, so change it and then send yourself one.',
    textField(s.agent && s.agent.voiceId, 'e.g. English_engaging_instructor_vv2', function (v, revert) {
      saveSettings({ agent: { voiceId: v } }, revert);
    }));

  field(tools, 'Model', 'Which Claude model answers. Read-only here — it is set outside the panel, and changing it needs the container restarted.', node('span', 'value', s.model.name));
  field(tools, 'Provider', 'Whose servers those requests go to. Also read-only, and also set outside the panel.', node('span', 'value', s.model.provider));
  p.appendChild(tools);
}

async function renderLog() {
  var p = head('log', 'Log', 'The bridge’s structured events for today. Credentials are masked before writing.'), mine = renderToken;
  var card = node('div', 'card');
  p.appendChild(card);
  var rows;
  try { rows = await api('/api/logs?n=250'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(mine)) return;
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
// Pages that need the state snapshot. The rest render on their own data and
// must not wait for it — that was why a refresh on Settings, Messages, Media or
// Log showed an empty page until something happened to trigger a re-render.
var NEEDS_STATE = { overview: 1, chats: 1 };

function render() {
  if (NEEDS_STATE[route] && !state) return;
  if (route === 'overview') renderOverview(state);
  else if (route === 'messages') renderMessages();
  else if (route === 'chats') renderChats(state);
  else if (route === 'media') renderMedia();
  else if (route === 'terminal') renderTerminal();
  else if (route === 'settings') renderSettings();
  else if (route === 'log') renderLog();
}

async function refresh() {
  try {
    state = await api('/api/state');
  } catch (err) {
    // The poll runs every few seconds, so this must not shout on every failed
    // one. The toast is transient and the dot has already gone dark.
    if (!lostContact) {
      lostContact = true;
      toast('Lost contact with the bridge. Retrying — nothing is lost meanwhile.', true);
    }
    return;
  }
  lostContact = false;
  verdict(state);
  // First successful load paints whatever page is showing; after that only the
  // state-driven pages need repainting on a poll.
  if (!booted) { booted = true; render(); }
  else if (NEEDS_STATE[route]) render();
}

// ── Shader backdrop ─────────────────────────────────────────────────────────
// Optional by design: the bundle is vendored at image build time and is simply
// absent in a development tree, so this is wrapped rather than assumed. The
// library already pauses itself when the tab is hidden.
/**
 * The page's paper surface.
 *
 * Paper Shaders' `paperTexture`, at the settings chosen in their editor. Speed 0
 * because this is a static surface — it draws once and then holds, so it costs
 * one frame rather than a render loop, which is what makes a full-viewport
 * canvas an acceptable way to carry a background texture.
 *
 * **Both samplers have to be loaded images, and neither may be skipped.**
 *
 *   - `u_noiseTexture` is the pre-computed randomiser the fibre and speckle
 *     layers read instead of generating noise per pixel. `ShaderMount` throws
 *     outright if it has not decoded — "image for uniform u_noiseTexture must
 *     be fully loaded" — and `getShaderNoiseTexture()` hands back an element
 *     that usually has not.
 *   - `u_image` is the optional source image, and "optional" is a property of
 *     the shader rather than of the mount. Leaving it `undefined` does not bind
 *     an empty texture, it leaves the sampler pointing at whichever unit was
 *     bound last — which is the randomiser, so the page renders as raw RGB
 *     noise. The library exports `emptyPixel` for exactly this, and only
 *     `HTMLImageElement` values are turned into textures, so the data URI has
 *     to be loaded rather than passed as a string.
 *
 * Both failures were silent before: one threw into a catch that said nothing,
 * the other rendered something plausible-but-wrong. Hence the warnings.
 *
 * Not gated on `prefers-reduced-motion`, unlike the masthead's gradient: there
 * is no motion here to reduce, and a person who asked for less animation still
 * wants the page to have its surface.
 */
function loadImage(src) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve(img); };
    img.onerror = function () { reject(new Error('could not load ' + String(src).slice(0, 40))); };
    img.src = src;
  });
}

function ready(img) {
  if (!img) return Promise.resolve(null);
  if (img.complete && img.naturalWidth > 0) return Promise.resolve(img);
  return new Promise(function (resolve) {
    img.addEventListener('load', function () { resolve(img); }, { once: true });
    img.addEventListener('error', function () { resolve(null); }, { once: true });
  });
}

/**
 * How fast the grain moves. The library's own default is 1.
 *
 * At 0.03 the fibres take most of a minute to travel their own width, which is
 * the point: it should read as paper catching the light rather than as
 * something on the page doing something. If you can tell it is moving without
 * staring at it, it is too fast.
 *
 * Zero under `prefers-reduced-motion`, which also stops the render loop rather
 * than merely slowing it — a full-viewport WebGL surface animating behind an
 * operator console is exactly what that setting is asking us not to do.
 */
/**
 * How fast the field moves, against the library's default of 1.
 *
 * The grain does not move at all: two animated layers is twice the GPU for an
 * effect one of them already carries, and shimmering grain reads as a fault
 * rather than as motion.
 *
 * Zero under `prefers-reduced-motion`, which stops the render loop rather than
 * merely slowing it — a full-column WebGL surface animating behind an operator
 * console is exactly what that setting is asking us not to do.
 */
var FLOW = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.18;
var DRIFT = 0;

/**
 * The moving layer.
 *
 * A mesh gradient rather than a noise field: it moves as slow shapes rather than
 * as texture, which is what lets it be seen at a speed slow enough to ignore.
 * The grain that sits over it supplies the fine detail, and `u_grainMixer` and
 * `u_grainOverlay` add a little of their own so the colour never bands.
 *
 * Colours sit within a few percent of the page's own ground with the faintest
 * cool cast, so it reads as depth rather than as a gradient somebody chose.
 * `#paper-flow`'s opacity is the knob to reach for if it should be fainter.
 *
 * The sizing block is not optional and its absence is silent — see the note in
 * `mountPaper`. Every uniform here is passed explicitly for that reason.
 */
function mountFlow() {
  if (typeof PaperShaders === 'undefined' || !PaperShaders.ShaderMount) return;
  if (!PaperShaders.meshGradientFragmentShader) return;
  var host = el('paper-flow');
  if (!host) return;
  try {
    new PaperShaders.ShaderMount(host, PaperShaders.meshGradientFragmentShader, {
      u_colorBack: [0.051, 0.051, 0.059, 1],
      // Lifted from "within 3% of the ground", which was accurate to the brief
      // and invisible on a screen. These are still dark — the brightest is
      // roughly #26333a — but far enough apart that the shapes read.
      u_colors: [
        [0.149, 0.200, 0.227, 1],
        [0.086, 0.114, 0.129, 1],
        [0.051, 0.051, 0.059, 1]
      ],
      u_colorsCount: 3,
      u_distortion: 0.62,
      u_swirl: 0.42,
      u_grainMixer: 0.24,
      u_grainOverlay: 0.12,
      u_fit: 0,
      u_scale: 1,
      u_rotation: 0,
      u_originX: 0.5,
      u_originY: 0.5,
      u_offsetX: 0,
      u_offsetY: 0,
      u_worldWidth: 0,
      u_worldHeight: 0
    }, undefined, FLOW);
  } catch (err) {
    console.warn('[tulip] mesh gradient did not mount:', err && err.message ? err.message : err);
  }
}

async function mountPaper() {
  if (typeof PaperShaders === 'undefined' || !PaperShaders.ShaderMount) return;
  if (!PaperShaders.paperTextureFragmentShader) return;
  var host = el('paper-grain');
  if (!host) return;

  try {
    var noise = await ready(PaperShaders.getShaderNoiseTexture ? PaperShaders.getShaderNoiseTexture() : null);
    if (!noise) { console.warn('[tulip] paper texture: no noise source, skipping'); return; }
    var blank = await loadImage(PaperShaders.emptyPixel);

    new PaperShaders.ShaderMount(host, PaperShaders.paperTextureFragmentShader, {
      u_image: blank,
      u_noiseTexture: noise,
      u_colorBack: [0, 0, 0, 1],
      u_colorFront: [0.047, 0.051, 0.055, 1],
      u_contrast: 0.17,
      u_roughness: 0.68,
      u_fiber: 0.3,
      u_fiberSize: 0.13,
      u_crumples: 0,
      u_crumpleSize: 0.01,
      u_folds: 0,
      u_foldCount: 1,
      u_drops: 0.07,
      u_fade: 0,
      u_seed: 5.8,
      u_fit: 2,
      u_scale: 0.6,
      u_rotation: 0,
      u_originX: 0.5,
      u_originY: 0.5,
      u_offsetX: 0,
      u_offsetY: 0,
      u_worldWidth: 0,
      u_worldHeight: 0
    }, undefined, DRIFT);
  } catch (err) {
    console.warn('[tulip] paper texture did not mount:', err && err.message ? err.message : err);
  }
}


/**
 * Put the mark in the mobile bar.
 *
 * Cloned from the rail's brand rather than written twice. The logo is a literal
 * in the HTML; a second copy would be a second thing to remember when it
 * changes, and this one is guaranteed to be the same drawing.
 */
function mountTopbarMark() {
  var source = document.querySelector('.brand svg');
  var slot = el('topbarMark');
  if (!source || !slot) return;
  slot.appendChild(source.cloneNode(true));
}

// ── Boot ────────────────────────────────────────────────────────────────────
buildNav();
mountTopbarMark();
wireNavToggle();
mountFlow();
void mountPaper();
go((location.hash || '#/overview').replace('#/', '') || 'overview');
window.addEventListener('hashchange', function () { go((location.hash || '#/overview').replace('#/', '')); });

var stream = new EventSource('/api/stream');
var feedPending = null;
stream.onmessage = function () {
  if (route !== 'messages') return;
  // Coalesce: a burst of entries should repaint once, not once each.
  clearTimeout(feedPending);
  feedPending = setTimeout(function () { renderMessages(); }, 400);
};

refresh();
setInterval(refresh, 5000);
