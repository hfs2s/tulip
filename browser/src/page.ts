/**
 * One request in, one result out.
 *
 * Separated from the loop in index.ts so that everything that decides what a
 * result says can be tested with a fake Chromium: which failures are which,
 * when a screenshot is attempted, and what is kept when one is not a PNG.
 *
 * Note what this module does *not* decide: the words. A failure leaves here as
 * a code from a closed list (`BrowseFailure`), and the bridge chooses what to
 * tell the agent. This process renders hostile pages and has to be assumed
 * compromised, so nothing it writes is allowed to become prose on the trusted
 * side.
 */
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BROWSE_MAX_SCREENSHOT_BYTES,
  BROWSE_RUN_TIMEOUT_MS,
  PNG_MAGIC,
  type BrowseFailure,
  type BrowseRequest,
  type BrowseResult,
} from '@2lp/shared/browse';
import { chromiumArgs, type RunChromium, type RunResult } from './chromium.js';
import { extractReadable } from './extract.js';

/** More than any page a person would read; less than would trouble the Pi. */
const MAX_DOM_BYTES = 5 * 1024 * 1024;

export interface PageDeps {
  run: RunChromium;
  bin: string;
  proxy: string;
  /** Where per-run profiles are made. A tmpfs in the container. */
  tmpDir: string;
  userAgent?: string;
  timeoutMs?: number;
}

export interface PageOutcome {
  result: BrowseResult;
  /** The PNG, when one was asked for and came out valid. */
  screenshot: Buffer | null;
}

/**
 * Chromium's own error pages, recognised by what they are built from.
 *
 * Both kinds — the network error page (`<body class="neterror">`) and the
 * certificate warning (`<body class="ssl">`) — are rendered from a
 * `loadTimeDataRaw` object whose `errorCode` is the real reason, and that field
 * is what is read. The page's visible text is not reliable: the network error
 * page carries a comment about the offline dinosaur game that names
 * `ERR_INTERNET_DISCONNECTED` whatever actually went wrong, and taking the
 * first `ERR_` in the document reported every tunnel the proxy refused as
 * "internet disconnected". That was found against real Chromium, as was the
 * certificate warning coming back as an ordinary page titled "Privacy error".
 *
 * A site that merely mentions an error code in its text matches none of this.
 */
