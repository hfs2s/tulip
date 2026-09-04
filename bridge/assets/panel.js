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
  if (route === 'terminal') startTerminal(); else stopTerminal();
  var scroller = document.querySelector('main');
  if (scroller) scroller.scrollTop = 0;
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
var renderToken = 0;
function head(page, title, sub) {
  var p = clear(el('p-' + page));
  p.appendChild(node('h2', null, title));
  p.appendChild(node('p', 'sub', sub));
  p.dataset.token = String(++renderToken);
  return p;
}
/** Has another render started since this one began? */
function stale(p) { return p.dataset.token !== String(renderToken); }

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
  if (stale(p)) return;
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
  if (stale(p)) return;
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
// Two views of one pane. Raw is the literal capture. Readable parses the TUI
// into what actually happened, and masks the scaffolding — the injected prompt
// is a pointer to a batch file with a UUID in it, which tells an operator
// nothing and pushes the part they wanted off the line. Same instinct as the
// hfs2s waiting screen: show the notes, not the pane.

var termView = 'readable';

/** One entry per meaningful line in the pane. */
function digestPane(text) {
  var out = [];
  var lines = String(text || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var line = raw.replace(/\s+$/, '');
    var t = line.trim();
    if (!t) continue;

    // The prompt the supervisor typed. Everything useful in it is the fact that
    // a message arrived; the batch path is scaffolding.
    if (t.indexOf('❯') === 0) {
      var body = t.slice(1).trim();
      if (!body) continue;
      var m = body.match(/^New WhatsApp message(s \((\d+)\))?\./);
      if (m) {
        out.push({ kind: 'prompt', text: m[2] ? m[2] + ' new messages handed over' : 'New message handed over' });
      } else {
        out.push({ kind: 'typed', text: body });
      }
      continue;
    }

    // The agent's own summary of the turn.
    if (t.indexOf('●') === 0) { out.push({ kind: 'result', text: t.slice(1).trim() }); continue; }

    // A tool result or an error.
    if (t.indexOf('⎿') === 0) {
      var d = t.replace(/^⎿\s*/, '');
      out.push({ kind: /error|too low|invalid|expired|limit/i.test(d) ? 'error' : 'tool', text: d });
      continue;
    }

    // Timing footer: "✻ Cooked for 21s · done 9:21 PM"
    if (t.indexOf('✻') === 0) {
      var f = t.slice(1).trim().match(/for\s+(\S+).*?done\s+(.+)$/i);
      out.push({ kind: 'status', text: f ? 'took ' + f[1] + ' · ' + f[2] : t.slice(1).trim() });
      continue;
    }

    if (/^Thought for /.test(t)) { out.push({ kind: 'activity', text: t }); continue; }
    if (/esc to interrupt/i.test(t)) { out.push({ kind: 'working', text: 'working…' }); continue; }

    // Box drawing, the footer hint bar, and the banner are chrome.
    if (/^[─━╌╭╰│┌└▐▝▛▜█▀]/.test(t)) continue;
    if (/bypass permissions on|for shortcuts|Claude Code v/.test(t)) continue;
  }
  return out;
}

