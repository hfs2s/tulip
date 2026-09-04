/**
 * Proxy the agent's real terminal, which lives behind a UNIX socket on the host.
 *
 * `scripts/tulip-ttyd.sh` runs ttyd on the Pi itself and `docker exec`s into the
 * agent's tmux session. Its header carries the security argument; the short
 * version is that the agent gains nothing — no port, no route, no ttyd in its
 * image — because the flow is bridge -> host -> `docker exec` and it cannot be
 * travelled in the other direction.
 *
 * What this file adds is the last hop: same-origin, so the panel's existing
 * cookie is the only credential and there is no second authentication gate to
 * get wrong. That mattered enough to shape the design. A cross-origin terminal
 * would need its own token on the upgrade path, and a hand-rolled gate on a
 * WebSocket upgrade is exactly the sort of thing that is subtly wrong for
 * months.
 *
 * Absent by default. If the socket is not mounted the proxy answers 503 and says
 * why, rather than hanging — an unreachable terminal should look unreachable.
 */
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { log } from './log.js';

/** Where docker-compose mounts the host's socket directory. */
const SOCKET = process.env['TULIP_PTY_SOCKET'] ?? '/run/tulip/ttyd.sock';

/** Everything under here is proxied; the panel's own routes never start with it. */
export const PTY_PREFIX = '/pty';

export function ptyAvailable(): boolean {
  return existsSync(SOCKET);
}

/**
 * Rewrite the path so ttyd sees itself at the root.
 *
 * ttyd builds absolute URLs for its own assets and its WebSocket, so serving it
 * from a subpath without this produces a page that loads and then silently
 * fails to connect.
 */
function upstreamPath(url: string): string {
  const rest = url.slice(PTY_PREFIX.length);
  return rest.length === 0 ? '/' : rest;
}

/** Ordinary requests: the page, its JS, its CSS. */
export function proxyRequest(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): void {
  if (!ptyAvailable()) {
    res
      .writeHead(503, { ...headers, 'content-type': 'text/plain' })
      .end('the terminal is not running on this host — see scripts/tulip-ttyd.service\n');
    return;
  }

  const upstream = connect(SOCKET);
  upstream.on('error', (err: Error) => {
    log('pty.upstreamFailed', { err: err.message });
    if (!res.headersSent) {
      res.writeHead(502, { ...headers, 'content-type': 'text/plain' }).end('the terminal did not answer\n');
    } else {
      res.end();
    }
  });

  upstream.on('connect', () => {
    const lines = [
      `${req.method ?? 'GET'} ${upstreamPath(req.url ?? '/')} HTTP/1.1`,
      'host: localhost',
      'connection: close',
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      // The cookie is ours, not ttyd's, and passing it on would hand the panel
      // token to a process that has no use for it.
      if (name === 'host' || name === 'connection' || name === 'cookie') continue;
      if (typeof value === 'string') lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    req.pipe(upstream);
    upstream.pipe(res.socket ?? upstream);
  });
}

/**
 * The WebSocket upgrade, which is the terminal itself.
 *
 * Raw socket plumbing rather than a WebSocket library: nothing here needs to
 * understand a frame. The bytes are ttyd's protocol and the browser's, and this
 * only has to not corrupt them.
 */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!ptyAvailable()) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  const upstream = connect(SOCKET);
  const bail = (why: string) => (err: Error): void => {
    log('pty.upgradeFailed', { why, err: err.message });
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', bail('upstream'));
  socket.on('error', bail('client'));

  upstream.on('connect', () => {
    const lines = [`GET ${upstreamPath(req.url ?? '/')} HTTP/1.1`, 'host: localhost'];
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === 'host' || name === 'cookie') continue;
      if (typeof value === 'string') lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}