const LOAD_TIME_ERROR = /var loadTimeDataRaw = \{[\s\S]{0,4000}?"errorCode":"(?:net::)?(ERR_[A-Z0-9_]{1,60})"/;
const ERROR_MARKERS = /id="main-frame-error"|<body[^>]*\bclass="(?:neterror|ssl)"/;
const ERROR_CODE_BLOCK = /class="error-code"[^>]*>(?:<!--[^>]*-->)?(?:net::)?(ERR_[A-Z0-9_]{1,60})/;

/** If this DOM is one of Chromium's error pages, its net error (when readable). */
export function errorPage(dom: string): { netError: string | null } | null {
  const fromData = LOAD_TIME_ERROR.exec(dom)?.[1];
  if (fromData !== undefined) return { netError: fromData };
  if (!ERROR_MARKERS.test(dom)) return null;
  return { netError: ERROR_CODE_BLOCK.exec(dom)?.[1] ?? null };
}

function netErrorIn(text: string): string | null {
  const match = /\b(?:net::)?(ERR_[A-Z0-9_]{1,60})\b/.exec(text);
  return match?.[1] ?? null;
}

/** Which of the closed list a net error belongs to. */
export function classify(netError: string | null): BrowseFailure {
  if (netError === null) return 'error-page';
  if (netError === 'ERR_PROXY_CONNECTION_FAILED') return 'proxy-down';
  if (/^ERR_(?:CERT_|SSL_|BAD_SSL)/.test(netError)) return 'certificate';
  // The proxy refusing a tunnel — a private address, a name that does not
  // resolve, a port other than 443 — is ERR_TUNNEL_CONNECTION_FAILED.
  // INTERNET_DISCONNECTED is listed because Chromium can report it for the same
  // thing when it has no other route, which in this container it never does.
  if (
    /^ERR_(?:TUNNEL_CONNECTION_FAILED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_(?:REFUSED|RESET|CLOSED|FAILED|TIMED_OUT)|ADDRESS_UNREACHABLE|TIMED_OUT|EMPTY_RESPONSE)$/.test(
      netError,
    )
  ) {
    return 'unreachable';
  }
  return 'error-page';
}

function failed(
  id: string,
  failure: BrowseFailure,
  netError: string | null,
  started: number,
): PageOutcome {
  return {
    result: {
      id,
      ok: false,
      failure,
      netError,
      title: '',
      text: '',
      truncated: false,
      screenshot: false,
      ms: Math.max(0, Math.round(Date.now() - started)),
    },
    screenshot: null,
  };
}

/** Decide what a finished DOM run means. `null` means it produced a page. */
function judge(run: RunResult): { failure: BrowseFailure; netError: string | null } | null {
  if (run.timedOut) return { failure: 'timeout', netError: null };
  if (run.spawnError !== null) return { failure: 'crashed', netError: null };
  const dom = run.stdout;
  if (dom.trim().length === 0) {
    // No page at all. Chromium logs the navigation failure to stderr, and
    // that is the only place the reason exists.
    const netError = netErrorIn(run.stderr);
    return netError === null ? { failure: 'crashed', netError: null } : { failure: classify(netError), netError };
  }
  const chromiumError = errorPage(dom);
  if (chromiumError !== null) return { failure: classify(chromiumError.netError), netError: chromiumError.netError };
  return null;
}

function readScreenshot(path: string): Buffer | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > BROWSE_MAX_SCREENSHOT_BYTES || stat.size < PNG_MAGIC.length) return null;
    const data = readFileSync(path);
    return data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? data : null;
  } catch {
    return null;
  }
}

export async function openPage(request: BrowseRequest, deps: PageDeps): Promise<PageOutcome> {
  const started = Date.now();
  const timeoutMs = deps.timeoutMs ?? BROWSE_RUN_TIMEOUT_MS;
  // A fresh profile per request, deleted afterwards: no cookie, cache entry or
  // service worker from one page survives to be read by the next.
  const profile = join(deps.tmpDir, `run-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = {
    HOME: profile,
    XDG_CONFIG_HOME: join(profile, 'config'),
    XDG_CACHE_HOME: join(profile, 'cache'),
    PATH: '/usr/bin:/bin',
  };

  try {
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const base = {
      proxy: deps.proxy,
      userDataDir: join(profile, 'data'),
      url: request.url,
      ...(deps.userAgent ? { userAgent: deps.userAgent } : {}),
    };

    const dom = await deps.run(deps.bin, chromiumArgs(base), { timeoutMs, maxStdout: MAX_DOM_BYTES, env });
    const verdict = judge(dom);
    if (verdict !== null) return failed(request.id, verdict.failure, verdict.netError, started);

    const { title, text, truncated } = extractReadable(dom.stdout);

    let screenshot: Buffer | null = null;
    if (request.screenshot) {
      const shotPath = join(profile, 'shot.png');
      // A second run, because Chromium's headless mode does one thing per
      // invocation. Its failure costs the picture, never the text.
      await deps.run(deps.bin, chromiumArgs({ ...base, screenshotPath: shotPath }), {
        timeoutMs,
        maxStdout: 64 * 1024,
        env,
      });
      screenshot = readScreenshot(shotPath);
    }

    return {
      result: {
        id: request.id,
        ok: true,
        failure: null,
        netError: null,
        title,
        text,
        truncated,
        screenshot: screenshot !== null,
        ms: Math.max(0, Math.round(Date.now() - started)),
      },
      screenshot,
    };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
