/**
 * `fetch`, done with a real browser — and why that does not break the rule in
 * exa.ts.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 *
 * The bridge never dials a URL the agent chose. It sits on both networks, and a
 * URL-fetching endpoint here would be server-side request forgery with a
 * WhatsApp account attached. Nothing in this file opens a socket. It writes a
 * request into one volume and reads an answer from another.
 *
 * ── Who does dial it ─────────────────────────────────────────────────────────
 *
 * `tulip-browser`: headless Chromium, in a container that is untrusted by
 * design, on an `internal: true` network whose only other member is a proxy
 * that refuses every private address. It can reach the public internet and
 * nothing else — not the bridge, not the agent, not the host's networks, not
 * the tailnet. That is what the old rule was protecting, and it is still
 * protected; the difference is that the process doing the fetching is now one
 * with nothing to reach. See THREAT-MODEL.md §T9.
 *
 * ── What that makes this file ────────────────────────────────────────────────
 *
 * A reader of hostile input. The browser renders pages written by anybody, so
 * it must be assumed compromised, and everything it writes is treated the way
 * outbox.ts treats the agent's actions:
 *
 *   - **Nothing is followed.** Files are opened `O_NOFOLLOW | O_NONBLOCK`. A
 *     symlink the browser plants in its volume would otherwise be resolved in
 *     *this* namespace, where `/state` holds the WhatsApp credentials; a FIFO
 *     would hang the read for ever.
 *   - **Nothing is trusted to be small.** Sizes are checked on the open file
 *     descriptor before a byte is read.
 *   - **Nothing is named by the browser.** The screenshot's path is derived from
 *     the request id; the result carries a boolean, not a filename.
 *   - **Nothing becomes prose unless it is page text.** A failure is a code from
 *     a closed list and the words are chosen here, so a compromised browser
 *     cannot write the sentence the agent reads outside the "this is data"
 *     banner.
 *
 * And, because the Pi has no memory cgroup: one page at a time, from this side
 * as well as the browser's, so a queue of requests is never a pile of Chromiums.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  BROWSE_MAX_RESULT_BYTES,
  BROWSE_MAX_SCREENSHOT_BYTES,
  BROWSE_MAX_TEXT,
  BrowseRequest,
  BrowseResult,
  PNG_MAGIC,
  browsePaths,
  inPaths,
  stripControls,
  writeFileAtomic,
  writeJsonAtomic,
  type BrowseFailure,
  type BrowseLayout,
} from '@2lp/shared';
import { fetchPage, type ExaOutcome } from './exa.js';
import { log } from './log.js';

/**
 * How long to wait for text alone, and for text and a picture.
 *
 * The browser kills Chromium at twenty seconds a run, and a picture is a second
 * run; these leave room for the poll and nothing more. Both sit well inside the
 * agent's own wait (wa-cli.ts), which also has to cover the search provider if
 * the browser fails.
 */
const TEXT_TIMEOUT_MS = 30_000;
const LOOK_TIMEOUT_MS = 55_000;
const POLL_MS = 250;
/** The browser touches its heartbeat every five seconds. */
const HEARTBEAT_STALE_MS = 20_000;
/** Anything left in either volume longer than this was abandoned. */
const ORPHAN_MS = 2 * 60_000;

/** What each failure code means, in words chosen on this side of the boundary. */
const WORDS: Record<BrowseFailure, string> = {
  unreachable:
    'the site could not be reached — the name may not exist, it may point at a private address, or the server may be down',
  certificate: "the site's security certificate is not valid, so a browser would warn anyone opening it",
  timeout: 'the page was still loading after 20 seconds',
  crashed: 'the browser crashed on this page',
  'error-page': 'the browser showed an error page instead of the site',
  'proxy-down': "the browser's proxy is not running",
  'bad-request': 'the browser could not read the request',
};

export type BrowseOutcome =
  | {
      kind: 'page';
      title: string;
      text: string;
      truncated: boolean;
      screenshot: Buffer | null;
      /** Why there is no picture, when one was asked for. */
      screenshotNote: string | null;
      ms: number;
    }
  /** The browser worked and the page did not. */
  | { kind: 'failed'; reason: string }
  /** The browser could not be used for this page at all. */
  | { kind: 'unavailable'; reason: string };

