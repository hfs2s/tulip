'use strict';
// Every value from the API reaches the DOM through textContent. Message text is
// written by strangers; assigning it to innerHTML anywhere here would make this
// page the softest target in the deployment. The one exception is the inline SVG
// for nav icons, which is a fixed literal defined in this file and never data.

var state = null;
var route = 'overview';
var feedFilter = 'all';
var chatQuery = '';
/** The Chat page's own filter. Separate from `chatQuery`, which the Chats table
 *  owns — one variable behind both meant typing in either narrowed the other. */
var convoQuery = '';
/** Which conversation the Chat page is showing, or null for none. */
var chatOpen = null;
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
async function act(action, key, rawPath) {
  try {
    var path = rawPath !== undefined
      ? '/api/' + action + rawPath
      : '/api/action/' + encodeURIComponent(action) + (key ? '?key=' + encodeURIComponent(key) : '');
    var body = await api(path, { method: 'POST' });
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
  // A sheet with a corner turned: a page, which is what these are.
  // A page with a person on it: the brief, not the person.
  persona: '<path d="M12 12.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z"/><path d="M5.4 20.2a6.6 6.6 0 0 1 13.2 0"/>',
  // A head in profile: what it carries between rooms.
  memory: '<path d="M15.6 4.2a4.3 4.3 0 0 0-8.2 1.6c0 .7.2 1.4.5 2l-2 3.3h2v3.6a2 2 0 0 0 2 2h1.4v3.1"/><path d="M11.6 8.4a1.9 1.9 0 1 0 3.4 1.2"/>',
  pages: '<path d="M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z"/><path d="M14 3.5V8h4.5"/><path d="M8.8 12.5h6.4"/><path d="M8.8 16h4.2"/>',
  chat: '<path d="M20.5 12c0 3.9-3.8 7-8.5 7-1 0-2-.15-2.9-.42L4 20l1.3-3.4C4.2 15.3 3.5 13.7 3.5 12c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/><path d="M8.6 10.4h6.8"/><path d="M8.6 13.4h4.4"/>',
  media: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.6" cy="9.9" r="1.4"/><path d="M3.5 16.2l4.4-3.9 3.6 3.1 3-2.6 6 4.9"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 0 5 5L15 16l-3 3-4-4 3-3z"/><path d="M6 18l1.5-1.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M12.5 15h4"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18"/>',
  log: '<path d="M6 4.5h9l4 4v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M14.5 4.5v4.5H19"/><path d="M8.5 13h7M8.5 16.5h5"/>'
};
/**
 * One icon, as an element.
 *
 * `innerHTML` here is the file's own literal from `ICONS` and never a value
 * from the API — the note at the top of this file is about that distinction and
 * this is the one place that relies on it.
 */
function icon(name) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// Terminal is deliberately absent. The raw pane shows every conversation at
// once — other people's keys, tool arguments, whatever a stack trace printed —
// so it is not a destination of its own any more. It opens from a secondary
// control on the Chat page, over the conversation it belongs to.
var PAGES = [
  ['overview', 'Overview'], ['chat', 'Chat'], ['messages', 'Messages'], ['chats', 'Chats'],
  ['media', 'Media'], ['persona', 'Persona'], ['memory', 'Memory'], ['pages', 'Pages'], ['settings', 'Settings'],
  ['log', 'Log']
];

function buildNav() {
  var nav = clear(el('nav'));
  PAGES.forEach(function (p) {
    var b = node('button', 'nav');
    b.type = 'button';
    b.dataset.route = p[0];
    b.appendChild(icon(p[0]));
    b.appendChild(node('span', null, p[1]));
    if (p[0] === 'chats') { var c = node('span', 'count', '0'); c.id = 'navChats'; b.appendChild(c); }
    // Chat keeps whichever conversation is open, so coming back from another
    // page returns to it rather than to an empty picker.
    b.addEventListener('click', function () { go(p[0] === 'chat' && chatOpen ? 'chat/' + chatOpen : p[0]); });
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

/**
 * Change page.
 *
 * The Chat page carries a chat key in the route — `#/chat/<key>` — so a reload,
 * a bookmark or a link out of the Chats table all land on the same
 * conversation. Nothing else on this page has an argument, hence the split
 * rather than a router.
 */
function go(next) {
  var parts = String(next).split('/');
  var page = parts[0] || 'overview';
  if (page === 'chat') chatOpen = /^[0-9a-f]{16}$/.test(parts[1] || '') ? parts[1] : null;

  route = page;
  if (location.hash !== '#/' + next) location.hash = '#/' + next;
  // Choosing a page is the end of the menu's job.
  setNav(false);
  var crumb = el('topbarPage');
  if (crumb) {
    for (var i = 0; i < PAGES.length; i++) {
      if (PAGES[i][0] === route) { crumb.textContent = PAGES[i][1]; break; }
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
  // Chat is a chat client rather than a document: two panes that scroll on
  // their own, which is impossible inside a page that scrolls as a whole. So
  // the wrapper gives up its padding and the page takes the frame.
  var wrap = document.querySelector('.page-wrap');
  if (wrap) wrap.classList.toggle('chatmode', route === 'chat');
  document.body.classList.toggle('chatmode', route === 'chat');
  stopTerminal();
  if (route !== 'chat') stopChatPoll();
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

/** The same bookkeeping as `head()`, for a page that carries its own chrome. */
function frame(page) {
  var p = clear(el('p-' + page));
  ++renderToken;
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
    // Reading one conversation is the common thing to want from this table, and
    // blocking somebody is the rare one, so it leads.
    var open = node('button', 'sm', 'Open');
    open.type = 'button';
    open.setAttribute('aria-label', 'Open the conversation with ' + (c.name || c.chatKey));
    open.addEventListener('click', function () { go('chat/' + c.chatKey); });
    td.appendChild(open);
    var b = node('button', 'sm' + (c.blocked ? '' : ' danger'), c.blocked ? 'Unblock' : 'Block');
    b.type = 'button';
    b.style.marginLeft = '8px';
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

// ── Chat ────────────────────────────────────────────────────────────────────
// The masked chat, and the panel's primary surface.
//
// The terminal shows the truth and is close to unreadable: a TUI is spinner
// frames, box drawing and half-repainted lines, and it carries every open
// conversation at once — other people's chat keys, tool arguments, whatever a
// stack trace printed. An operator wanting to know what Juan just told somebody
// should not have to parse one, and should not have to read three strangers'
// sessions to do it.
//
// So this page is the same session in the shape it actually has, from
// `/api/chat/transcript`, and it is built as a chat client: conversations down
// the side, a thread that scrolls on its own, a box pinned under it. Two rules
// carry the masking, and both are structural rather than cosmetic.
//
//   · **Only speech gets a bubble.** What somebody sent, what Juan sent back,
//     and what an operator typed at his prompt. Everything else — tools,
//     thinking, the words Juan wrote in session that nobody received — is a
//     band that spans the column. A bubble hangs from one edge and is somebody
//     talking; a band touches both edges and is a stage direction.
//   · **Nothing raw reaches the band.** A step is a past-tense verb and a
//     masked detail: a basename rather than a path, a hostname rather than a
//     URL, a program name rather than a command line, and never a chat key.
//     `mask()` is the whole of that and every detail goes through it.
//
// Everything here reaches the DOM through `textContent`, which matters more on
// this page than anywhere else: half of what is rendered was written by a
// stranger and the other half by an agent that reads what strangers write.

/**
 * How often the transcript is re-read, in the two states worth distinguishing.
 *
 * Each poll costs the bridge a read of the feed and a 256 KiB tail of a
 * transcript, on a Raspberry Pi that is also running a model session. So the
 * page reads faster only while there is something to see — `queue.inFlight` is
 * a chat key, so "is this conversation being answered right now" is already
 * known — and idles slower than it used to the rest of the time.
 */
var CHAT_BUSY_MS = 4000;
var CHAT_IDLE_MS = 9000;
var chatTimer = null;
/** The most recent payload, so the composer can name who it is about to reach. */
var chatView = null;
/** The recent feed, for the conversation list's one-line previews. */
var chatFeed = [];
/**
 * Lines typed from this panel that the transcript has not read back yet.
 *
 * The poll is seconds away and a send that puts nothing on the screen reads as
 * a send that did not happen. These are shown faded until the real item arrives
 * and `prunePending` drops them.
 */
var chatPending = [];
/** Which work bands and which thinking blocks the reader has opened. */
var chatBands = {};
var chatProse = {};
/** Something arrived while the reader was parked further up the thread. */
var chatMissed = false;
/**
 * What the thread was last painted from.
 *
 * A poll that changes nothing must not repaint: a repaint every four seconds
 * loses the text selection, closes whatever band was open and flickers. So the
 * paint is gated on this instead.
 */
var chatSig = null;

function stopChatPoll() {
  if (chatTimer !== null) { clearTimeout(chatTimer); chatTimer = null; }
}

function chatPollMs() {
  return (state && state.queue && state.queue.inFlight === chatOpen) ? CHAT_BUSY_MS : CHAT_IDLE_MS;
}

function startChatPoll() {
  stopChatPoll();
  chatTimer = setTimeout(function tick() {
    void refreshThread();
    chatTimer = setTimeout(tick, chatPollMs());
  }, chatPollMs());
}

function renderChat() {
  var p = frame('chat');
  stopChatPoll();
  chatView = null;
  chatSig = null;
  chatMissed = false;

  var app = node('div', 'chatapp');
  app.id = 'chatApp';
  if (chatOpen) app.classList.add('reading');
  app.appendChild(convoColumn());
  app.appendChild(threadPane());
  p.appendChild(app);

  void loadChatFeed();
  if (chatOpen) {
    void refreshThread();
    startChatPoll();
  }
}

// ── The conversation list ───────────────────────────────────────────────────
// This was a <select>, which is the control you reach for when the list is an
// argument to the page rather than the page's other half. Here it is the other
// half: who has written, what they last said, how long ago, and whether Juan
// has a session open for them.

function convoColumn() {
  var col = node('aside', 'convo');
  var top = node('div', 'convo-head');
  var filter = node('input', 'search');
  filter.type = 'search';
  filter.id = 'convoFilter';
  filter.placeholder = 'Filter conversations';
  filter.value = convoQuery;
  filter.setAttribute('aria-label', 'Filter conversations by name or key');
  filter.addEventListener('input', function () { convoQuery = filter.value; paintConvoList(); });
  top.appendChild(filter);
  col.appendChild(top);

  var list = node('div', 'convo-list');
  list.id = 'convoList';
  col.appendChild(list);
  paintConvoList(list);
  return col;
}

function paintConvoList(target) {
  var list = target || el('convoList');
  if (!list) return;
  // The state poll repaints this every few seconds; doing so while a row has
  // the keyboard would take it away mid-tab.
  if (!target && list.contains(document.activeElement)) return;
  // And doing so would send anyone scrolled down a long list back to the top,
  // every five seconds, for as long as they looked at it.
  var was = list.scrollTop;
  clear(list);

  var rows = (state && state.chats) ? state.chats : [];
  if (!rows.length) {
    list.appendChild(node('p', 'convo-none',
      'Nobody has messaged Juan yet. The first message opens a conversation here.'));
    return;
  }
  var q = convoQuery.trim().toLowerCase();
  var shown = rows.filter(function (c) {
    return !q || (c.name || '').toLowerCase().indexOf(q) >= 0 || c.chatKey.indexOf(q) >= 0;
  });
  if (!shown.length) {
    list.appendChild(node('p', 'convo-none', 'No conversation matches that.'));
    return;
  }
  shown.forEach(function (c) { list.appendChild(convoRow(c)); });
  list.scrollTop = was;
}

/** Whether the agent has a tmux window open for this chat. */
function chatIsLive(key) {
  return !!(state && state.agent && state.agent.openChats
    && state.agent.openChats.indexOf(key) >= 0);
}

function convoRow(c) {
  var b = node('button', 'convo-row');
  b.type = 'button';
  b.setAttribute('aria-current', c.chatKey === chatOpen ? 'true' : 'false');

  var busy = !!(state && state.queue && state.queue.inFlight === c.chatKey);
  var live = chatIsLive(c.chatKey);
  var dot = node('span', 'dot' + (busy ? ' busy' : live ? ' live' : ''));
  var says = busy ? 'replying now' : live ? 'session open' : 'no session open';
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', says);
  dot.setAttribute('title', says);
  b.appendChild(dot);

  b.appendChild(node('span', 'name',
    (c.name || 'Someone') + (c.isGroup ? ' (group)' : '') + (c.blocked ? ' — blocked' : '')));
  b.appendChild(node('span', 'when', state ? ago(state.now - c.lastSeenAt) : ''));
  b.appendChild(node('span', 'last', previewFor(c)));
  b.addEventListener('click', function () { go('chat/' + c.chatKey); });
  return b;
}

/** The last thing said in a conversation, from the bridge's own feed. */
function previewFor(c) {
  for (var i = chatFeed.length - 1; i >= 0; i--) {
    var e = chatFeed[i];
    if (e.chatKey !== c.chatKey) continue;
    if (e.kind === 'out') return 'Juan: ' + (e.text || '');
    if (e.kind === 'in') return e.text || (e.detail ? '(' + e.detail + ')' : '');
  }
  return plural(c.messages, 'message');
}

async function loadChatFeed() {
  var mine = renderToken;
  var rows;
  // A missing preview is a smaller loss than an error on a page that is
  // otherwise working, so this fails quietly and the rows fall back to a count.
  try { rows = await api('/api/feed?n=250'); } catch (err) { return; }
  if (stale(mine) || route !== 'chat') return;
  chatFeed = rows;
  paintConvoList();
}

// ── The thread ──────────────────────────────────────────────────────────────

function threadPane() {
  var pane = node('section', 'thread-pane');
  pane.id = 'threadPane';
  if (!chatOpen) {
    pane.appendChild(emptyPane());
    return pane;
  }
  pane.appendChild(threadHead());

  var wrap = node('div', 'thread-wrap');
  var thread = node('div', 'thread');
  thread.id = 'chatThread';
  thread.setAttribute('role', 'log');
  thread.setAttribute('aria-label', 'The conversation');
  thread.addEventListener('scroll', onThreadScroll, { passive: true });
  thread.appendChild(node('p', 'thread-note', 'Reading the session…'));
  wrap.appendChild(thread);

  var jump = node('button', 'jump', 'Jump to latest');
  jump.type = 'button';
  jump.id = 'chatJump';
  jump.hidden = true;
  jump.addEventListener('click', function () {
    chatMissed = false;
    thread.scrollTop = thread.scrollHeight;
    paintJump();
  });
  wrap.appendChild(jump);
  pane.appendChild(wrap);

  pane.appendChild(composer());
  return pane;
}

function emptyPane() {
  var box = node('div', 'pane-empty');
  box.appendChild(icon('chat'));
  box.appendChild(node('h3', null, 'Pick a conversation'));
  box.appendChild(node('p', null,
    'Each one runs as its own Claude Code session and they cannot see one another. '
    + 'Choose somebody on the left to read what Juan has been saying, and to type into it.'));
  return box;
}

function threadHead() {
  var h = node('header', 'thread-head');
  // The rule under the header belongs to the pane; what it says belongs to the
  // column. `.cap` is the same inset the thread and the composer take, so the
  // name, the first bubble and the field all start on one line.
  var cap = node('div', 'cap');
  h.appendChild(cap);

  // Only on a phone, where the list and the thread are the same column.
  var back = node('button', 'sm backrow');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to the conversations');
  back.appendChild(icon('back'));
  back.addEventListener('click', function () { go('chat'); });
  cap.appendChild(back);

  var who = node('div', 'who');
  var title = node('h3', null, '…');
  title.id = 'chatWho';
  who.appendChild(title);
  var sub = node('p', 'sub');
  var dot = node('span', 'dot');
  dot.id = 'chatDot';
  var says = node('span', null, 'checking');
  says.id = 'chatState';
  sub.appendChild(dot);
  sub.appendChild(says);
  sub.appendChild(node('span', 'key', chatOpen || ''));
  who.appendChild(sub);
  cap.appendChild(who);

  var acts = node('div', 'acts');
  var raw = node('button', 'sm raw');
  raw.type = 'button';
  raw.title = 'The agent’s real tmux pane. It carries every open conversation, not just this one.';
  raw.appendChild(icon('terminal'));
  raw.appendChild(node('span', null, 'Raw terminal'));
  raw.addEventListener('click', openTerminal);
  acts.appendChild(raw);
  cap.appendChild(acts);
  return h;
}

/**
 * Fetch and repaint.
 *
 * Scroll position is preserved unless the reader was already at the bottom, in
 * which case it follows. A thread that yanks you back to the newest line every
 * few seconds is one you cannot read the middle of.
 */
async function refreshThread() {
  var thread = el('chatThread');
  if (!thread || !chatOpen) return;
  // A background tab is not a reader. This page is polled rather than pushed,
  // and a tab left open for a week should not keep the bridge tailing a file.
  if (document.hidden) return;
  var key = chatOpen;

  var view;
  try {
    view = await api('/api/chat/transcript?key=' + encodeURIComponent(key) + '&n=300');
  } catch (err) {
    // Only if nothing has painted yet: a failed poll should not blank a thread
    // that is on screen and readable.
    if (!chatView) paintFailure(thread, err.message);
    return;
  }
  // The operator moved on while this was in flight.
  if (key !== chatOpen || !thread.isConnected) return;

  var first = chatView === null;
  chatView = view;
  paintHead(view);
  prunePending(view);
  var sig = signature(view);
  if (sig !== chatSig) {
    chatSig = sig;
    paintThread(view);
    if (first) pinThread();
  }
  paintComposer(view);
}

/** What the thread depends on, so an unchanged poll costs no DOM at all. */
function signature(view) {
  var last = view.items.length ? view.items[view.items.length - 1] : null;
  return [
    view.items.length,
    last ? last.ts : 0,
    last ? String(last.text || '').length : 0,
    view.live ? 1 : 0,
    view.reporting ? 1 : 0,
    (state && state.queue && state.queue.inFlight === chatOpen) ? 1 : 0,
    chatPending.length
  ].join('|');
}

function paintFailure(thread, message) {
  clear(thread);
  var box = node('p', 'thread-note');
  box.appendChild(node('b', null, 'The transcript could not be read'));
  box.appendChild(document.createTextNode(message));
  var again = node('button', 'sm', 'Try again');
  again.type = 'button';
  again.addEventListener('click', function () { void refreshThread(); });
  box.appendChild(again);
  thread.appendChild(box);
}

/** Who this is and what state they are in, said in words rather than colour. */
function paintHead(view) {
  var who = el('chatWho'), dot = el('chatDot'), says = el('chatState');
  if (!who || !dot || !says) return;
  var name = (view.chat && view.chat.name) || 'Someone';
  who.textContent = name + (view.chat && view.chat.isGroup ? ' (group)' : '');

  var busy = !!(state && state.queue && state.queue.inFlight === chatOpen);
  var s = view.chat && view.chat.blocked ? ['down', 'blocked']
    : !view.reporting ? ['down', 'agent not reporting']
      : busy ? ['busy', 'replying now']
        : view.live ? ['live', 'session open']
          : ['', 'no session open'];
  dot.className = 'dot' + (s[0] ? ' ' + s[0] : '');
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', 'Session: ' + s[1]);
  says.textContent = s[1];
}

// ── Folding the timeline ────────────────────────────────────────────────────

/**
 * The harness's own prompts, which are not somebody speaking.
 *
 * A `prompt` item is a line typed at Juan's prompt, which in practice means an
 * operator typed it here — except when it does not. A skill being loaded, a
 * slash command's output and a hook's injection all arrive on the same line
 * type, and rendering one as an operator's message puts a wall of SKILL.md in
 * the panel in a voice nobody used. System reminders are cut out rather than
 * rejected, because they are appended to real prompts and dropping the whole
 * message would eat the operator's words to hide the harness's.
 */
var INJECTED = [
  '<command-name>', '<command-message>', '<local-command-stdout>',
  '<user-prompt-submit-hook>', 'Base directory for this skill:',
  'Caveat: The messages below were generated by the user'
];

function spokenPrompt(text) {
  var t = String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!t) return null;
  for (var i = 0; i < INJECTED.length; i++) if (t.indexOf(INJECTED[i]) === 0) return null;
  return t;
}

/**
 * Strip anything that identifies a machine, a file or a person, and shorten.
 *
 * Order matters. A path goes first so that `/workspace/chats/<key>/out.txt`
 * becomes `out.txt` — running the hex rule first would leave the path shape
 * behind with a hole in it, which is longer and says no less.
 */
function mask(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\/(?:[\w.@+-]+\/)+([\w.@+-]+)/g, '$1')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…')
    .replace(/[0-9a-f]{16,}/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110);
}

/** A URL reduced to the site it is on. */
function host(url) {
  var m = /https?:\/\/([^/\s"']+)/i.exec(String(url || ''));
  return m ? m[1].replace(/^www\./, '') : mask(url);
}

/** A command line reduced to the program it runs, and nothing else. */
function program(command) {
  var rest = String(command || '').replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/, '');
  var first = (rest.split(/\s+/)[0] || '').replace(/^.*\//, '');
  return first.slice(0, 40);
}

/** The first argument, masked — a filename, a page name, a window. */
function firstWord(rest) {
  var t = String(rest || '').trim().replace(/^["']|["']$/g, '');
  return mask(t.split(/\s+/)[0] || '');
}

/** Everything after the verb, masked — a query, a prompt, Juan's own words. */
function words(rest) {
  var t = String(rest || '').trim();
  // A leading flag and its value belong to the command, not to what was said.
  t = t.replace(/^--[a-z-]+(?:[ =](?:"[^"]*"|'[^']*'|\S+))?\s*/i, '');
  t = t.replace(/^["']/, '').replace(/["']\s*$/, '');
  return mask(t);
}

/**
 * Juan's own voice, which is a command line.
 *
 * Everything he does to a conversation goes through `tulip-wa`, so the verb of
 * that command is the single most useful thing on this page: "Made a picture",
 * not `Bash` beside `tulip-wa image "a tulip in a…"`. Two of them are pure
 * machinery and are mapped to null — the typing indicator he raises on every
 * turn, and the call that asks which conversation he is in — because listing
 * them buries the steps that are actually about the person.
 */
var WA = {
  send: ['Replied', null],
  file: ['Sent a file', firstWord],
  image: ['Made a picture', words],
  voice: ['Sent a voice note', null],
  gif: ['Sent a GIF', words],
  react: ['Reacted', words],
  quiet: ['Chose not to reply', null],
  remember: ['Remembered this', words],
  search: ['Searched the web', words],
  fetch: ['Read a web page', host],
  chats: ['Listed his chats', null],
  'page-new': ['Started a page', firstWord],
  'page-image': ['Made a picture', firstWord],
  page: ['Published a page', firstWord],
  typing: null,
  whoami: null
};

/** Everything else Claude Code reaches for, in the past tense a person reads. */
var TOOLS = {
  BashOutput: ['Checked a command', null],
  Read: ['Read a file', mask],
  Write: ['Wrote a file', mask],
  Edit: ['Edited a file', mask],
  MultiEdit: ['Edited a file', mask],
  NotebookEdit: ['Edited a notebook', mask],
  Grep: ['Searched the files', mask],
  Glob: ['Looked for files', mask],
  WebFetch: ['Read a web page', host],
  WebSearch: ['Searched the web', mask],
  Task: ['Sent a helper off', mask],
  TodoWrite: ['Made a plan', null],
  TodoRead: ['Checked his plan', null]
};

function bashStep(command) {
  var wa = /(?:^|[;&|]\s*)tulip-wa\s+([a-z-]+)/.exec(String(command || ''));
  if (wa === null) return { verb: 'Ran a command', detail: program(command) };
  var rest = String(command).slice(wa.index + wa[0].length);
  if (wa[1] === 'send' && /^\s*--to\b/.test(rest)) {
    // The key is masked either way; naming the chat would be worse, not better.
    return { verb: 'Messaged elsewhere', detail: '' };
  }
  var entry = WA[wa[1]];
  if (entry === undefined) return { verb: 'Ran a command', detail: 'tulip-wa ' + mask(wa[1]) };
  if (entry === null) return null;
  return { verb: entry[0], detail: entry[1] ? entry[1](rest) : '' };
}

function toolStep(name, text) {
  if (name === 'Bash') return bashStep(text);
  var entry = TOOLS[name];
  // An unmapped tool keeps its own name rather than being swallowed by a
  // generic verb: a step nobody has written a sentence for should be visible.
  if (entry === undefined) return { verb: mask(name).slice(0, 24), detail: mask(text) };
  return { verb: entry[0], detail: entry[1] ? entry[1](text) : '' };
}

function stepFor(item) {
  if (item.kind === 'tool') return toolStep(item.tool || 'tool', item.text || '');
  // Juan's own words in session. Nobody received them, which is exactly why
  // they are here and not in the message column.
  if (item.kind === 'note') return { verb: 'Noted to himself', detail: item.text, prose: true };
  if (item.kind === 'thought') return { verb: 'Thought it over', detail: item.text, prose: true, fold: true };
  return null;
}

/**
 * The timeline as rows: speech, and the bands between it.
 *
 * A band opens at the first thing that is not speech and closes at the next
 * thing that is — which makes "one band" mean "everything Juan did between two
 * things a person would recognise as talking", and that is the unit an operator
 * actually reads. The supervisor's own turn boundary is dropped: the incoming
 * message right above it already marks the same moment.
 */
function foldTimeline(items) {
  var rows = [];
  var band = null;
  items.forEach(function (item) {
    if (item.kind === 'said') {
      band = null;
      rows.push({ row: 'msg', item: item });
      return;
    }
    if (item.kind === 'prompt') {
      var said = spokenPrompt(item.text);
      if (said === null) return;
      band = null;
      rows.push({ row: 'msg', item: { ts: item.ts, kind: 'prompt', text: said } });
      return;
    }
    if (item.kind === 'turn') { band = null; return; }
    var step = stepFor(item);
    if (step === null) return;
    if (band === null) { band = { row: 'work', ts: item.ts, steps: [] }; rows.push(band); }
    band.steps.push(step);
  });
  return rows;
}

/** What a band did, as one sentence. Consecutive repeats count once. */
function narrate(steps) {
  var verbs = [];
  steps.forEach(function (s) { if (verbs[verbs.length - 1] !== s.verb) verbs.push(s.verb); });
  if (!verbs.length) return 'Did something';
  if (verbs.length === 1) return verbs[0] + '.';
  if (verbs.length === 2) return verbs[0] + ', then ' + lower(verbs[1]) + '.';
  return verbs[0] + ', ' + lower(verbs[1]) + ', then ' + lower(verbs[verbs.length - 1]) + '.';
}
function lower(v) { return v.charAt(0).toLowerCase() + v.slice(1); }

// ── Painting ────────────────────────────────────────────────────────────────

function bandNode(band, busy) {
  var wrap = node('div', 'work' + (busy ? ' busy' : ''));
  var key = 'b' + band.ts;
  var open = chatBands[key] === true;

  var toggle = node('button', 'work-open');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.appendChild(node('span', 'caret', '›'));
  // While it is running the newest verb is the interesting line; once it has
  // finished that same line is a confusing caption for the whole of it, and the
  // reply underneath already says what came of it.
  var lead = busy
    ? (band.steps.length ? band.steps[band.steps.length - 1].verb + '…' : 'Working…')
    : narrate(band.steps);
  toggle.appendChild(node('span', 'what', lead));
  toggle.appendChild(node('span', 'n', plural(band.steps.length, 'step')));
  toggle.setAttribute('aria-label', lead + ' ' + plural(band.steps.length, 'step') + '. Show them.');

  var steps = node('div', 'work-steps');
  steps.hidden = !open;
  band.steps.forEach(function (s, i) { steps.appendChild(stepNode(s, key + ':' + i)); });

  toggle.addEventListener('click', function () {
    var was = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', was ? 'false' : 'true');
    steps.hidden = was;
    chatBands[key] = !was;
  });

  wrap.appendChild(toggle);
  wrap.appendChild(steps);
  return wrap;
}

function stepNode(s, key) {
  var row = node('div', 'step' + (s.prose ? ' prose' : ''));
  row.appendChild(node('div', 'verb', s.verb));
  var detail = node('div', 'detail');

  if (!s.prose) {
    // Empty when there is nothing worth saying. Half these verbs are complete
    // on their own, and a column of placeholder dashes beside them is noise.
    detail.textContent = s.detail || '';
  } else if (s.fold) {
    var open = chatProse[key] === true;
    var count = plural(String(s.detail).split(/\s+/).length, 'word');
    var more = node('button', 'more', (open ? '▾ ' : '▸ ') + count);
    more.type = 'button';
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
    var body = node('div', 'thinking', s.detail);
    body.hidden = !open;
    more.addEventListener('click', function () {
      var was = more.getAttribute('aria-expanded') === 'true';
      more.setAttribute('aria-expanded', was ? 'false' : 'true');
      body.hidden = was;
      chatProse[key] = !was;
      more.textContent = (was ? '▸ ' : '▾ ') + count;
    });
    detail.appendChild(more);
    detail.appendChild(body);
  } else {
    detail.textContent = s.detail;
  }
  row.appendChild(detail);
  return row;
}

function dayLabel(ts) {
  var d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function msgNode(item, side, run) {
  var msg = node('div', 'msg ' + side + (run ? ' run' : ''));
  msg.appendChild(node('div', 'body', item.text));
  msg.appendChild(node('span', 'at', hhmm(item.ts)));
  return msg;
}

function nameNode(name, lane) {
  return node('span', 'said-by' + (lane === 'them' ? '' : ' mine') + (lane === 'op' ? ' op' : ''), name);
}

function paintThread(view) {
  var thread = el('chatThread');
  if (!thread) return;
  var rows = foldTimeline(view.items);
  var busy = !!(state && state.queue && state.queue.inFlight === chatOpen);
  var frag = document.createDocumentFragment();

  if (!rows.length && !chatPending.length) frag.appendChild(quietNote(view));

  var side = null, who = null, at = 0, day = '';
  rows.forEach(function (r, i) {
    if (r.row === 'work') {
      frag.appendChild(bandNode(r, busy && i === rows.length - 1));
      side = null;
      return;
    }
    var item = r.item;
    var stamp = new Date(item.ts).toDateString();
    if (stamp !== day) {
      frag.appendChild(node('span', 'daymark', dayLabel(item.ts)));
      day = stamp;
      side = null;
    }

    var lane = item.kind === 'prompt' ? 'op' : item.direction === 'out' ? 'juan' : 'them';
    var name = item.kind === 'prompt' ? 'You, at Juan’s prompt'
      : lane === 'juan' ? 'Juan' : (item.who || 'Someone');
    // A run is the same voice again within a few minutes. Repeating the name on
    // every bubble is what makes a thread read as a table of rows.
    var run = lane === side && name === who && (item.ts - at) < 240000;
    if (!run) frag.appendChild(nameNode(name, lane));
    frag.appendChild(msgNode(item, lane, run));
    side = lane; who = name; at = item.ts;
  });

  chatPending.forEach(function (p) {
    frag.appendChild(nameNode('You, at Juan’s prompt', 'op'));
    var msg = msgNode({ ts: p.at, text: p.text }, 'op', false);
    msg.classList.add('pending');
    frag.appendChild(msg);
  });

  // An open band is already the indicator; two of them at once says the same
  // thing twice and in two places.
  if (busy && !(rows.length && rows[rows.length - 1].row === 'work')) {
    var dots = node('div', 'typing');
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'Juan is replying');
    dots.title = 'Juan is replying';
    dots.appendChild(node('i'));
    dots.appendChild(node('i'));
    dots.appendChild(node('i'));
    frag.appendChild(dots);
  }

  var pinned = atThreadBottom(thread);
  var had = thread.childElementCount > 0;
  clear(thread);
  thread.appendChild(frag);
  if (pinned) { thread.scrollTop = thread.scrollHeight; chatMissed = false; }
  else if (had) chatMissed = true;
  paintJump();
}

/**
 * An empty thread, which is the ordinary resting state rather than a failure.
 *
 * Every conversation ends up here: the session closes, and the next message
 * opens a new one. Written as direction, in the same terms the send route uses
 * when it refuses, so the two cannot drift apart.
 */
function quietNote(view) {
  var box = node('p', 'thread-note');
  if (view.chat && view.chat.blocked) {
    box.appendChild(node('b', null, 'This chat is blocked'));
    box.appendChild(document.createTextNode(
      'Nothing reaches Juan from here and nothing goes back. Unblock it on the Chats page to let it run again.'));
    return box;
  }
  if (!view.reporting) {
    box.appendChild(node('b', null, 'The agent is not reporting'));
    box.appendChild(document.createTextNode(
      'There is no session to read. The container is the thing to look at — nothing is lost meanwhile.'));
    return box;
  }
  box.appendChild(node('b', null, 'Nothing said yet'));
  box.appendChild(document.createTextNode(
    'A session opens on their next message, and everything Juan does in it appears here.'));
  return box;
}

function atThreadBottom(thread) {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
}

function onThreadScroll() {
  var thread = el('chatThread');
  if (!thread) return;
  if (atThreadBottom(thread)) chatMissed = false;
  paintJump();
}

/**
 * The pill has two meanings and only one of them is news.
 *
 * Parked because you scrolled up to reread is navigation; parked while it kept
 * talking is something you have not seen. It is hidden entirely at the bottom,
 * because a control that is always there is one that usually does nothing.
 */
function paintJump() {
  var thread = el('chatThread'), jump = el('chatJump');
  if (!thread || !jump) return;
  var parked = !atThreadBottom(thread);
  jump.hidden = !parked;
  jump.classList.toggle('new', parked && chatMissed);
  jump.textContent = chatMissed ? 'New messages' : 'Jump to latest';
}

/**
 * Hold the thread at the bottom while the first paint settles.
 *
 * One assignment is not enough: the two webfonts land after first paint and
 * reflow the whole thread at once, which leaves the reader a screen short of
 * the newest line with no idea it happened. So it is re-asserted for a second
 * and a half, and released the instant anybody scrolls — pinning that fights
 * the reader is worse than not pinning.
 */
function pinThread() {
  var thread = el('chatThread');
  if (!thread) return;
  var until = Date.now() + 1500;
  var released = false;
  function release() { released = true; }
  ['wheel', 'touchstart', 'keydown'].forEach(function (ev) {
    thread.addEventListener(ev, release, { once: true, passive: true });
  });
  function pin() {
    if (released || !thread.isConnected || el('chatThread') !== thread) return;
    thread.scrollTop = thread.scrollHeight;
    chatMissed = false;
    paintJump();
    if (Date.now() < until) setTimeout(pin, 100);
  }
  pin();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(pin, function () { /* no faces to wait for */ });
  }
}

// ── The composer ────────────────────────────────────────────────────────────

function composer() {
  var wrap = node('div', 'composer');
  // The ground and the rule above it span the pane; the field does not.
  var cap = node('div', 'cap');
  wrap.appendChild(cap);

  var why = node('p', 'why');
  why.id = 'chatWhy';
  why.appendChild(node('span', 'dot'));
  var line = node('span', null, '');
  line.id = 'chatWhyText';
  why.appendChild(line);
  cap.appendChild(why);

  var row = node('div', 'row');
  var box = document.createElement('textarea');
  box.id = 'chatBox';
  box.rows = 1;
  box.maxLength = 2000;
  box.placeholder = 'Type into Juan’s session…';
  box.setAttribute('aria-describedby', 'chatWhyText');
  box.addEventListener('input', function () { growBox(box); paintCount(box); });
  box.addEventListener('keydown', function (ev) {
    // Chat convention: Enter sends, Shift+Enter is a new line.
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    ev.preventDefault();
    var send = el('chatSend');
    if (send && send.disabled) { toast(el('chatWhyText').textContent, true); return; }
    confirmSend(box);
  });
  row.appendChild(box);

  var send = node('button', 'primary', 'Send');
  send.type = 'button';
  send.id = 'chatSend';
  send.addEventListener('click', function () { confirmSend(box); });
  row.appendChild(send);
  cap.appendChild(row);

  var count = node('span', 'count', '');
  count.id = 'chatCount';
  count.setAttribute('aria-live', 'polite');
  cap.appendChild(count);
  return wrap;
}

function growBox(box) {
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight, 168) + 'px';
}

/** Only near the cap. A counter that is always there is one nobody reads. */
function paintCount(box) {
  var count = el('chatCount');
  if (!count) return;
  var n = box.value.length;
  count.textContent = n > 1700 ? n + ' / 2000' : '';
  count.classList.toggle('near', n > 1900);
}

/**
 * Whether there is anywhere to type, and what to do when there is not.
 *
 * The field itself stays live in every state. Drafting a line while a chat is
 * asleep is a normal thing to want, and a dead box is the panel deciding you
 * may not think about it yet; what is refused is the send, which is the only
 * part that could go wrong.
 */
function paintComposer(view) {
  var send = el('chatSend'), why = el('chatWhy'), line = el('chatWhyText');
  if (!send || !why || !line) return;
  var name = (view && view.chat && view.chat.name) || 'this person';
  var blocked = !!(view && view.chat && view.chat.blocked);

  var tone = 'live';
  var says = 'Live. ' + name + ' is on the other end of this session.';
  if (blocked) {
    tone = 'bad';
    says = 'This chat is blocked — nothing reaches Juan from ' + name + ', and nothing goes back.';
  } else if (view && !view.reporting) {
    tone = 'warn';
    says = 'The agent is not reporting, so there is nothing to type into.';
  } else if (view && !view.live) {
    tone = '';
    says = 'No session open. Juan wakes for ' + name
      + ' on their next message — you can draft here meanwhile.';
  }

  why.className = 'why' + (tone ? ' ' + tone : '');
  line.textContent = says;
  var can = !!view && view.reporting && view.live && !blocked;
  send.disabled = !can;
  send.textContent = can ? 'Send to ' + firstName(name) : 'Send';
}

/** Enough of a name to address, short enough to sit on a button. */
function firstName(name) {
  return String(name).trim().split(/\s+/)[0].slice(0, 16);
}

/**
 * Confirm, then send.
 *
 * A second step for something with no undo: the line goes into a running Claude
 * Code prompt inside a conversation with a member of the public. The dialog
 * shows the exact text that will be typed rather than what was in the box,
 * because the two differ whenever the box held a line break — and the confirm
 * takes the focus, so a send is Enter and Enter rather than a trip to the mouse.
 */
function confirmSend(box) {
  var raw = box.value;
  var line = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) { toast('Nothing to send.'); return; }
  var view = chatView || {};
  var who = (view.chat && view.chat.name) || 'this person';
  var key = chatOpen;

  openModal('Type this into Juan’s session?',
    'He is mid-conversation with ' + who + ' on WhatsApp.',
    function (body, modal, dismiss) {
      body.appendChild(node('p', 'hint',
        'This is typed at Juan’s prompt exactly as written, as though it had arrived in the '
        + 'conversation. What he does with it is his — including anything he sends to ' + who
        + '. It cannot be recalled.'));
      body.appendChild(node('blockquote', 'said', line));
      if (line !== raw.trim()) {
        body.appendChild(node('p', 'hint',
          'Line breaks became spaces: a newline at the prompt submits the message halfway through.'));
      }

      var actions = node('div', 'modal-actions');
      var cancel = node('button', 'sm', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', dismiss);
      var go_ = node('button', 'sm primary', 'Type it to ' + firstName(who));
      go_.type = 'button';
      go_.addEventListener('click', async function () {
        go_.disabled = true;
        try {
          var result = await api('/api/chat/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: key, text: line })
          });
          toast(result.message || 'Typed.');
          box.value = '';
          growBox(box);
          paintCount(box);
          // Shown faded until the transcript reads it back, which is up to a
          // poll away — long enough for a send to look as though it did nothing.
          chatPending.push({ key: key, text: line, at: Date.now() });
          chatSig = null;
          dismiss();
          void refreshThread();
        } catch (err) { go_.disabled = false; toast(err.message, true); }
      });
      actions.appendChild(cancel);
      actions.appendChild(go_);
      body.appendChild(actions);
    });

  // `openModal` focuses the body's first control, which is the quoted line's
  // Cancel. The one that matters here is the other one.
  var confirm = document.querySelector('#scrim .modal-actions button.primary');
  if (confirm) confirm.focus();
}

/** Drop the faded copies the transcript has now read back, and any stale ones. */
function prunePending(view) {
  var now = Date.now();
  chatPending = chatPending.filter(function (p) {
    if (p.key !== chatOpen) return false;
    // Two minutes. If it has not appeared by then it never will, and a copy
    // that stays forever is a claim the panel cannot support.
    if (now - p.at > 120000) return false;
    for (var i = view.items.length - 1; i >= 0; i--) {
      if (view.items[i].kind === 'prompt' && view.items[i].text === p.text) return false;
    }
    return true;
  });
}

/**
 * Reconcile the open conversation with a fresh state snapshot.
 *
 * Called from the state poll rather than from `render()`: this page owns a poll
 * and a text box, and repainting it every five seconds would restart the one
 * and empty the other.
 */
function paintChatLive() {
  paintConvoList();
  if (!chatOpen || !chatView) return;
  paintHead(chatView);
  var sig = signature(chatView);
  if (sig === chatSig) return;
  chatSig = sig;
  paintThread(chatView);
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
 * Tulip's brief, as the agent receives it.
 *
 * Thirty-three kilobytes of prose across four documents, one of which is twenty
 * on its own. Printed end to end it is unreadable — not badly styled, actually
 * unreadable: an operator looking for what Tulip believes about groups has no
 * way in but a scroll bar.
 *
 * So one part at a time, with its own headings beside it as a way in. The two
 * questions an operator actually arrives with are "which document says that"
 * and "what does it say about X", and this answers both without reading.
 *
 * Read-only, deliberately: these files reach a conversation when its session
 * next spawns, so an editor here would promise a change it cannot deliver.
 */
var personaPart = 0;

async function renderPersona() {
  var p = head('persona', 'Persona', 'What Tulip has been told to be. These four are assembled in order into every chat’s brief when its session starts — so a conversation already running keeps the version it began with.'), mine = renderToken;

  var data;
  try { data = await api('/api/persona'); } catch (err) { p.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(mine)) return;

  var seg = node('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Which part of the brief');
  var body = node('div', 'personabody');

  function show(i) {
    personaPart = i;
    Array.prototype.forEach.call(seg.children, function (b, n) {
      b.setAttribute('aria-pressed', n === i ? 'true' : 'false');
    });
    clear(body);
    var part = data.parts[i];
    if (!part || part.text === null) {
      body.appendChild(node('p', 'empty', 'Missing from this build.'));
      return;
    }
    var doc = markdown(part.text);

    // The contents are built from the rendered headings rather than from the
    // source, so the two can never disagree about what is in the document.
    var toc = node('nav', 'doctoc');
    toc.setAttribute('aria-label', 'Contents');
    var heads = doc.querySelectorAll('h3');
    if (heads.length > 1) {
      Array.prototype.forEach.call(heads, function (h, n) {
        h.id = 'doc-' + i + '-' + n;
        var a = node('a', null, h.textContent);
        a.href = '#' + h.id;
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        toc.appendChild(a);
      });
      body.appendChild(toc);
    }
    var col = node('div', 'doccol');
    col.appendChild(node('p', 'docmeta', part.name + ' · ' + bytes(part.bytes)));
    col.appendChild(doc);
    body.appendChild(col);
  }

  data.parts.forEach(function (part, i) {
    var b = node('button', null, part.name.replace('.md', ''));
    b.type = 'button';
    b.addEventListener('click', function () { show(i); });
    seg.appendChild(b);
  });

  p.appendChild(seg);
  p.appendChild(body);
  show(Math.min(personaPart, data.parts.length - 1));
}

/**
 * Enough markdown to read a brief, and no more.
 *
 * Deliberately not a parser. Every piece of the file becomes a **text node** —
 * `inline()` builds `<strong>` and `<code>` elements itself and puts the file's
 * characters inside them, so nothing in these documents can become markup. They
 * are instructions written to be obeyed by an agent; the panel renders text
 * written by strangers under a CSP that exists for this reason, and a brief is
 * not an exception to it.
 */
function inline(text, into) {
  // Split on **bold** and `code`, keeping the delimiters so each run can be
  // wrapped in an element this function created rather than one the file named.
  var parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  parts.forEach(function (run) {
    if (!run) return;
    if (run.length > 4 && run.slice(0, 2) === '**' && run.slice(-2) === '**') {
      into.appendChild(node('strong', null, run.slice(2, -2)));
    } else if (run.length > 2 && run[0] === '`' && run[run.length - 1] === '`') {
      into.appendChild(node('code', null, run.slice(1, -1)));
    } else {
      into.appendChild(document.createTextNode(run));
    }
  });
  return into;
}

function markdown(src) {
  var out = node('div', 'doc');
  var lines = src.split('\n');
  var block = null;
  var list = null;

  function endList() { if (list) { out.appendChild(list); list = null; } }

  lines.forEach(function (line) {
    var t = line.trim();

    if (t.indexOf('```') === 0) {
      endList();
      if (block) { out.appendChild(block); block = null; } else { block = node('pre'); }
      return;
    }
    if (block) { block.appendChild(document.createTextNode(line + '\n')); return; }
    if (t === '') { endList(); return; }
    if (/^-{3,}$/.test(t)) { endList(); out.appendChild(node('hr')); return; }

    if (t.indexOf('#### ') === 0) { endList(); out.appendChild(inline(t.slice(5), node('h5'))); return; }
    if (t.indexOf('### ') === 0) { endList(); out.appendChild(inline(t.slice(4), node('h4'))); return; }
    if (t.indexOf('## ') === 0) { endList(); out.appendChild(inline(t.slice(3), node('h3'))); return; }
    if (t.indexOf('# ') === 0) { endList(); out.appendChild(inline(t.slice(2), node('h3'))); return; }
    if (t.indexOf('> ') === 0) { endList(); out.appendChild(inline(t.slice(2), node('blockquote'))); return; }
    if (line.indexOf('    ') === 0) { endList(); out.appendChild(node('pre', null, line.trim())); return; }

    if (/^[-*] /.test(t)) {
      if (!list) list = node('ul');
      list.appendChild(inline(t.slice(2), node('li')));
      return;
    }
    endList();
    out.appendChild(inline(t, node('p')));
  });
  if (block) out.appendChild(block);
  endList();
  return out;
}

/**
 * What the agent remembers, and where each note came from.
 *
 * The one page that shows state crossing conversations. Everything else in
 * Tulip is sealed per chat; this is the exception, so it is listed rather than
 * trusted — with the chat that taught each note, because "who told it that" is
 * the question you will actually have.
 */
async function renderMemory() {
  var p = head('memory', 'Memory', 'Things the agent has been asked to remember. Unlike everything else here, these are shared by every conversation — what it learns in one chat it knows in all of them, including with people it has not met yet.'), mine = renderToken;
  var card = node('div', 'card');
  p.appendChild(card);

  var data;
  try { data = await api('/api/memory'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(mine)) return;

  if (!data.notes.length) { card.appendChild(node('p', 'empty', 'Nothing remembered yet.')); return; }

  data.notes.slice().reverse().forEach(function (n) {
    var row = node('div', 'entry');
    var left = node('div');
    left.appendChild(node('div', null, n.text));
    left.appendChild(node('div', 'hint', 'from ' + (n.chatName || n.chatKey) + ' · ' + ago(Date.now() - Date.parse(n.at))));
    row.appendChild(left);
    var bin = node('button', 'sm danger', 'Forget');
    bin.type = 'button';
    bin.addEventListener('click', function () {
      if (!window.confirm('Forget this?\n\n' + n.text)) return;
      act('memory/forget', null, '?id=' + encodeURIComponent(n.id));
    });
    row.appendChild(bin);
    card.appendChild(row);
  });

  var all = node('button', 'sm danger', 'Forget everything');
  all.type = 'button';
  all.style.marginTop = '16px';
  all.addEventListener('click', function () {
    if (!window.confirm('Forget all ' + data.notes.length + ' remembered notes?\n\nNothing keeps a copy.')) return;
    act('memory/forget', null, '?id=all');
  });
  card.appendChild(all);
}

/**
 * What the agent has published.
 *
 * The listing is the point of this page rather than a convenience: these are
 * public, they are on your own domain, and the agent wrote them. Knowing one
 * exists comes first, and being able to take it down without a shell comes
 * second.
 */
async function renderPages() {
  var p = head('pages', 'Pages', 'Small web pages the agent has built. Anyone with the link can open one, and it stays until you remove it — the agent has no network, so a page can keep state in the browser and cannot send anything anywhere.'), mine = renderToken;
  var card = node('div', 'card');
  p.appendChild(card);

  var data;
  try { data = await api('/api/pages'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(mine)) return;

  if (!data.host) {
    card.appendChild(node('p', 'empty',
      'No page hostname is configured, so the agent cannot publish. Pages need their own hostname: served from this one, a page’s JavaScript would share an origin with your session here.'));
    return;
  }
  if (!data.items.length) { card.appendChild(node('p', 'empty', 'Nothing published yet.')); return; }

  data.items.forEach(function (page) {
    var row = node('div', 'entry');
    var link = node('a', 'value', page.slug);
    link.href = page.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    row.appendChild(link);
    row.appendChild(node('span', 'meta', plural(page.files, 'file') + ' · ' + bytes(page.bytes) + ' · ' + ago(Date.now() - page.at)));
    var bin = node('button', 'sm danger', 'Delete');
    bin.type = 'button';
    bin.addEventListener('click', function () {
      if (!window.confirm('Delete the page “' + page.slug + '”?\n\nThe link stops working immediately, and nothing keeps a copy.')) return;
      act('pages/delete', null, '?slug=' + encodeURIComponent(page.slug));
    });
    row.appendChild(bin);
    card.appendChild(row);
  });
}

// The Terminal page is gone. The raw pane carries every open conversation at
// once, so it is not a destination of its own any more — it opens from the
// Chat page, over the conversation it belongs to. `openTerminal` below is the
// modal it opens, unchanged; only where it is launched from moved.

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
  // Deliberately not in NEEDS_STATE: this page owns a poll and a text box, and
  // repainting it every five seconds would restart the one and empty the other.
  // `paintChatLive` is what a poll calls instead.
  else if (route === 'chat') renderChat();
  else if (route === 'media') renderMedia();
  else if (route === 'pages') void renderPages();
  else if (route === 'memory') void renderMemory();
  else if (route === 'persona') void renderPersona();
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
  // Chat reconciles rather than re-renders: the list's dots and previews, the
  // header's state and the typing indicator all move with the snapshot, and
  // none of them is a reason to throw away a half-typed message.
  else if (route === 'chat') paintChatLive();
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
var chatPushPending = null;
stream.onmessage = function (ev) {
  if (route === 'messages') {
    // Coalesce: a burst of entries should repaint once, not once each.
    clearTimeout(feedPending);
    feedPending = setTimeout(function () { renderMessages(); }, 400);
    return;
  }
  if (route !== 'chat') return;
  // A message arriving is the one thing a poll should not make you wait for.
  // The feed carries the chat key, so this only wakes the conversation on
  // screen; everything else still moves at the poll's pace.
  var row = null;
  try { row = JSON.parse(ev.data); } catch (err) { return; }
  clearTimeout(chatPushPending);
  chatPushPending = setTimeout(function () {
    void loadChatFeed();
    if (row && row.chatKey && row.chatKey === chatOpen) void refreshThread();
  }, 350);
};

refresh();
setInterval(refresh, 5000);