function renderTerminal() {
  var p = head('terminal', 'Terminal', 'The agent’s live session. A pane view with key injection — not a shell on the host, and not a PTY.');

  p.appendChild(node('div', 'warnbar', 'Anything you type goes into a live conversation with a member of the public.'));

  var controls = node('div', 'controls');

  var seg = node('div', 'seg');
  [['readable', 'Readable'], ['raw', 'Raw']].forEach(function (v) {
    var b = node('button', null, v[1]);
    b.type = 'button';
    b.setAttribute('aria-pressed', termView === v[0] ? 'true' : 'false');
    b.addEventListener('click', function () { termView = v[0]; renderTerminal(); pollTerminal(); });
    seg.appendChild(b);
  });
  controls.appendChild(seg);

  var select = document.createElement('select');
  select.id = 'termWindows';
  select.addEventListener('change', function () { termWindow = select.value || null; pollTerminal(); });
  controls.appendChild(select);

  ['Enter', 'Escape', 'C-c'].forEach(function (k) {
    var b = node('button', 'sm', k);
    b.type = 'button';
    b.addEventListener('click', function () { sendKeys([{ text: k, literal: false }]); });
    controls.appendChild(b);
  });
  p.appendChild(controls);

  // The transcript, and an inline prompt that is part of it rather than a
  // separate form. Clicking anywhere in the slab focuses the prompt, so it
  // behaves like a terminal you type into.
  var slab = node('div', 'slab');
  slab.id = 'termSlab';
  slab.appendChild(node('div', 'muted', 'Waiting for the agent to publish a frame…'));
  p.appendChild(slab);

  var promptRow = node('div', 'termprompt');
  promptRow.appendChild(node('span', 'caret', '❯'));
  var input = document.createElement('input');
  input.type = 'text';
  input.id = 'termInput';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'type here and press Enter — this goes straight into the session';
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      var text = input.value;
      if (!text) return;
      sendKeys([{ text: text, literal: true }]);
      input.value = '';
    } else if (ev.key === 'Escape') {
      sendKeys([{ text: 'Escape', literal: false }]);
    }
  });
  promptRow.appendChild(input);
  p.appendChild(promptRow);

  slab.addEventListener('click', function (ev) {
    if (String(window.getSelection())) return; // let people copy text
    input.focus();
  });
}

