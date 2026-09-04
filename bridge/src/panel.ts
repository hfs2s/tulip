/**
 * The operator's control panel — server, authentication, and routing.
 *
 * Its security model is one bearer token, so the hardening is concentrated on
 * not leaking it and not letting it be guessed:
 *
 *   - **Published on one interface, chosen deliberately.** Note the layer: the
 *     process binds 0.0.0.0 *inside its container*, and `docker-compose.yml`
 *     publishes it wherever `TULIP_PANEL_BIND` says. Binding loopback inside
 *     the container would not be safer, it would make the panel unreachable —
 *     Docker forwards a published port to the container's ethernet address,
 *     never its loopback.
 *   - **Constant-time comparison, against a properly parsed cookie.** Iris
 *     compares with `cookie.includes('iris_token=' + t)`, which is both timing-
 *     variable and substring-matched: a cookie named `xiris_token` satisfies it.
 *   - **Exactly one endpoint writes configuration**, and it is the sharpest
 *     edge on this surface. `POST /api/settings` can open the audience to the
 *     world, so holding the token is equivalent to holding the deployment.
 *     This was once "no endpoint writes configuration", which removed that
 *     class of attack entirely; it was traded for a console whose controls
 *     work. `panel.*` remains unwritable, so the surface still cannot widen its
 *     own exposure. See `updateSettings` in panel-api.ts, and THREAT-MODEL §T7.
 *   - **Failed authentication is rate-limited per address**, so the token
 *     cannot be brute-forced from whatever network it is published on.
 *
 * Everything served is same-origin: the page, its script, the shader bundle,
 * the fonts and the icon. That is what lets the CSP stay at `'self'` on a page
 * which renders message text written by strangers.
 *
 * **The terminal.** Iris proxies ttyd over a socket. Tulip cannot: the bridge
 * and the agent share no network, Docker will not publish a port into an
 * `internal` network, and proxying a shell through the bridge would hand the
 * agent a route to the container holding the WhatsApp credentials. So the
 * terminal is a file exchange over the volumes that already carry everything
 * else — see `panel-api.ts`.
 *
 * That constraint costs nothing in fidelity, which is worth saying because it
 * was assumed to. The terminal renders with the same emulator Iris uses, from
 * the pane's own bytes; only the transport differs. What it does cost is
 * liveness measured in a couple of hundred milliseconds rather than none, since
 * the bytes are polled off a file at both ends instead of pushed down a
 * socket — and an event stream out to the browser, because a WebSocket here
 * would mean a second hand-rolled authentication gate on the upgrade path.
 * Iris has one of those, and it is the sharpest edge in that codebase.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '@tulip/shared';
import { feed } from './feed.js';
import { accessConfig, verifiedEmail } from './access.js';
import { log } from './log.js';
import { paths } from './paths.js';
import {
  chatHistory,
  logTail,
  mediaFile,
  mediaList,
  runAction,
  send,
  settingsView,
  snapshot,
  updateSettings,
  paneReader,
  terminalKeys,
  terminalScreen,
  terminalWatch,
  type ApiDeps,
} from './panel-api.js';

const COOKIE = 'tulip_token';
/**
 * How often a connected terminal is polled for new pane bytes.
 *
 * This is the operator's end of the latency; the agent's tick is the other
 * half. Both are short because a terminal that lags is a terminal nobody
 * believes, and neither costs anything when nobody is connected.
 */
