/**
 * tulip-egress — the agent's only permitted path off its network.
 *
 * The agent container sits on an `internal: true` Docker network with no default
 * route and a resolver pointing at nothing, so the kernel already drops every
 * packet aimed at the internet and every name lookup fails. This process is the
 * single hole deliberately left in that wall, and it is a narrow one: an HTTPS
 * CONNECT tunnel to an explicit list of hostnames, on port 443, to public
 * addresses only.
 *
 * Three properties are worth stating because they are what make this reviewable:
 *
 *   - **It never sees plaintext.** CONNECT only; absolute-URI proxying is
 *     refused. The proxy sets up a TCP tunnel and copies bytes. It cannot read,
 *     modify or cache what passes through, and it holds no credential.
 *   - **It fails closed.** A missing allowlist is an empty allowlist. A
 *     malformed target is a refusal. A name that resolves anywhere private is a
 *     refusal. There is no branch in which an unrecognised input is permitted.
 *   - **It is not trusted by the thing it protects.** Compromising the agent
 *     does not compromise the proxy: they are separate containers, and the only
 *     input crossing between them is a hostname that has been through
 *     `parseAuthority` before anything else touches it.
 */
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import type { Duplex } from 'node:stream';
import { decide, parseAllowlist } from './allowlist.js';
import { blockedReason } from './addresses.js';

const PORT = Number(process.env['TULIP_EGRESS_PORT'] ?? 3128);
const HOST = process.env['TULIP_EGRESS_HOST'] ?? '0.0.0.0';

/** Bound so a runaway agent cannot exhaust file descriptors on the host. */
const MAX_TUNNELS = Number(process.env['TULIP_EGRESS_MAX_TUNNELS'] ?? 32);
/** How long to wait for the upstream TCP handshake. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Idle tunnels are closed. Long-poll style API calls refresh this on traffic. */
const IDLE_TIMEOUT_MS = Number(process.env['TULIP_EGRESS_IDLE_MS'] ?? 300_000);

const allow = parseAllowlist(process.env['TULIP_EGRESS_ALLOW']);

let openTunnels = 0;

type LogFields = Record<string, string | number | boolean | null>;

/**
 * One JSON object per line, on stdout, for `docker compose logs`.
 *
 * Every decision is logged, allow and deny alike. A proxy that logs only
 * refusals cannot answer the question an incident actually asks, which is what
 * the agent successfully reached and when.
 */
function log(event: string, fields: LogFields = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

/** Refuse a CONNECT with a status line, then close. */
function refuse(socket: net.Socket, status: number, message: string): void {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}

/**
 * Resolve a hostname and return the first address safe to dial.
 *
 * The resolved address is returned so the caller connects to *it* rather than
 * re-resolving by name. That closes the DNS rebinding window: without it, the
 * name could resolve to a public address for this check and a private one a
 * moment later when `net.connect` looks it up again.
 */
async function resolveSafely(host: string): Promise<{ address: string; family: 4 | 6 } | { error: string }> {
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    return { error: `DNS lookup failed: ${(err as NodeJS.ErrnoException).code ?? 'unknown'}` };
  }

  for (const record of records) {
    const family = record.family === 6 ? 6 : 4;
    const blocked = blockedReason(record.address, family);
    if (blocked === null) return { address: record.address, family };
    log('egress.address_blocked', { host, address: record.address, reason: blocked });
  }

  return { error: 'every resolved address is private, reserved or unroutable' };
}

const server = http.createServer((req, res) => {
  // Anything that is not a CONNECT. Absolute-URI proxying is refused outright:
  // it would make this process fetch on the agent's behalf, in cleartext, with
  // its own network position — exactly the capability being withheld.
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return;
  }
  log('egress.non_connect_refused', { method: req.method ?? 'unknown', url: (req.url ?? '').slice(0, 120) });
  res.writeHead(405, { 'content-type': 'text/plain' }).end('this proxy accepts CONNECT only\n');
});

server.on('connect', (req, rawSocket: Duplex, head: Buffer) => {
  // Node types this as a Duplex, but a CONNECT always hands over the underlying
  // net.Socket. The narrowing is what lets us set an idle timeout on the client
  // side of the tunnel, not only the upstream side.
  const clientSocket = rawSocket as net.Socket;
  const authority = req.url ?? '';

  if (openTunnels >= MAX_TUNNELS) {
    log('egress.deny', { authority: authority.slice(0, 120), reason: 'tunnel limit reached', open: openTunnels });
    refuse(clientSocket, 503, 'Too Many Tunnels');
    return;
  }

  const verdict = decide(authority, allow);
  if (!verdict.allowed) {
    log('egress.deny', { authority: authority.slice(0, 120), reason: verdict.reason });
    refuse(clientSocket, 403, 'Forbidden');
    return;
  }

  const { host, port } = verdict;

  void resolveSafely(host).then((resolved) => {
    if ('error' in resolved) {
      log('egress.deny', { authority: authority.slice(0, 120), host, reason: resolved.error });
      refuse(clientSocket, 502, 'Bad Gateway');
      return;
    }

    const upstream = net.connect({ host: resolved.address, port, family: resolved.family });
    let settled = false;

    const shutdown = (why: string, detail?: string): void => {
      if (settled) {
        // Already counted; just make sure both ends are down.
        upstream.destroy();
        clientSocket.destroy();
        return;
      }
      settled = true;
      log('egress.close', { host, port, why, ...(detail === undefined ? {} : { detail }) });
      upstream.destroy();
      clientSocket.destroy();
    };

    upstream.setTimeout(CONNECT_TIMEOUT_MS);

    upstream.once('connect', () => {
      openTunnels += 1;
      settled = true;
      log('egress.allow', { host, port, address: resolved.address, open: openTunnels });

      // Past the handshake, the timeout becomes an idle timeout on both ends.
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      clientSocket.setTimeout(IDLE_TIMEOUT_MS);

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);

      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);

      // Four events can end one tunnel — either side closing, either side going
      // idle — and all four usually fire. The counter must be decremented
      // exactly once per tunnel, or it drifts downwards and MAX_TUNNELS quietly
      // stops binding, which is the limit failing open under load.
      let released = false;
      const done = (why: string) => (): void => {
        if (!released) {
          released = true;
          openTunnels -= 1;
          log('egress.close', { host, port, why, open: openTunnels });
        }
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.once('close', done('upstream closed'));
      clientSocket.once('close', done('client closed'));
      upstream.once('timeout', done('upstream idle'));
      clientSocket.once('timeout', done('client idle'));
    });

    upstream.once('timeout', () => {
      if (!settled) shutdown('upstream connect timed out');
    });
    upstream.once('error', (err) => {
      if (!settled) {
        refuse(clientSocket, 502, 'Bad Gateway');
        shutdown('upstream error', (err as NodeJS.ErrnoException).code ?? 'unknown');
      }
    });
    clientSocket.once('error', () => {
      if (!settled) shutdown('client error');
    });
  });
});

server.listen(PORT, HOST, () => {
  log('egress.up', {
    port: PORT,
    host: HOST,
    allowExact: [...allow.exact].join(',') || '(none)',
    allowSuffixes: allow.suffixes.map((s) => `*.${s}`).join(',') || '(none)',
    maxTunnels: MAX_TUNNELS,
  });
  if (allow.exact.size === 0 && allow.suffixes.length === 0) {
    log('egress.warn', { message: 'allowlist is empty — every CONNECT will be refused' });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('egress.down', { signal });
    server.close(() => process.exit(0));
    // Do not wait forever for in-flight tunnels to drain.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