function paintTerminal(screen) {
  var slab = el('termSlab');
  if (!slab) return;
  var atBottom = slab.scrollTop + slab.clientHeight >= slab.scrollHeight - 40;
  clear(slab);

  if (termView === 'raw') {
    slab.classList.add('rawview');
    slab.appendChild(document.createTextNode(screen.content || '(no session is running)'));
  } else {
    slab.classList.remove('rawview');
    var entries = digestPane(screen.content);
    if (!entries.length) {
      slab.appendChild(node('div', 'muted', '(nothing on screen yet)'));
    } else {
      entries.forEach(function (e) {
        var row = node('div', 'tline ' + e.kind);
        row.appendChild(node('span', 'tmark', e.kind === 'prompt' ? '→'
          : e.kind === 'typed' ? '⌨'
          : e.kind === 'result' ? '●'
          : e.kind === 'error' ? '!'
          : e.kind === 'tool' ? '⎿'
          : e.kind === 'working' ? '…' : '·'));
        row.appendChild(node('span', 'ttext', e.text));
        slab.appendChild(row);
      });
    }
  }
  if (atBottom) slab.scrollTop = slab.scrollHeight;
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
  setTimeout(pollTerminal, 700);
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
    paintTerminal(screen);

    var select = el('termWindows');
    if (select && screen.windows) {
      var want = screen.windows.join('|');
      if (select.dataset.have !== want) {
        select.dataset.have = want;
        clear(select);
        screen.windows.forEach(function (w) {
          var o = document.createElement('option');
          o.value = w;
          // A chat key is not a name. Show who it is where we know.
          var chat = state && state.chats ? state.chats.filter(function (c) { return 'c-' + c.chatKey === w; })[0] : null;
          o.textContent = chat ? (chat.name || 'someone') + ' · ' + chat.chatKey.slice(0, 6) : w;
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
    if (!body.ok) { toast(body.message); if (revert) revert(); return false; }
    toast(body.message || 'Saved.');
    refresh();
    return true;
  } catch (err) {
    toast(err.message);
    if (revert) revert();
    return false;
  }
}

/**
 * A modal.
 *
 * Escape and a backdrop click both close it, and focus moves to the first
 * control on open — a dialog you cannot dismiss from the keyboard is a trap.
 */
function openModal(title, description, build) {
  var scrim = el('scrim');
  clear(scrim);

  var modal = node('div', 'modal');
  var head = node('div', 'modal-head');
  var titles = node('div');
  titles.appendChild(node('h3', null, title));
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

  function dismiss() {
    scrim.classList.remove('on');
    clear(scrim);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(ev) { if (ev.key === 'Escape') dismiss(); }
  close.addEventListener('click', dismiss);
  scrim.addEventListener('click', function (ev) { if (ev.target === scrim) dismiss(); });
  document.addEventListener('keydown', onKey);

  build(body, modal, dismiss);
  var first = modal.querySelector('input, button');
  if (first) first.focus();
  return dismiss;
}

/**
 * A field that summarises a list and opens it in a modal.
 *
 * Inline editors for five separate lists turned Settings into a column of
 * boxes you had to scroll past to reach anything else. The summary is what an
 * operator reads; the list is what they occasionally change.
 */
function listField(parent, name, hint, values, placeholder, help, onSave, sanitize) {
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

      function paint() {
        clear(list);
        if (!current.length) list.appendChild(node('p', 'hint', 'Nothing here yet.'));
        current.forEach(function (v, i) {
          var row = node('div', 'entry');
          row.appendChild(node('span', 'value', v));
          var rm = node('button', 'sm danger', 'Remove');
          rm.type = 'button';
          rm.addEventListener('click', function () {
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
function contactsField(parent, values, onSave) {
  var current = values.slice();
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
      'Somebody here can be messaged first — an introduction, or passing something on. Adding a contact does not let them message Tulip; that is the audience list, deliberately separate.',
      function (body) {
        var list = node('div');

        function save(before) {
          onSave(current.slice(), function () { current = before; paint(); label(); });
        }

        function paint() {
          clear(list);
          if (!current.length) list.appendChild(node('p', 'hint', 'Nobody yet.'));
          current.forEach(function (c, i) {
            var row = node('div', 'entry');
            row.appendChild(node('span', 'value', c.label + ' · +' + c.number));
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
            var l = name.value.trim().slice(0, 64);
            var n = number.value.replace(/[^0-9]/g, '');
            if (!l || !n) { toast('A contact needs a name and a number.'); return; }
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

  field(parent, 'Contacts', 'People the agent may message first. It sees the name, never the number.', summary);
}

function numberControl(value, min, max, onSave) {
  var wrap = node('div');
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '12px';
  var range = document.createElement('input');
  range.type = 'range';
  range.className = 'range';
  range.min = String(min); range.max = String(max); range.value = String(value);
  var out = node('span', 'value', value);
  range.addEventListener('input', function () { out.textContent = range.value; });
  range.addEventListener('change', function () { onSave(Number(range.value)); });
  wrap.appendChild(range);
  wrap.appendChild(out);
  return wrap;
}

async function renderSettings() {
  var p = head('settings', 'Settings', 'What this deployment does. Changes apply immediately and are written to config.json — every one is recorded in the log and the feed.');
  var s;
  try { s = await api('/api/settings'); } catch (err) { p.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(p)) return;

  // ── Audience ──────────────────────────────────────────────────────────────
  var audience = node('div', 'card');
  audience.appendChild(node('h2', null, 'Audience'));
  audience.appendChild(node('p', 'sub', 'Who reaches the agent. Opening this to everyone makes every inbound message untrusted input to a process holding a shell — which is what the containment is for, but know that you are doing it.'));

  field(audience, 'Open to anyone', 'When on, anybody who messages this number is answered.',
    liveSwitch(s.audience.everyone, function (on, input) {
      saveSettings({ audience: { everyone: on } }, function () { input.checked = !on; });
    }));

  listField(audience, 'Allowed numbers', 'Consulted when not open to everyone.',
    s.audience.numbers, 'e.g. 15551234567',
    'Bare international digits — no plus sign, no spaces. Changes save as you make them.',
    function (next, revert) { saveSettings({ audience: { numbers: next } }, revert); });

  listField(audience, 'Allowed linked ids', 'For senders WhatsApp delivers without a number.',
    s.audience.jids, 'e.g. 111111111111111@lid',
    'WhatsApp increasingly delivers a sender as a @lid with no phone number attached, and a numbers-only list can never match them. Copy the value from a refusal on the Log page.',
    function (next, revert) { saveSettings({ audience: { jids: next } }, revert); });

  listField(audience, 'Operator numbers', 'Who may run ! commands and receives alerts.',
    s.operators.numbers, 'bare digits',
    'Never widened by "open to anyone" — that would hand a stranger the ability to hold delivery and read state.',
    function (next, revert) { saveSettings({ operators: { numbers: next } }, revert); });

  listField(audience, 'Operator linked ids', 'The same people, as WhatsApp actually delivers them.',
    s.operators.jids, 'digits or @lid',
    'An operator whose commands are silently ignored has no way into their own system, so this matters more than the numbers list.',
    function (next, revert) { saveSettings({ operators: { jids: next } }, revert); });
  p.appendChild(audience);

  // ── Groups ────────────────────────────────────────────────────────────────
  var groups = node('div', 'card');
  groups.appendChild(node('h2', null, 'Groups'));
  groups.appendChild(node('p', 'sub', 'Groups do not consult the allow list — being in the room is the consent signal. Enabling them widens who can reach the agent independently of everything above.'));
  field(groups, 'Answer in groups', null,
    liveSwitch(s.groups.enabled, function (on, input) {
      saveSettings({ groups: { enabled: on } }, function () { input.checked = !on; });
    }));

  var modeSeg = node('div', 'seg');
  [['mention', 'Mention'], ['trigger', 'Trigger'], ['observe', 'Observe']].forEach(function (m) {
    var b = node('button', null, m[1]);
    b.type = 'button';
    b.setAttribute('aria-pressed', s.groups.replyTo === m[0] ? 'true' : 'false');
    b.addEventListener('click', function () { saveSettings({ groups: { replyTo: m[0] } }); });
    modeSeg.appendChild(b);
  });
  field(groups, 'Group mode', 'observe delivers every message so the agent can react; it is the expensive one — every message becomes a model call.', modeSeg);
  listField(groups, 'Trigger words', 'Used only in trigger mode. Phrases are allowed.',
    s.groups.triggers || [], 'e.g. juan',
    'A group message containing one of these is answered. Matching is case-insensitive, and a phrase with spaces is fine.',
    function (next, revert) { saveSettings({ groups: { triggers: next } }, revert); },
    function (v) { return v.replace(/\s+/g, ' ').slice(0, 32); });
  p.appendChild(groups);

  // ── Reach ─────────────────────────────────────────────────────────────────
  var reach = node('div', 'card');
  reach.appendChild(node('h2', null, 'Reach'));
  reach.appendChild(node('p', 'sub', 'By default a reply can only go to the person being answered, and that is enforced outside the agent rather than asked of it.'));
  field(reach, 'Message other chats', 'Lets the agent write to the contacts below, and reply onward to chats it already knows. It still cannot read another conversation — sessions are separate — but it can carry this one into another. See THREAT-MODEL T4.',
    liveSwitch(s.agent && s.agent.crossChat, function (on, input) {
      saveSettings({ agent: { crossChat: on } }, function () { input.checked = !on; });
    }));

  contactsField(reach, s.agent && s.agent.contacts ? s.agent.contacts : [],
    function (next, revert) { saveSettings({ agent: { contacts: next } }, revert); });

  p.appendChild(reach);

  // ── Limits ────────────────────────────────────────────────────────────────
  var limits = node('div', 'card');
  limits.appendChild(node('h2', null, 'Limits'));
  limits.appendChild(node('p', 'sub', 'Turns are the expensive unit — each one is a model call somebody pays for.'));
  [['messagesPerHour', 'Messages per hour', 1, 200],
   ['burst', 'Burst', 1, 50],
   ['turnsPerDay', 'Turns per day', 1, 500],
   ['outboundPerTurn', 'Sends per turn', 1, 50],
   ['outboundPerChatPerHour', 'Sends per chat per hour', 1, 300],
   ['maxInboundChars', 'Longest message accepted', 200, 20000],
   ['newSendersPerHour', 'New senders per hour', 1, 200],
   ['maxMediaPerMessage', 'Attachments per message', 0, 10],
   ['turnTimeoutMs', 'Abandon a turn after (ms)', 30000, 1800000]
  ].forEach(function (row) {
    field(limits, row[1], null, numberControl(s.limits[row[0]], row[2], row[3], function (v) {
      var patch = { limits: {} };
      patch.limits[row[0]] = v;
      saveSettings(patch);
    }));
  });
  p.appendChild(limits);

  // ── Delivery ──────────────────────────────────────────────────────────────
  var delivery = node('div', 'card');
  delivery.appendChild(node('h2', null, 'Delivery'));
  delivery.appendChild(node('p', 'sub', 'How messages are gathered before the agent sees them.'));
  [['debounceMs', 'Wait before handing over (ms)', 0, 15000, 'Collects a burst of quick messages into one prompt.'],
   ['maxBatch', 'Messages per turn', 1, 50, 'The rest wait for this chat’s next turn in the rotation.'],
   ['stuckAfterMs', 'Warn when unanswered for (ms)', 0, 1800000, 'How long a message may sit before operators are told.']
  ].forEach(function (row) {
    field(delivery, row[1], row[4], numberControl(s.delivery[row[0]], row[2], row[3], function (v) {
      var patch = { delivery: {} };
      patch.delivery[row[0]] = v;
      saveSettings(patch);
    }));
  });
  p.appendChild(delivery);

  // ── Capabilities ──────────────────────────────────────────────────────────
  var tools = node('div', 'card');
  tools.appendChild(node('h2', null, 'Capabilities'));
  tools.appendChild(node('p', 'sub', 'Two separate things: whether a credential exists, and whether you permit the agent to use it. A feature needs both. Keys live in the environment and changing one needs a container restart; these switches take effect immediately.'));

  [['search', 'Web search', 'Exa. The agent asks; the bridge performs. Read THREAT-MODEL T6 — a prepared page is an injection vector with no sender to block.'],
   ['gifs', 'GIFs', 'Giphy, rating ' + s.tools.gifRating + '.'],
   ['images', 'Pictures', 'MiniMax image generation. Paid, per message.'],
   ['voice', 'Voice notes', 'MiniMax speech. Falls back to text when it fails.']
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

  field(tools, 'Model', 'Set by TULIP_MODEL in the environment; a change needs a container restart.', node('span', 'value', s.model.name));
  field(tools, 'Provider', 'Where inference goes. Also environment.', node('span', 'value', s.model.provider));
  p.appendChild(tools);
}

async function renderLog() {
  var p = head('log', 'Log', 'The bridge’s structured events for today. Credentials are masked before writing.');
  var card = node('div', 'card');
  p.appendChild(card);
  var rows;
  try { rows = await api('/api/logs?n=250'); } catch (err) { card.appendChild(node('p', 'empty', err.message)); return; }
  if (stale(p)) return;
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
  else if (route === 'tools') renderTools();
  else if (route === 'terminal') renderTerminal();
  else if (route === 'settings') renderSettings();
  else if (route === 'log') renderLog();
}

async function refresh() {
  try { state = await api('/api/state'); } catch (err) { el('lede').textContent = 'Lost contact with the bridge. Retrying.'; return; }
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

async function mountPaper() {
  if (typeof PaperShaders === 'undefined' || !PaperShaders.ShaderMount) return;
  if (!PaperShaders.paperTextureFragmentShader) return;
  var host = el('paper');
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
    }, undefined, 0);
  } catch (err) {
    console.warn('[tulip] paper texture did not mount:', err && err.message ? err.message : err);
  }
}

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
void mountPaper();
mountShader();
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