const PANE_POLL_MS = 120;
/** How long the agent keeps capturing after one request, and how often we renew. */
const TERMINAL_WATCH_S = 120;
const TERMINAL_REFRESH_MS = 30_000;
/** Failed authentications per address before it is refused outright. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const HERE = dirname(fileURLToPath(import.meta.url));

/** Stable across restarts, so a bookmarked URL keeps working. */
function loadToken(): string {
  if (existsSync(paths.panelToken)) {
    const existing = readFileSync(paths.panelToken, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString('hex');
  writeFileAtomic(paths.panelToken, token, 0o600);
  log('panel.tokenCreated', { note: `token written to ${paths.panelToken}` });
  return token;
}

/**
 * Compare without leaking length or content through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be an
 * oracle, so lengths are compared first and a mismatch is reported as a plain
 * false — the length of a 64-character hex token is not a secret.
 */
function tokenMatches(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse a Cookie header properly. Substring matching is not parsing. */
function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Read a build artefact sitting beside the compiled panel.
 *
 * The shader bundle and the fonts are vendored at image build time rather than
 * loaded from a CDN, which is the only way the CSP can stay at `'self'`. Both
 * are absent in a development tree, and the page is written to work without
 * them.
 */
function asset(name: string): Buffer | null {
  try {
    // `web/`, not `HERE` directly: the browser script is also called panel.js,
    // and writing it beside the compiled panel.js replaced the server with the
    // client. It did exactly that once.
    return readFileSync(join(HERE, 'web', name));
  } catch {
    return null;
  }
}

/**
 * Serve a build artefact so a deploy actually reaches the browser.
 *
 * These used to be `max-age=86400`. The page itself is `no-store`, so an
 * operator always got fresh HTML — and, for up to a day afterwards, the
 * *previous* `panel.js` to go with it. A shipped fix that the browser refuses
 * to fetch is indistinguishable from a fix that does not work, and it cost real
 * debugging time before it was noticed.
 *
 * `no-cache` does not mean "do not cache": it means "revalidate before use". So
 * the body is still cached and an unchanged asset costs a 304 with no payload,
 * while a changed one is picked up on the next load. The ETag is the content
 * hash, so it changes exactly when the file does.
 */
function serveAsset(
  res: ServerResponse,
  req: IncomingMessage,
  headers: Record<string, string>,
  contentType: string,
  body: Buffer | string,
): void {
  const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
  const common = { ...headers, 'content-type': contentType, etag, 'cache-control': 'private, no-cache' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, common).end();
    return;
  }
  res.writeHead(200, common).end(body);
}

export function startPanel(deps: ApiDeps): Server | null {
  if (!deps.config.panel.enabled) return null;

  // The page, its script and the icon are build artefacts like the fonts. Read
  // once at start rather than per request: they do not change under a running
  // process, and a missing one is a broken deployment worth saying out loud.
  const page = asset('panel.html');
  const script = asset('panel.js');
  const favicon = asset('favicon.svg');
  if (!page || !script) {
    log('panel.assetsMissing', {
      note: 'panel.html or panel.js is absent — run `npm run build` in the bridge workspace',
    });
  }

  const token = loadToken();
  const failures = new Map<string, { count: number; since: number }>();
  const streams = new Set<ServerResponse>();

  const throttled = (address: string): boolean => {
    const record = failures.get(address);
    if (!record) return false;
    if (Date.now() - record.since > FAILURE_WINDOW_MS) {
      failures.delete(address);
      return false;
    }
    return record.count >= MAX_FAILURES;
  };

  const noteFailure = (address: string): void => {
    const record = failures.get(address);
    if (!record || Date.now() - record.since > FAILURE_WINDOW_MS) {
      failures.set(address, { count: 1, since: Date.now() });
      return;
    }
    record.count += 1;
    if (record.count === MAX_FAILURES) log('panel.bruteForce', { address, note: 'refusing further attempts' });
  };

  // Configured once, at start, so an operator sees in the log whether Access
  // authentication is on rather than discovering it from whether a stranger got
  // in. Absent configuration disables it; it never degrades to something weaker.
  const access = accessConfig();
  log('panel.access', {
    note:
      access === null
        ? 'Cloudflare Access auth is off — the bearer token is the only way in'
        : `Cloudflare Access auth is on for ${access.teamDomain}`,
  });

  /**
   * Either credential is sufficient, and they answer different questions.
   *
   * The token is a bearer secret: it says the holder has the secret, and
   * nothing about who they are. It stays because loopback and SSH-tunnel access
   * have no Access in front to ask.
   *
   * A verified Access assertion says *which person* Cloudflare authenticated,
   * which is what makes adding and removing operators a policy change instead
   * of a shared password. Returns the email so the caller can record it.
   */
  const authenticate = async (
    req: IncomingMessage,
    url: URL,
  ): Promise<{ ok: boolean; who: string | null }> => {
    const supplied = url.searchParams.get('t') ?? cookieValue(req.headers.cookie, COOKIE);
    if (supplied !== null && tokenMatches(supplied, token)) return { ok: true, who: null };

    if (access !== null) {
      const header = req.headers['cf-access-jwt-assertion'];
      const assertion = Array.isArray(header) ? header[0] : header;
      const email = await verifiedEmail(assertion, access);
      if (email !== null) return { ok: true, who: email };
    }
    return { ok: false, who: null };
  };

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://panel.invalid');
      const address = req.socket.remoteAddress ?? 'unknown';

      // Applied to every response, authenticated or not. The panel renders
      // message text written by strangers, so this is what stands between that
      // and script execution in an operator's browser. Everything it permits is
      // same-origin.
      const headers: Record<string, string> = {
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; " +
          "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      };

      if (throttled(address)) {
        res.writeHead(429, { ...headers, 'content-type': 'text/plain' }).end('too many attempts\n');
        return;
      }
      const auth = await authenticate(req, url);
      if (!auth.ok) {
        noteFailure(address);
        res
          .writeHead(401, { ...headers, 'content-type': 'text/plain' })
          .end(
            access === null
              ? `add ?t=<token> — the token is in ${paths.panelToken} inside the bridge container\n`
              : 'sign in through Cloudflare Access, or add ?t=<token> when reaching this over a tunnel\n',
          );
        return;
      }

      // Who did it, for anything that changes state. The token cannot answer
      // that question — it is a shared secret, so every action taken with it is
      // "the token holder" — which is most of the reason Access auth exists.
      if (req.method === 'POST') {
        log('panel.write', { path: url.pathname, who: auth.who ?? 'token holder' });
      }

      // Move the token out of the URL as soon as it has been presented, so it
      // stops appearing in the address bar and in any onward Referer.
      if (url.searchParams.has('t')) {
        headers['set-cookie'] = `${COOKIE}=${token}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`;
      }

      const num = (name: string, fallback: number, cap: number): number =>
        Math.min(Math.max(Number(url.searchParams.get(name)) || fallback, 1), cap);

      try {
        if (url.pathname === '/') {
          if (!page) {
            res.writeHead(500, { ...headers, 'content-type': 'text/plain' }).end('the panel was not built\n');
            return;
          }
          res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(page);
          return;
        }
        if (url.pathname === '/panel.js') {
          if (!script) {
            res.writeHead(500, { ...headers, 'content-type': 'text/javascript' }).end('/* not built */');
            return;
          }
          serveAsset(res, req, headers, 'text/javascript; charset=utf-8', script);
          return;
        }
        if (url.pathname === '/favicon.svg') {
          if (!favicon) {
            res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found\n');
            return;
          }
          serveAsset(res, req, headers, 'image/svg+xml', favicon);
          return;
        }
        if (url.pathname === '/xterm.js' || url.pathname === '/xterm.css') {
          const file = asset(url.pathname.slice(1));
          if (!file) {
            // Absent in a development tree that has not run the asset build.
            // The Terminal page checks for the global and says so rather than
            // rendering an empty black rectangle.
            res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not bundled\n');
            return;
          }
          serveAsset(
            res,
            req,
            headers,
            url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            file,
          );
          return;
        }
        if (url.pathname === '/shaders.js') {
          const bundle = asset('shaders.js');
          if (!bundle) {
            // Absent in a development tree. The page checks and skips the effect.
            res.writeHead(404, { ...headers, 'content-type': 'text/javascript' }).end('/* not bundled */');
            return;
          }
          serveAsset(res, req, headers, 'text/javascript', bundle);
          return;
        }
        if (/^\/fonts\/[A-Za-z0-9._-]+\.woff2$/.test(url.pathname)) {
          const file = asset(join('fonts', url.pathname.slice('/fonts/'.length)));
          if (!file) {
            res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found\n');
            return;
          }
          res
            .writeHead(200, { ...headers, 'content-type': 'font/woff2', 'cache-control': 'private, max-age=604800, immutable' })
            .end(file);
          return;
        }

        if (url.pathname === '/api/state') return send(res, headers, 200, snapshot(deps));
        if (url.pathname === '/api/feed') return send(res, headers, 200, feed.recent(num('n', 120, 500)));
        if (url.pathname === '/api/chat') {
          return send(res, headers, 200, chatHistory(deps, url.searchParams.get('key') ?? '', num('n', 200, 1000)));
        }
        if (url.pathname === '/api/media/list') return send(res, headers, 200, mediaList(deps, num('n', 120, 500)));
        if (url.pathname === '/api/media') {
          mediaFile(
            res,
            headers,
            url.searchParams.get('key') ?? '',
            url.searchParams.get('name') ?? '',
            // Defaults to inbound so links written before outbound media
            // existed keep resolving.
            url.searchParams.get('dir') ?? 'in',
          );
          return;
        }
        if (url.pathname === '/api/logs') return send(res, headers, 200, logTail(num('n', 200, 1000)));
        if (url.pathname === '/api/settings' && req.method === 'GET') {
          return send(res, headers, 200, settingsView(deps));
        }
        // Method guard matters: without it this also swallows the POST and
        // silently returns the current values instead of applying the change.
        if (url.pathname === '/api/settings' && req.method === 'POST') {
          const result = updateSettings(deps, await readBody(req));
          return send(res, headers, result.ok ? 200 : 400, result);
        }

        if (url.pathname === '/api/terminal' && req.method === 'GET') {
          return send(res, headers, 200, terminalScreen());
        }
        if (url.pathname === '/api/terminal/watch' && req.method === 'POST') {
          const body = await readBody(req);
          const window = typeof body['window'] === 'string' ? body['window'] : null;
          return send(res, headers, 200, terminalWatch(window, 90));
        }
        if (url.pathname === '/api/terminal/keys' && req.method === 'POST') {
          const body = await readBody(req);
          const window = typeof body['window'] === 'string' ? body['window'] : null;
          const raw = Array.isArray(body['keys']) ? body['keys'] : [];
          const keys = raw
            .filter((k): k is Record<string, unknown> => typeof k === 'object' && k !== null)
            .map((k) => ({ text: String(k['text'] ?? '').slice(0, 2000), literal: k['literal'] !== false }))
            .filter((k) => k.text.length > 0)
            .slice(0, 32);
          return send(res, headers, 200, terminalKeys(window, keys));
        }

        if (url.pathname === '/api/terminal/stream') {
          res.writeHead(200, {
            ...headers,
            'content-type': 'text/event-stream',
            // `no-transform` and the nginx hint are both load-bearing: the panel
            // is served through a Cloudflare tunnel, and an intermediary that
            // buffers an event stream delivers a terminal in lumps a minute
            // apart, which looks exactly like the agent having hung.
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
            connection: 'keep-alive',
          });
          res.write(': connected\n\n');

          // `null` is "follow whichever chat is active". It is the only thing
          // the panel asks for — the window picker is gone, so the terminal
          // follows the conversation rather than the operator chasing it.
          terminalWatch(null, TERMINAL_WATCH_S);
          const readPane = paneReader();

          const refresh = setInterval(() => terminalWatch(null, TERMINAL_WATCH_S), TERMINAL_REFRESH_MS);
          const tick = setInterval(() => {
            const { reset, bytes } = readPane();
            // Order matters: the clear has to reach the emulator before the
            // bytes that assume a clear screen.
            if (reset) res.write('event: reset\ndata: \n\n');
            if (bytes.length > 0) res.write(`data: ${bytes.toString('base64')}\n\n`);
          }, PANE_POLL_MS);
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

          req.on('close', () => {
            clearInterval(refresh);
            clearInterval(tick);
            clearInterval(ping);
          });
          return;
        }

        if (url.pathname === '/api/stream') {
          res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive' });
          res.write(': connected\n\n');
          streams.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
          req.on('close', () => {
            clearInterval(ping);
            streams.delete(res);
          });
          return;
        }

        if (url.pathname.startsWith('/api/action/') && req.method === 'POST') {
          const result = runAction(deps, url.pathname.slice('/api/action/'.length), url.searchParams.get('key') ?? '');
          return send(res, headers, result.ok ? 200 : 400, result);
        }

        res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found\n');
      } catch (err) {
        log('panel.error', { path: url.pathname, err: String((err as Error).message) });
        res.writeHead(500, { ...headers, 'content-type': 'text/plain' }).end('internal error\n');
      }
    })();
  });

  feed.on('entry', (row: unknown) => {
    const payload = `data: ${JSON.stringify(row)}\n\n`;
    for (const stream of streams) {
      try {
        stream.write(payload);
      } catch {
        streams.delete(stream);
      }
    }
  });

  server.listen(deps.config.panel.port, deps.config.panel.host, () => {
    log('panel.up', {
      host: deps.config.panel.host,
      port: deps.config.panel.port,
      note: 'exposure is set by the publish address in docker-compose.yml, not by this bind address',
    });
  });

  return server;
}
