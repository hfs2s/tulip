/**
 * The panel's icon, page and script, as strings.
 *
 * ── The design ───────────────────────────────────────────────────────────────
 *
 * Dark and cinematic, after the Verity template: a near-black `#0d0d0f` ground,
 * one cyan accent, Onest for headings and Inter for body. The heading treatment
 * is the character of it and is the easy thing to get wrong — large, **weight
 * 400**, with tight negative tracking. Reaching for bold would turn restraint
 * into a dashboard.
 *
 * Eight pages behind a rail, matching Iris: overview, messages, chats, media,
 * tools, terminal, settings, log. Each gets the layout its content wants — a
 * verdict, a stream, a table, a grid, action rows, a slab, a definition list, a
 * monospace tail — rather than the same card repeated eight times.
 *
 * Motion is deliberately quieter than the reference. Verity is a marketing page
 * and reveals things as you scroll; this is a console somebody opens *because
 * something is wrong*. One orchestrated entrance, a fast route fade, and a
 * shader behind the masthead. All of it stops under `prefers-reduced-motion`.
 *
 * ── Two rules that make it safe to display strangers' messages ───────────────
 *
 *   - **Nothing is ever assigned to `innerHTML`.** Every value from the API
 *     reaches the DOM through `textContent`, so a message containing
 *     `<img onerror=…>` is displayed as those characters and never parsed as
 *     markup. This is the actual defence; the CSP is the backstop for a slip.
 *   - **Everything is same-origin.** The script, the fonts, the shader bundle
 *     and the icon are all served by the bridge, which is what lets the CSP say
 *     `script-src 'self'` rather than `'unsafe-inline'`.
 */