/**
 * Whether to ask the browser at all.
 *
 * Both halves are required: the operator's flag, and the volumes actually
 * mounted. A bridge deployed without the browser — no flag, or an old compose
 * file — writes nothing and behaves exactly as it did before this existed.
 */
export function browserEnabled(env: NodeJS.ProcessEnv = process.env, layout: BrowseLayout = browsePaths): boolean {
  const flag = (env['TULIP_BROWSER'] ?? '').trim().toLowerCase();
  if (!['1', 'true', 'yes', 'on'].includes(flag)) return false;
  return isDirectory(layout.requests) && isDirectory(layout.results);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type PreparedUrl = { ok: true; url: string; upgraded: boolean } | { ok: false; reason: string };

/**
 * Turn the agent's URL into one the browser can open, or say why not.
 *
 * The proxy opens port 443 and nothing else, so `http://` is tried as
 * `https://` — and the answer says so, because a site that only works over
 * plain HTTP would otherwise look broken. A URL with a username or password in
 * it, or a port other than 443, is not sent at all: the proxy would refuse it,
 * and refusing it here means the reason is ours rather than a timeout.
 */
export function prepareUrl(raw: string): PreparedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'that is not a web address the browser can open' };
  }
  let upgraded = false;
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
    upgraded = true;
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'the browser opens only http and https addresses' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the browser does not open addresses with a username or password in them' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, reason: `the browser can reach only standard https addresses, not port ${url.port}` };
  }
  return { ok: true, url: url.toString(), upgraded };
}

export type BoundedRead =
  | { ok: true; data: Buffer }
  | { ok: false; reason: 'missing' | 'not a regular file' | 'too large' | 'unreadable' };

/**
 * Read a file the browser wrote, without trusting anything about it.
 *
 * `O_NOFOLLOW` refuses a symlink in the final component — the only component
 * the browser controls, since the directory is a volume root it cannot
 * replace. `O_NONBLOCK` makes opening a FIFO return at once instead of waiting
 * for a writer that may never come; the `isFile` check then refuses it. The
 * size is read from the open descriptor and at most that many bytes are read,
 * so a file that grows while it is being read cannot grow the read.
 */
export function readBounded(file: string, maxBytes: number): BoundedRead {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing' };
    if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, reason: 'not a regular file' };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too large' };
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return { ok: true, data: data.subarray(0, offset) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

function isPng(data: Buffer): boolean {
  return data.length >= PNG_MAGIC.length && data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/**
 * Delete what was abandoned in either volume.
 *
 * The browser cannot delete requests (its mount is read-only), and an answer
 * that arrives after the bridge stopped waiting has nobody to read it. Only
 * files and links are removed; a directory is left where it is rather than
 * recursed into, because it was not put there by anything that should be.
 */
export function sweepOrphans(layout: BrowseLayout, now = Date.now()): number {
  let removed = 0;
  for (const dir of [layout.requests, layout.results]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.slice(0, 1000)) {
      const path = `${dir}/${name}`;
      if (path === layout.heartbeat) continue;
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory() || now - stat.mtimeMs < ORPHAN_MS) continue;
        rmSync(path, { force: true });
        removed += 1;
      } catch {
        /* already gone */
      }
    }
  }
  return removed;
}

