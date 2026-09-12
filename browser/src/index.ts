/**
 * tulip-browser — a headless Chromium that opens one page at a time.
 *
 * It exists so that `fetch` can mean what a person means by it: open the link
 * and see what is there. Everything about where it sits is chosen so that it
 * can afford to render anything:
 *
 *   - **Its only network is `tulip-web`**, `internal: true`, whose one other
 *     member is `tulip-webproxy`. That proxy opens port 443 to any public
 *     hostname and refuses every private, loopback, link-local and Tailscale
 *     address — so a page can reach the internet and nothing on the host's
 *     networks. There is no default route and no working DNS, exactly as for
 *     the agent.
 *   - **It shares no network with the bridge.** They talk through two volumes,
 *     as the bridge and the agent do; see shared/src/browse.ts.
 *   - **It holds nothing.** No key, no session, no volume but its own two. A
 *     renderer exploit gains a read-only root filesystem, a tmpfs, and the
 *     permission to write answers the bridge treats as hostile.
 *
 * The loop below is serial on purpose. See chromium.ts for why "one page at a
 * time" is a memory control on this host rather than a simplification.
 */
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeFileAtomic, writeJsonAtomic } from '@2lp/shared/atomic';
import { BrowseRequest, browsePaths } from '@2lp/shared/browse';
import { runChromium } from './chromium.js';
import { openPage } from './page.js';

const POLL_MS = 500;
const HEARTBEAT_MS = 5000;
/** A request older than this was abandoned by the bridge; do not open it. */
const STALE_MS = 45_000;
/** Requests are a few hundred bytes. Anything larger is not one of them. */
const MAX_REQUEST_BYTES = 4096;
const REQUEST_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

/**
 * The proxy is required, and it must be an address, not a name.
 *
 * Without it Chromium would try to connect directly — which fails, because
 * there is no route — but a browser that is contained only by the network
 * happening to be broken is one configuration change from not being contained.
 * Refusing to start makes a missing proxy loud. A name would need DNS, which
 * this container deliberately does not have.
 */
const PROXY = process.env['TULIP_BROWSER_PROXY'] ?? '';
if (!/^http:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(PROXY)) {
  log('browser.misconfigured', { reason: 'TULIP_BROWSER_PROXY must be http://<ipv4>:<port>' });
  process.exit(1);
}

const BIN = process.env['TULIP_BROWSER_BIN'] ?? '/usr/lib/chromium/chromium';
const TMP = process.env['TMPDIR'] ?? tmpdir();
const USER_AGENT = process.env['TULIP_BROWSER_USER_AGENT'] ?? '';

/** Ids already handled, so a request the bridge has not yet deleted is not opened twice. */
const seen = new Set<string>();
function remember(id: string): void {
  seen.add(id);
  if (seen.size > 500) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
}

function heartbeat(): void {
  try {
    writeFileSync(browsePaths.heartbeat, String(Date.now()));
  } catch (err) {
    log('browser.heartbeatFailed', { err: String((err as Error).message) });
  }
}

/** The oldest waiting request that has not been handled, or null. */
function nextRequest(): { id: string; file: string } | null {
  let names: string[];
  try {
    names = readdirSync(browsePaths.requests);
  } catch {
    return null;
  }
  const candidates: Array<{ id: string; file: string; mtime: number }> = [];
  for (const name of names) {
    if (!REQUEST_NAME.test(name)) continue;
    const id = name.slice(0, -'.json'.length);
    if (seen.has(id)) continue;
    const file = `${browsePaths.requests}/${name}`;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) {
        remember(id);
        continue;
      }
      if (Date.now() - stat.mtimeMs > STALE_MS) {
        remember(id);
        log('browser.stale', { id });
        continue;
      }
      candidates.push({ id, file, mtime: stat.mtimeMs });
    } catch {
      /* removed between listing and stat */
    }
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  const first = candidates[0];
  return first === undefined ? null : { id: first.id, file: first.file };
}

async function handle(id: string, file: string): Promise<void> {
  remember(id);
  let parsed: ReturnType<typeof BrowseRequest.safeParse>;
  try {
    parsed = BrowseRequest.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    parsed = BrowseRequest.safeParse(null);
  }

  if (!parsed.success || parsed.data.id !== id) {
    log('browser.badRequest', { id });
    writeJsonAtomic(browsePaths.result(id), {
      id,
      ok: false,
      failure: 'bad-request',
      netError: null,
      title: '',
      text: '',
      truncated: false,
      screenshot: false,
      ms: 0,
    }, 0o644);
    return;
  }

  const request = parsed.data;
  const { result, screenshot } = await openPage(request, {
    run: runChromium,
    bin: BIN,
    proxy: PROXY,
    tmpDir: TMP,
    ...(USER_AGENT ? { userAgent: USER_AGENT } : {}),
  });

  // The picture first, then the answer: the bridge treats the answer's
  // arrival as the moment everything is ready.
  if (screenshot !== null) writeFileAtomic(browsePaths.screenshot(id), screenshot, 0o644);
  writeJsonAtomic(browsePaths.result(id), result, 0o644);
  // The host only. A full URL can carry a token in its query string.
  let host = '(unparseable)';
  try {
    host = new URL(request.url).host.slice(0, 100);
  } catch {
    /* validated above; unreachable in practice */
  }
  log('browser.done', {
    id,
    host,
    ok: result.ok,
    failure: result.failure,
    netError: result.netError,
    chars: result.text.length,
    screenshot: result.screenshot,
    ms: result.ms,
  });
}

let stopping = false;

async function loop(): Promise<void> {
  while (!stopping) {
    const next = nextRequest();
    if (next === null) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    try {
      await handle(next.id, next.file);
    } catch (err) {
      // One bad page must not stop the next one. The bridge times out on the
      // missing answer and falls back to the search provider.
      log('browser.error', { id: next.id, err: String((err as Error).message).slice(0, 200) });
    }
  }
}

heartbeat();
setInterval(heartbeat, HEARTBEAT_MS).unref();
log('browser.up', { proxy: PROXY, bin: BIN });
void loop();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    log('browser.down', { signal });
    // A page in flight is killed by its own deadline; do not wait for it.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