/** A tulip, in the accent. Served same-origin so `img-src 'self'` covers it. */
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#0d0d0f"/>
<path d="M16 7c2.2 2.4 3.4 4.5 3.4 6.6 0 2.4-1.5 4-3.4 4s-3.4-1.6-3.4-4C12.6 11.5 13.8 9.4 16 7z" fill="#21d2ed"/>
<path d="M11.2 10.6c.5 3 .3 5.2-.7 6.6-1.1 1.6-3 1.9-4.3.9s-1.4-2.9-.3-4.5c1-1.4 2.8-2.4 5.3-3z" fill="#21d2ed" opacity=".72"/>
<path d="M20.8 10.6c2.5.6 4.3 1.6 5.3 3 1.1 1.6 1 3.5-.3 4.5s-3.2.7-4.3-.9c-1-1.4-1.2-3.6-.7-6.6z" fill="#21d2ed" opacity=".72"/>
<path d="M16 18v7" stroke="#21d2ed" stroke-width="1.8" stroke-linecap="round" opacity=".55"/>
</svg>`;

export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Tulip</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  /* Vendored at image build time. The fallback stacks carry the page on their
     own when the files are absent, which they are in a development tree. */
  @font-face{font-family:'Onest';src:url('/fonts/onest.woff2') format('woff2');
             font-weight:100 900;font-display:swap}
  @font-face{font-family:'InterVar';src:url('/fonts/inter.woff2') format('woff2');
             font-weight:100 900;font-display:swap}

  :root{
    --ground:#0d0d0f; --panel:#111113; --raise:#141416;
    --line:rgba(255,255,255,.09); --line-soft:rgba(255,255,255,.055);
    --ink:#fafafa; --dim:rgba(250,250,250,.64); --faint:rgba(250,250,250,.42);
    --accent:#21d2ed; --accent-dim:rgba(33,210,237,.14);
    --warn:#f0b429; --bad:#ff6b6b;
    --display:'Onest',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    --body:'InterVar',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --rail:236px; --r-card:14px; --r-pill:999px;
  }

  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--ground);color:var(--ink);
       font:400 14.5px/1.6 var(--body);font-variant-numeric:tabular-nums;
       -webkit-font-smoothing:antialiased;display:flex}

  .rail{width:var(--rail);flex:0 0 var(--rail);height:100vh;position:sticky;top:0;
        background:var(--panel);border-right:1px solid var(--line-soft);
        padding:22px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:3px}
  .brand{display:flex;align-items:center;gap:10px;padding:0 10px 18px}
  .brand svg{width:26px;height:26px;flex:0 0 26px}
  .brand b{font:400 19px/1 var(--display);letter-spacing:-.03em;display:block}
  .brand small{display:block;font-size:11.5px;color:var(--faint);margin-top:3px}
  .rail-label{font-size:11px;color:var(--faint);padding:12px 10px 6px;margin:0}
  .nav{display:flex;align-items:center;gap:11px;padding:9px 10px;border-radius:10px;
       color:var(--dim);cursor:pointer;border:0;background:transparent;width:100%;
       font:inherit;text-align:left;transition:background .16s ease,color .16s ease}
  .nav svg{width:17px;height:17px;flex:0 0 17px;opacity:.8}
  .nav:hover{background:var(--raise);color:var(--ink)}
  .nav[aria-current=page]{background:var(--accent-dim);color:var(--accent)}
  .nav[aria-current=page] svg{opacity:1}
  .nav .count{margin-left:auto;font-size:11.5px;color:var(--faint);
              background:var(--raise);border-radius:var(--r-pill);padding:1px 8px}
  .rail-foot{margin-top:auto;padding:14px 10px 0;border-top:1px solid var(--line-soft);
             font-size:11.5px;color:var(--faint);line-height:1.5}

  main{flex:1;min-width:0;display:flex;flex-direction:column}
  .masthead{position:relative;overflow:hidden;border-bottom:1px solid var(--line-soft);
            padding:38px 40px 32px}
  #shader{position:absolute;inset:0;opacity:.32;pointer-events:none}
  .masthead::after{content:"";position:absolute;inset:0;pointer-events:none;
    background:linear-gradient(180deg,rgba(13,13,15,.1),var(--ground))}
  .masthead-in{position:relative;z-index:1;max-width:900px}
  h1{font:400 clamp(30px,4.4vw,54px)/1.05 var(--display);letter-spacing:-.04em;margin:0 0 10px}
  h1.stopped{color:var(--bad)}
  .lede{font-size:15.5px;color:var(--dim);margin:0;max-width:62ch}

  .page-wrap{padding:28px 40px 64px;flex:1}
  h2{font:400 21px/1.2 var(--display);letter-spacing:-.02em;margin:0 0 4px}
  .sub{font-size:13.5px;color:var(--faint);margin:0 0 20px;max-width:64ch}

  .reveal{opacity:0;transform:translateY(10px);animation:rise .45s cubic-bezier(.2,.7,.3,1) forwards}
  @keyframes rise{to{opacity:1;transform:none}}
  .page{display:none}
  .page.on{display:block}

  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:1px;
         background:var(--line-soft);border:1px solid var(--line-soft);
         border-radius:var(--r-card);overflow:hidden;margin-bottom:26px}
  .stat{background:var(--panel);padding:16px 18px}
  .stat b{display:block;font:400 27px/1.1 var(--display);letter-spacing:-.03em}
  .stat small{display:block;margin-top:4px;font-size:12px;color:var(--faint)}
  .stat.accent b{color:var(--accent)}
  .stat.bad b{color:var(--bad)}

  .card{background:var(--panel);border:1px solid var(--line-soft);
        border-radius:var(--r-card);padding:20px 22px;margin-bottom:18px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;font-size:11.5px;color:var(--faint);font-weight:400;
     padding:0 12px 10px 0;border-bottom:1px solid var(--line-soft)}
  td{padding:12px 12px 12px 0;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  .key{font-family:var(--mono);font-size:12px;color:var(--faint)}
  .muted{color:var(--faint)}

  .line{display:grid;grid-template-columns:56px 92px 1fr;gap:14px;padding:11px 0;
        border-bottom:1px solid var(--line-soft)}
  .line:last-child{border-bottom:0}
  .when{font-size:12.5px;color:var(--faint)}
  .tag{font-size:11.5px;color:var(--faint)}
  .tag.out{color:var(--accent)} .tag.refused{color:var(--warn)} .tag.in{color:var(--ink)}
  .said{white-space:pre-wrap;overflow-wrap:anywhere}
  .why{font-size:12.5px;color:var(--warn);margin-top:3px}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px}
  .tile{background:var(--panel);border:1px solid var(--line-soft);border-radius:12px;overflow:hidden}
  .tile img,.tile video{width:100%;height:120px;object-fit:cover;display:block;background:var(--raise)}
  .tile .none{height:120px;display:grid;place-items:center;color:var(--faint);font-size:12px}
  .tile .meta{padding:8px 10px;font-size:11.5px;color:var(--faint)}

  .controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
  button{font:inherit;cursor:pointer;border-radius:var(--r-pill);padding:9px 18px;
         border:1px solid var(--line);background:var(--raise);color:var(--ink);
         transition:background .16s ease,border-color .16s ease,color .16s ease}
  button:hover{border-color:rgba(255,255,255,.2)}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  button.primary{background:var(--accent);border-color:var(--accent);color:#04252b;font-weight:500}
  button.primary:hover{filter:brightness(1.08)}
  button.danger:hover{border-color:var(--bad);color:var(--bad)}
  button.sm{padding:5px 12px;font-size:12.5px}
  button[disabled]{opacity:.42;cursor:not-allowed}

  input[type=text],input[type=search],select{font:inherit;color:var(--ink);
    background:var(--raise);border:1px solid var(--line);border-radius:10px;
    padding:9px 13px;min-width:0}
  input::placeholder{color:var(--faint)}
  input:focus,select:focus{outline:none;border-color:var(--accent)}
  .search{flex:1;min-width:180px}

  .seg{display:inline-flex;background:var(--raise);border:1px solid var(--line);
       border-radius:var(--r-pill);padding:3px}
  .seg button{border:0;background:transparent;padding:6px 14px;font-size:13px;color:var(--dim)}
  .seg button[aria-pressed=true]{background:var(--accent-dim);color:var(--accent)}

  .switch{display:inline-flex;align-items:center;gap:11px;cursor:pointer}
  .switch input{position:absolute;opacity:0;width:0;height:0}
  .track{width:42px;height:24px;border-radius:var(--r-pill);background:var(--raise);
         border:1px solid var(--line);position:relative;
         transition:background .18s ease,border-color .18s ease}
  .track::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;
                border-radius:50%;background:var(--dim);
                transition:transform .18s ease,background .18s ease}
  .switch input:checked + .track{background:var(--accent-dim);border-color:var(--accent)}
  .switch input:checked + .track::after{transform:translateX(18px);background:var(--accent)}
  .switch input:disabled + .track{opacity:.5}
  .switch input:focus-visible + .track{outline:2px solid var(--accent);outline-offset:2px}

  .range{-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;
         background:var(--line);width:170px}
  .range::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;
         border-radius:50%;background:var(--accent);cursor:pointer}
  .range:disabled::-webkit-slider-thumb{background:var(--faint)}

  .field{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;
         padding:13px 0;border-bottom:1px solid var(--line-soft)}
  .field:last-child{border-bottom:0}
  .field .hint{font-size:12.5px;color:var(--faint);margin-top:2px;max-width:58ch}
  .value{font-family:var(--mono);font-size:12.5px;color:var(--dim)}

  .badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;
         border:1px solid var(--line);border-radius:var(--r-pill);padding:3px 10px;color:var(--dim)}
  .badge.on{border-color:var(--accent);color:var(--accent)}
  .badge.off{border-color:var(--warn);color:var(--warn)}

  .slab{background:#08080a;border:1px solid var(--line-soft);border-radius:12px;
        padding:16px 18px;font-family:var(--mono);font-size:12.5px;line-height:1.5;
        white-space:pre;overflow:auto;max-height:58vh;color:#d6d6de}
  .warnbar{border:1px solid var(--warn);color:var(--warn);border-radius:10px;
           padding:11px 14px;font-size:13px;margin-bottom:16px}
  .logline{font-family:var(--mono);font-size:12px;padding:5px 0;
           border-bottom:1px solid var(--line-soft);white-space:pre-wrap;overflow-wrap:anywhere}
  .logline b{color:var(--faint);font-weight:400}
  .toolrow{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;
           padding:16px 0;border-bottom:1px solid var(--line-soft)}
  .toolrow:last-child{border-bottom:0}
  .empty{color:var(--faint);padding:20px 0}
  .toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);
         background:var(--raise);border:1px solid var(--line);border-radius:var(--r-pill);
         padding:10px 20px;font-size:13.5px;opacity:0;transition:opacity .2s ease;
         pointer-events:none;z-index:9}
  .toast.on{opacity:1}

  @media (max-width:900px){
    body{flex-direction:column}
    .rail{width:100%;flex:none;height:auto;position:static;flex-direction:row;
          overflow-x:auto;padding:12px;gap:6px;align-items:center}
    .brand,.rail-label,.rail-foot{display:none}
    .nav{width:auto;white-space:nowrap;padding:8px 12px}
    .nav .count{display:none}
    .masthead{padding:26px 20px 22px}
    .page-wrap{padding:20px 20px 48px}
    .line{grid-template-columns:52px 1fr;gap:10px}
    .line .tag{display:none}
  }
  @media (prefers-reduced-motion:reduce){
    *{animation:none!important;transition:none!important}
    #shader{display:none}
  }
</style>
</head>
<body>
  <aside class="rail">
    <div class="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 7c2.2 2.4 3.4 4.5 3.4 6.6 0 2.4-1.5 4-3.4 4s-3.4-1.6-3.4-4C12.6 11.5 13.8 9.4 16 7z" fill="#21d2ed"/>
        <path d="M11.2 10.6c.5 3 .3 5.2-.7 6.6-1.1 1.6-3 1.9-4.3.9s-1.4-2.9-.3-4.5c1-1.4 2.8-2.4 5.3-3z" fill="#21d2ed" opacity=".72"/>
        <path d="M20.8 10.6c2.5.6 4.3 1.6 5.3 3 1.1 1.6 1 3.5-.3 4.5s-3.2.7-4.3-.9c-1-1.4-1.2-3.6-.7-6.6z" fill="#21d2ed" opacity=".72"/>
        <path d="M16 18v7" stroke="#21d2ed" stroke-width="1.8" stroke-linecap="round" opacity=".55"/>
      </svg>
      <span><b>Tulip</b><small id="whoami">connecting</small></span>
    </div>
    <p class="rail-label">Pages</p>
    <nav id="nav"></nav>
    <div class="rail-foot" id="railfoot">—</div>
  </aside>

  <main>
    <header class="masthead">
      <div id="shader"></div>
      <div class="masthead-in">
        <h1 id="headline">Connecting…</h1>
        <p class="lede" id="lede">Reading the bridge's state.</p>
      </div>
    </header>
    <div class="page-wrap">
      <section class="page" id="p-overview"></section>
      <section class="page" id="p-messages"></section>
      <section class="page" id="p-chats"></section>
      <section class="page" id="p-media"></section>
      <section class="page" id="p-tools"></section>
      <section class="page" id="p-terminal"></section>
      <section class="page" id="p-settings"></section>
      <section class="page" id="p-log"></section>
    </div>
  </main>

  <div class="toast" id="toast"></div>
  <script src="/shaders.js"></script>
  <script src="/panel.js"></script>
</body>
</html>
`;

export const PANEL_JS = `'use strict';
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
    lede = s.queue.queued ? s.queue.queued + ' message(s) waiting. Resume to hand them over.'
                          : 'Nothing waiting. New messages queue rather than reach the agent.';
  } else {
    stopped = false;
    h.textContent = 'Answering people.';
    lede = s.agent.sessions === 0 ? 'Idle and listening. Nobody is mid-conversation.'
         : s.agent.sessions + ' conversation(s) open right now.';
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
  else if (e.kind === 'delivered') body.textContent = 'Handed over ' + e.count + ' message(s).';
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
  field(audience, 'Allow list', 'Numbers and linked ids permitted when not open to everyone.', node('span', 'value', s.audience.numbers + ' numbers, ' + s.audience.jids + ' linked ids'));
  field(audience, 'Operators', 'Who may run ! commands and receives alerts. Never widened by the switch above.', node('span', 'value', s.operators.numbers + ' numbers, ' + s.operators.jids + ' linked ids'));
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
`;