function heartbeatAge(layout: BrowseLayout): number | null {
  try {
    // Its modification time only. The contents were written by the browser.
    return Date.now() - lstatSync(layout.heartbeat).mtimeMs;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let tail: Promise<unknown> = Promise.resolve();

/** Run tasks strictly one after another, whatever each of them does. */
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.catch(() => undefined);
  return run;
}

export interface BrowseOptions {
  layout?: BrowseLayout;
  timeoutMs?: number;
  pollMs?: number;
  heartbeatStaleMs?: number;
}

/** Ask the browser for one page. Never throws. */
export function browse(url: string, screenshot: boolean, options: BrowseOptions = {}): Promise<BrowseOutcome> {
  return oneAtATime(() => browseNow(url, screenshot, options));
}

async function browseNow(url: string, screenshot: boolean, options: BrowseOptions): Promise<BrowseOutcome> {
  const layout = options.layout ?? browsePaths;
  const timeoutMs = options.timeoutMs ?? (screenshot ? LOOK_TIMEOUT_MS : TEXT_TIMEOUT_MS);
  const pollMs = options.pollMs ?? POLL_MS;
  sweepOrphans(layout);

  const age = heartbeatAge(layout);
  if (age === null || age > (options.heartbeatStaleMs ?? HEARTBEAT_STALE_MS)) {
    return { kind: 'unavailable', reason: 'the browser is not running' };
  }

  const id = randomUUID();
  const request = BrowseRequest.safeParse({ id, url, screenshot });
  if (!request.success) return { kind: 'unavailable', reason: 'the browser cannot open that address' };
  try {
    writeJsonAtomic(layout.request(id), request.data, 0o644);
  } catch (err) {
    log('browse.requestFailed', { err: String((err as Error).message) });
    return { kind: 'unavailable', reason: 'the browser could not be asked' };
  }

  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const read = readBounded(layout.result(id), BROWSE_MAX_RESULT_BYTES);
      if (read.ok) return interpret(id, read.data, screenshot, layout);
      if (read.reason !== 'missing') {
        log('browse.resultRefused', { id, reason: read.reason });
        return { kind: 'unavailable', reason: `the browser's answer was refused (${read.reason})` };
      }
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    log('browse.timeout', { id, ms: timeoutMs });
    return {
      kind: 'unavailable',
      reason: `the browser did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
    };
  } finally {
    for (const file of [layout.request(id), layout.result(id), layout.screenshot(id)]) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* a directory planted under this name; the sweep leaves it, and so does this */
      }
    }
  }
}

function interpret(id: string, data: Buffer, wantScreenshot: boolean, layout: BrowseLayout): BrowseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    log('browse.resultInvalid', { id, why: 'not JSON' });
    return { kind: 'unavailable', reason: "the browser's answer was not readable" };
  }
  const parsed = BrowseResult.safeParse(json);
  if (!parsed.success || parsed.data.id !== id) {
    log('browse.resultInvalid', { id, why: parsed.success ? 'wrong id' : 'schema' });
    return { kind: 'unavailable', reason: "the browser's answer was malformed" };
  }
  const result = parsed.data;

  if (!result.ok) {
    const failure = result.failure ?? 'error-page';
    const reason = WORDS[failure] + (result.netError === null ? '' : ` (${result.netError})`);
    // A proxy that is down, or a request the browser could not read, is not
    // the page's fault, and must not be reported to a person as though it were.
    if (failure === 'proxy-down' || failure === 'bad-request') return { kind: 'unavailable', reason };
    return { kind: 'failed', reason };
  }

  let screenshot: Buffer | null = null;
  let screenshotNote: string | null = null;
  if (wantScreenshot) {
    if (!result.screenshot) {
      screenshotNote = 'the browser could not take a picture of this page';
    } else {
      const picture = readBounded(layout.screenshot(id), BROWSE_MAX_SCREENSHOT_BYTES);
      if (!picture.ok) {
        screenshotNote =
          picture.reason === 'too large' ? 'the picture was too large to pass on' : 'the picture could not be read';
      } else if (!isPng(picture.data)) {
        screenshotNote = 'the picture was not a PNG, so it was dropped';
      } else {
        screenshot = picture.data;
      }
    }
    if (screenshotNote !== null) log('browse.screenshotRefused', { id, why: screenshotNote });
  }

  return {
    kind: 'page',
    // Stripped again here: the browser's own pass ran inside the process that
    // had just rendered the page.
    title: stripControls(result.title).trim(),
    text: stripControls(result.text),
    truncated: result.truncated,
    screenshot,
    screenshotNote,
    ms: result.ms,
  };
}

// ─── fetch: the browser first, then the search provider ────────────────────

export interface ReadPageDeps {
  enabled: () => boolean;
  browse: (url: string, screenshot: boolean) => Promise<BrowseOutcome>;
  fetchPage: (url: string) => Promise<ExaOutcome>;
  saveScreenshot: (actionId: string, png: Buffer) => void;
}

const DEFAULT_DEPS: ReadPageDeps = {
  enabled: () => browserEnabled(),
  browse: (url, screenshot) => browse(url, screenshot),
  fetchPage,
  saveScreenshot: (actionId, png) => {
    mkdirSync(inPaths.results, { recursive: true });
    // Mode 0644: the agent reads it, from a mount it cannot write.
    writeFileAtomic(inPaths.resultImage(actionId), png, 0o644);
  },
};

/** Host only, for logging. Never log a full agent-supplied URL. */
function safeHost(url: string): string {
  try {
    return new URL(url).host.slice(0, 100);
  } catch {
    return '(unparseable)';
  }
}

/**
 * Answer a `fetch`: the browser first, then the search provider.
 *
 * The browser goes first because it is what a person sees. It opens pages that
 * ask search engines to stay away — which the provider honours, and which is
 * every site on hfs2s.app — and it runs the scripts that draw a JavaScript app.
 * If it is not deployed, not running, or cannot open this page, the provider's
 * copy is the next best thing, and it is labelled as that.
 *
 * **Every answer says where it came from**, in the text the agent reads, and a
 * browser failure is carried into the fallback's answer rather than dropped.
 * That is the lesson of the bug this replaced: an agent told only "nothing
 * found" will fill in the reason itself, and it will choose the alarming one.
 *
 * The source is written into the item's text rather than into a new field on
 * `ToolResult`, deliberately. The agent parses results strictly, so a new field
 * would make every answer unreadable to an agent image built before it —
 * forcing a recreate of the one container whose restart ends every live
 * conversation. As text, a new bridge works with the old agent unchanged.
 *
 * Never throws: a failed read is an answer the agent can pass on.
 */
export async function readPage(
  actionId: string,
  rawUrl: string,
  look: boolean,
  deps: ReadPageDeps = DEFAULT_DEPS,
): Promise<ExaOutcome> {
  let browserSaid: string | null = null;

  try {
    if (deps.enabled()) {
      const prepared = prepareUrl(rawUrl);
      if (!prepared.ok) {
        browserSaid = prepared.reason;
      } else {
        const outcome = await deps.browse(prepared.url, look);
        if (outcome.kind === 'page') {
          let pictureLine: string | null = null;
          if (look) {
            if (outcome.screenshot === null) {
              pictureLine = `[No picture: ${outcome.screenshotNote ?? 'none came back'}.]`;
            } else {
              try {
                deps.saveScreenshot(actionId, outcome.screenshot);
              } catch (err) {
                log('browse.screenshotSaveFailed', { err: String((err as Error).message) });
                pictureLine = '[No picture: it could not be saved.]';
              }
            }
          }
          const header = [
            '[Read by a real browser: this is the page as a person would see it once it had loaded.]',
            prepared.upgraded
              ? '[The link was http://. It was opened as https://, because only secure addresses can be reached.]'
              : null,
            outcome.truncated
              ? `[A long page: only the first ${BROWSE_MAX_TEXT.toLocaleString('en-GB')} characters are here.]`
              : null,
            pictureLine,
          ]
            .filter((line): line is string => line !== null)
            .join('\n');
          log('browse.page', {
            host: safeHost(prepared.url),
            chars: outcome.text.length,
            truncated: outcome.truncated,
            screenshot: look && pictureLine === null,
            ms: outcome.ms,
          });
          return {
            ok: true,
            items: [
              {
                title: (outcome.title || '(untitled)').slice(0, 300),
                url: prepared.url.slice(0, 2000),
                published: null,
                text: `${header}\n\n${outcome.text || '(the page has no readable text)'}`,
              },
            ],
          };
        }
        browserSaid = outcome.reason;
        log(outcome.kind === 'failed' ? 'browse.failed' : 'browse.unavailable', {
          host: safeHost(prepared.url),
          reason: outcome.reason.slice(0, 120),
        });
      }
    }
  } catch (err) {
    // Unreachable by design — every path above returns an outcome — but a bug
    // here must cost the browser, never the answer.
    log('browse.error', { err: String((err as Error).message).slice(0, 200) });
    browserSaid = 'the browser failed unexpectedly';
  }

  const fallback = await deps.fetchPage(rawUrl);
  if (fallback.ok) {
    const header = [
      "[Read by the search provider, not a browser: it is the provider's copy, which may be out of date, and scripts did not run.]",
      browserSaid === null ? null : `[The browser could not open it: ${browserSaid}.]`,
      look ? '[No picture: only the browser can take one.]' : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
    return { ok: true, items: fallback.items.map((item) => ({ ...item, text: `${header}\n\n${item.text}` })) };
  }
  if (browserSaid === null) return fallback;
  return { ok: false, error: `the browser: ${browserSaid}; the search provider: ${fallback.error}` };
}
