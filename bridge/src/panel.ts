/**
 * The operator's control panel.
 *
 * Small, dependency-free, and read-mostly. Its security model is one bearer
 * token, so the hardening is concentrated on not leaking it and not letting it
 * be guessed:
 *
 *   - **Loopback by default.** Reaching it from elsewhere is an explicit
 *     decision, made by editing config and — preferably — putting an
 *     authenticating proxy in front.
 *   - **Constant-time comparison, against a properly parsed cookie.** Iris
 *     compares with `cookie.includes('iris_token=' + t)`, which is both timing-
 *     variable and substring-matched: a cookie named `xiris_token` satisfies it.
 *   - **No endpoint writes configuration.** Who may talk to the agent is
 *     decided by a file on disk, not by a browser form. That removes the entire
 *     class of "the panel was exposed and someone opened the allowlist".
 *   - **Failed authentication is rate-limited per address**, so the token
 *     cannot be brute-forced from the network it is bound to.
 *
 * There is deliberately no terminal here. Iris proxies ttyd so an operator can
 * type into the live session from a browser; that requires the bridge to be
 * able to reach the agent over the network, which would undo the disjoint-
 * networks property that the rest of the design rests on. `docker compose exec`
 * is the supported way in.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '@tulip/shared';
import type { ChatRegistry } from './chats.js';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { feed } from './feed.js';
import { readStatus } from './handoff.js';
import { log } from './log.js';
import { paths } from './paths.js';
import type { Limiter } from './ratelimit.js';
import { state } from './state.js';
import type { WhatsApp } from './whatsapp.js';
import { PANEL_HTML, PANEL_JS } from './panel-html.js';

const COOKIE = 'tulip_token';
/** Failed authentications per address before it is refused outright. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;

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

export interface PanelDeps {
  readonly config: Config;
  readonly wa: WhatsApp;
  readonly chats: ChatRegistry;
  readonly limiter: Limiter;
  readonly dispatcher: () => Dispatcher;
}

export function startPanel(deps: PanelDeps): Server | null {
  if (!deps.config.panel.enabled) return null;

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

  const authenticate = (req: IncomingMessage, url: URL): boolean => {
    const supplied = url.searchParams.get('t') ?? cookieValue(req.headers.cookie, COOKIE);
    return supplied !== null && tokenMatches(supplied, token);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://panel.invalid');
    const address = req.socket.remoteAddress ?? 'unknown';

    // Applied to every response, authenticated or not. The panel renders
    // message text written by strangers, so the CSP is the thing standing
    // between that and script execution in an operator's browser.
    const headers: Record<string, string> = {
      'content-security-policy':
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    };

    if (throttled(address)) {
      res.writeHead(429, { ...headers, 'content-type': 'text/plain' }).end('too many attempts\n');
      return;
    }

    if (!authenticate(req, url)) {
      noteFailure(address);
      res.writeHead(401, { ...headers, 'content-type': 'text/plain' })
        .end(`add ?t=<token> — the token is in ${paths.panelToken} inside the bridge container\n`);
      return;
    }

    // Move the token out of the URL as soon as it has been presented, so it
    // stops appearing in the address bar and in any onward Referer.
    if (url.searchParams.has('t')) {
      headers['set-cookie'] = `${COOKIE}=${token}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`;
    }

    try {
      if (url.pathname === '/') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(PANEL_HTML);
        return;
      }

      if (url.pathname === '/panel.js') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' }).end(PANEL_JS);
        return;
      }

      if (url.pathname === '/api/state') {
        const status = readStatus();
        const snapshot = deps.dispatcher().snapshot();
        const recent = feed.recent(500).filter((e) => e.ts > Date.now() - 24 * 3600 * 1000);
        res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(
          JSON.stringify({
            now: Date.now(),
            whatsapp: { connected: deps.wa.connected, name: deps.wa.me?.name ?? null },
            agent: {
              reporting: status !== null,
              busyTurn: status?.busyTurn ?? null,
              fatal: status?.fatal ?? null,
              sessions: status?.sessions.length ?? 0,
            },
            audience: { everyone: deps.config.audience.everyone, groups: deps.config.groups.enabled },
            hold: state.holdInfo(),
            queue: snapshot,
            today: {
              in: recent.filter((e) => e.kind === 'in').length,
              accepted: recent.filter((e) => e.kind === 'in' && e.accepted === true).length,
              refused: recent.filter((e) => e.kind === 'in' && e.accepted === false).length,
              out: recent.filter((e) => e.kind === 'out').length,
            },
            chats: deps.chats
              .all()
              .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
              .slice(0, 30)
              .map((c) => ({
                chatKey: c.chatKey,
                name: c.name,
                isGroup: c.isGroup,
                blocked: c.blocked,
                messages: c.messages,
                lastSeenAt: c.lastSeenAt,
                turnsToday: deps.limiter.stats(c.chatKey)?.turnsToday ?? 0,
              })),
          }),
        );
        return;
      }

      if (url.pathname === '/api/feed') {
        const n = Math.min(Number(url.searchParams.get('n')) || 100, 500);
        res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(feed.recent(n)));
        return;
      }

      if (url.pathname === '/api/stream') {
        res.writeHead(200, {
          ...headers,
          'content-type': 'text/event-stream',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        streams.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          streams.delete(res);
        });
        return;
      }

      // The only mutating endpoints. Note what is absent: nothing here edits
      // the audience, the limits, or anything else that decides who may reach
      // the agent. Those live in a file, deliberately.
      if (req.method === 'POST' && url.pathname.startsWith('/api/action/')) {
        const action = url.pathname.slice('/api/action/'.length);
        const key = url.searchParams.get('key') ?? '';
        const result = runAction(deps, action, key);
        res.writeHead(result.ok ? 200 : 400, { ...headers, 'content-type': 'application/json' })
          .end(JSON.stringify(result));
        return;
      }

      res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found\n');
    } catch (err) {
      log('panel.error', { path: url.pathname, err: String((err as Error).message) });
      res.writeHead(500, { ...headers, 'content-type': 'text/plain' }).end('internal error\n');
    }
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
      note: deps.config.panel.host === '127.0.0.1' ? 'loopback only' : 'REACHABLE OFF-HOST — put auth in front of it',
    });
  });

  return server;
}

function runAction(deps: PanelDeps, action: string, key: string): { ok: boolean; message: string } {
  switch (action) {
    case 'hold':
      state.setHold(true, 'panel');
      feed.event('hold.on', 'delivery held from the panel');
      return { ok: true, message: 'holding' };

    case 'release':
      state.setHold(false, 'panel');
      feed.event('hold.off', 'delivery released from the panel');
      void deps.dispatcher().pump();
      return { ok: true, message: 'released' };

    case 'block':
    case 'unblock': {
      if (!/^[0-9a-f]{16}$/.test(key)) return { ok: false, message: 'a 16-character chat key is required' };
      if (!deps.chats.setBlocked(key, action === 'block')) return { ok: false, message: 'no such chat' };
      deps.chats.flush();
      feed.event(action === 'block' ? 'chat.blocked' : 'chat.unblocked', key);
      return { ok: true, message: `${action}ed ${key}` };
    }

    default:
      return { ok: false, message: `unknown action: ${action}` };
  }
}
