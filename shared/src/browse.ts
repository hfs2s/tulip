/**
 * The browser's contract — everything that crosses between `tulip-bridge` and
 * `tulip-browser`.
 *
 * ── Why there is a browser at all ────────────────────────────────────────────
 *
 * `fetch` used to mean "ask the search provider for its copy of this page". That
 * is safe, and it is not what a person sees. Every site the operator builds on
 * hfs2s.app sends `x-robots-tag: noindex`, the provider honours it, and so the
 * agent was told "nothing found" about a site that was up — and concluded,
 * reasonably and wrongly, that the whole domain was down. Pages that render in
 * JavaScript fail the same way for a different reason. Checking a link needs a
 * browser.
 *
 * ── Why it is shaped like the handoff ───────────────────────────────────────
 *
 * The rule in bridge/src/exa.ts still holds: **the bridge never dials a URL the
 * agent chose.** The browser does, from its own container, whose only route is
 * a proxy that refuses private addresses. The bridge and the browser share *no
 * network* — the bridge's panel listens on 0.0.0.0 inside its container, and a
 * shared network would put it within reach of a page's JavaScript — so they
 * talk exactly as the bridge and the agent do: two volumes, opposite
 * permissions.
 *
 *   REQ   bridge: read-write     browser: READ-ONLY
 *   RES   bridge: read-write     browser: read-write
 *
 * **The browser is untrusted.** It renders hostile pages with a JavaScript
 * engine, which is the largest attack surface anywhere in Tulip, so it has to be
 * assumed compromised just as the agent is. Everything it writes is hostile
 * input to the bridge: the schema below is strict, the text is capped, a failure
 * is a *code* from a closed list rather than a sentence (so a compromised
 * browser cannot write the words the agent reads outside the "this is data"
 * banner), and a screenshot is never named by the browser — its name is derived
 * from the request id on the trusted side.
 */
import { z } from 'zod';

/** Default mount points. Overridable for tests, like the handoff's. */
export const BROWSE_REQ_DIR = process.env['TULIP_BROWSE_REQ_DIR'] ?? '/browse/req';
export const BROWSE_RES_DIR = process.env['TULIP_BROWSE_RES_DIR'] ?? '/browse/res';

/** The on-disk layout of the two browse volumes, for any pair of directories. */
export function browseLayout(reqDir: string, resDir: string) {
  return {
    requests: reqDir,
    request: (id: string) => `${reqDir}/${id}.json`,
    results: resDir,
    result: (id: string) => `${resDir}/${id}.json`,
    /** Derived from the id, never taken from anything the browser wrote. */
    screenshot: (id: string) => `${resDir}/${id}.png`,
    /**
     * Touched by the browser every few seconds. The bridge reads only its
     * modification time — never its contents — to avoid waiting thirty seconds
     * on a browser that is not there.
     */
    heartbeat: `${resDir}/.alive`,
  } as const;
}

export type BrowseLayout = ReturnType<typeof browseLayout>;

export const browsePaths: BrowseLayout = browseLayout(BROWSE_REQ_DIR, BROWSE_RES_DIR);

/** Characters of readable text returned for one page. A context is finite. */
export const BROWSE_MAX_TEXT = 20_000;
export const BROWSE_MAX_TITLE = 300;
/** A screenshot larger than this is refused rather than passed on. */
export const BROWSE_MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;
/**
 * A result file larger than this is refused unread. Twenty thousand characters
 * JSON-escaped at six bytes apiece is 120 KB; this leaves room and no more.
 */
export const BROWSE_MAX_RESULT_BYTES = 256 * 1024;
/** Chromium's own hard limit per run, enforced by SIGKILL on its process group. */
export const BROWSE_RUN_TIMEOUT_MS = 20_000;

/** The eight bytes every PNG begins with. Checked on the trusted side. */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Remove characters that could drive a terminal or disguise text.
 *
 * C0 and C1 controls (keeping newline and tab), DEL, and the Unicode
 * bidirectional overrides and isolates — the last because they make text
 * display in an order other than the one it is read in. Applied by the browser
 * when it extracts text, and again by the bridge on receipt: the second pass is
 * the one that counts, because the first ran inside a process that had just
 * rendered the page.
 */
export function stripControls(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

/**
 * One page to open, written by the bridge.
 *
 * `https` only. The proxy the browser sits behind opens port 443 and nothing
 * else, so an `http://` link is rewritten by the bridge before it gets here and
 * the answer says so. No userinfo, no port but 443: both are refused on the
 * trusted side first, and again here, because a request the browser cannot
 * satisfy should fail at the parser rather than inside Chromium.
 */
export const BrowseRequest = z
  .object({
    id: z.string().uuid(),
    url: z
      .string()
      .url()
      .max(2000)
      .refine((u) => {
        try {
          const parsed = new URL(u);
          return (
            parsed.protocol === 'https:' &&
            parsed.username === '' &&
            parsed.password === '' &&
            (parsed.port === '' || parsed.port === '443')
          );
        } catch {
          return false;
        }
      }, 'must be a plain https URL on port 443'),
    screenshot: z.boolean(),
  })
  .strict();

/**
 * Why a page could not be read, as a code the bridge turns into words.
 *
 *   unreachable  the proxy could not connect: no such name, a private address,
 *                or a server that is down — indistinguishable from in here
 *   certificate  the site's TLS certificate is not valid
 *   timeout      Chromium was still going at the hard limit and was killed
 *   crashed      Chromium exited without producing a page
 *   error-page   Chromium showed its own error page for some other reason
 *   proxy-down   the browser's proxy itself did not answer — not the page's fault
 *   bad-request  the request did not parse
 */
export const BrowseFailure = z.enum([
  'unreachable',
  'certificate',
  'timeout',
  'crashed',
  'error-page',
  'proxy-down',
  'bad-request',
]);

/** Chromium's net error name, when there is one. A fixed shape, never prose. */
export const NetErrorCode = z.string().regex(/^ERR_[A-Z0-9_]{1,60}$/);

/**
 * What the browser found, written by the browser. **Hostile input.**
 *
 * There is deliberately no URL in here. The bridge knows which address it
 * asked for, and a field the browser could fill in is a field a compromised
 * browser could lie in.
 */
export const BrowseResult = z
  .object({
    id: z.string().uuid(),
    ok: z.boolean(),
    failure: BrowseFailure.nullable(),
    netError: NetErrorCode.nullable(),
    title: z.string().max(BROWSE_MAX_TITLE),
    text: z.string().max(BROWSE_MAX_TEXT),
    /** The page had more text than was kept. */
    truncated: z.boolean(),
    /** Whether a PNG was written at `screenshot(id)`. Its name is never in here. */
    screenshot: z.boolean(),
    /** How long it took, for the log. */
    ms: z.number().int().nonnegative().max(600_000),
  })
  .strict();

export type BrowseRequest = z.infer<typeof BrowseRequest>;
export type BrowseFailure = z.infer<typeof BrowseFailure>;
export type BrowseResult = z.infer<typeof BrowseResult>;
