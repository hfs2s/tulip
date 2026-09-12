/**
 * Web search and page reading, performed by the bridge on the agent's behalf.
 *
 * ── Why it is here and not there ─────────────────────────────────────────────
 *
 * The obvious implementation gives the agent an Exa key and opens
 * `api.exa.ai` in the egress allowlist. That would be a bad trade twice over:
 * a live credential lands in the container the threat model assumes an attacker
 * owns, and — worse — Exa's contents endpoint fetches arbitrary URLs, so a hole
 * punched for "search" is in practice a hole for *reading the whole internet*
 * from inside the jail, which is a general-purpose exfiltration channel with a
 * convenient API.
 *
 * So the agent asks and the bridge answers. The key stays on the trusted side,
 * the egress allowlist gains nothing, and the request/response pair is narrow
 * enough to read in one sitting.
 *
 * ── The one that would have been a real vulnerability ────────────────────────
 *
 * `fetch` must never mean "the bridge performs an HTTP GET on a URL the agent
 * chose". The bridge sits on both networks. A URL-fetching endpoint driven by
 * an untrusted process is textbook server-side request forgery, and it would
 * have handed the agent exactly the reach that `internal: true` exists to deny
 * — including cloud metadata, the Docker gateway, and anything else on the
 * host's networks.
 *
 * Instead the bridge asks *Exa* to fetch the page. Exa's servers do the
 * retrieval and return text; the only host this module ever connects to is
 * `api.exa.ai`. The agent's URL is data in a JSON body, never a destination.
 *
 * Exa is now the second thing asked, not the first. A page is opened in
 * `tulip-browser` before this module is consulted — which keeps the rule
 * above exactly: the browser dials the URL, from a container that can reach
 * nothing private, and the bridge still dials nothing. See bridge/src/browse.ts.
 *
 * ── What this does cost ──────────────────────────────────────────────────────
 *
 * Two things, both stated in THREAT-MODEL.md rather than hidden here:
 *
 *   - a search phrase is agent-controlled text that leaves the deployment, so
 *     the residual channel of §T2 is now wider than a reply to one chat;
 *   - page text is hostile content from outside the conversation, which makes
 *     the indirect prompt injection of §T6 live rather than theoretical.
 */
import { z } from 'zod';
import { log } from './log.js';

/** Per page of text handed to the agent. A context is finite and shared. */
const MAX_CHARS_PER_ITEM = 4000;
const TIMEOUT_MS = 20_000;

const ExaResult = z
  .object({
    title: z.string().nullish(),
    url: z.string().nullish(),
    publishedDate: z.string().nullish(),
    text: z.string().nullish(),
  })
  .passthrough();

/**
 * Exa's per-URL verdicts for `/contents`.
 *
 * These were thrown away until they cost a real conversation. Exa answers a
 * page it will not read with an empty `results` and the reason in here — for
 * every site on hfs2s.app, `CRAWL_NOINDEX`, because they send
 * `x-robots-tag: noindex` — and discarding it turned "the provider declines to
 * read this" into "fetch: nothing found", which the agent read, reasonably, as
 * the site being down. Loose on purpose: an unfamiliar shape here should cost
 * the explanation, never the answer.
 */
const ExaStatus = z
  .object({
    id: z.string().nullish(),
    status: z.string().nullish(),
    error: z
      .object({ tag: z.string().nullish(), httpStatusCode: z.number().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const ExaResponse = z.object({
  results: z.array(ExaResult).default([]),
  statuses: z.array(ExaStatus).nullish(),
});

export interface ExaItem {
  title: string;
  url: string;
  published: string | null;
  text: string;
}

export type ExaOutcome = { ok: true; items: ExaItem[] } | { ok: false; error: string };

/** What `call` knows that its callers may want: why a page came back empty. */
type CallOutcome = { ok: true; items: ExaItem[]; refusal: string | null } | { ok: false; error: string };

/**
 * Exa's crawl tags, in words the agent can repeat to a person without being
 * wrong. The ones that matter most say explicitly what they do *not* mean,
 * because the failure being fixed was a refusal read as an outage.
 */
const REFUSALS: Record<string, string> = {
  CRAWL_NOINDEX:
    'the page asks not to be indexed, and the search provider honours that — it says nothing about whether the site is up',
  CRAWL_NOT_FOUND: 'the search provider found no page at that address',
  CRAWL_TIMEOUT: 'the search provider timed out reading the page',
  CRAWL_LIVECRAWL_TIMEOUT: 'the search provider timed out reading the page',
  SOURCE_NOT_AVAILABLE:
    'the site refused the search provider — that says nothing about whether it works for a person',
  CRAWL_UNKNOWN_ERROR: 'the search provider could not read the page, and did not say why',
};

/**
 * The first refusal in a `/contents` response, as a sentence, or null.
 *
 * The tag and status code come from a third party and end up in text the agent
 * reads outside the "this is data" banner, so neither is trusted to be what it
 * claims: a tag is used only if it has the shape of one, and a code only if it
 * is an HTTP status.
 */
export function describeRefusal(statuses: ReadonlyArray<z.infer<typeof ExaStatus>> | null | undefined): string | null {
  for (const status of statuses ?? []) {
    const error = status.error ?? null;
    if ((status.status ?? '').toLowerCase() !== 'error' && error === null) continue;

    const rawTag = error?.tag ?? '';
    const tag = /^[A-Z][A-Z0-9_]{0,59}$/.test(rawTag) ? rawTag : null;
    const code = error?.httpStatusCode;
    const http = typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;

    const known = tag === null ? undefined : REFUSALS[tag];
    if (known !== undefined) return known;
    const detail = [tag, http === null ? null : `HTTP ${http}`].filter((part) => part !== null).join(', ');
    return `the search provider could not read the page${detail ? ` (${detail})` : ''}`;
  }
  return null;
}

/**
 * Keys are tried in order, moving on when one is rate-limited or erroring.
 *
 * Taken from how taste-lab already uses this account: a single key hits 429
 * under bursty use, and rotating is the difference between a working tool and
 * one that fails at the worst moment.
 */
function keys(): string[] {
  return ['EXA_API_KEY', 'EXA_BACKUP_API_KEY', 'EXA_BACKUP_API_KEY2']
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function normalise(response: z.infer<typeof ExaResponse>): ExaItem[] {
  return response.results.map((r) => ({
    title: (r.title ?? '(untitled)').slice(0, 300),
    url: (r.url ?? '').slice(0, 2000),
    published: r.publishedDate ? r.publishedDate.slice(0, 40) : null,
    text: (r.text ?? '').slice(0, MAX_CHARS_PER_ITEM),
  }));
}

/**
 * One call, rotating keys on rate limits and server errors.
 *
 * Never throws — a failed lookup is a tool that returned nothing, which the
 * agent can report to a person. It must not be able to fail a conversation.
 */
async function call(path: '/search' | '/contents', body: unknown): Promise<CallOutcome> {
  const available = keys();
  if (available.length === 0) return { ok: false, error: 'no Exa API key is configured' };

  let lastError = 'the search provider did not answer';
  for (const key of available) {
    try {
      const response = await fetch(`https://api.exa.ai${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = `the search provider returned ${response.status}`;
        continue; // try the next key
      }
      if (!response.ok) return { ok: false, error: `the search provider returned ${response.status}` };

      const parsed = ExaResponse.safeParse(await response.json());
      if (!parsed.success) return { ok: false, error: 'the search provider returned an unexpected shape' };
      return { ok: true, items: normalise(parsed.data), refusal: describeRefusal(parsed.data.statuses) };
    } catch (err) {
      lastError = `the search failed (${(err as Error).name})`;
    }
  }
  return { ok: false, error: lastError };
}

export async function search(query: string, numResults: number): Promise<ExaOutcome> {
  const trimmed = query.trim().slice(0, 400);
  if (trimmed.length === 0) return { ok: false, error: 'empty query' };

  log('exa.search', { chars: trimmed.length, results: numResults });
  const outcome = await call('/search', {
    query: trimmed,
    numResults: Math.min(Math.max(numResults, 1), 10),
    type: 'auto',
    contents: { text: { maxCharacters: MAX_CHARS_PER_ITEM } },
  });
  // An empty search is an honest answer — nothing matched — so it stays one.
  return outcome.ok ? { ok: true, items: outcome.items } : outcome;
}

/**
 * Read one page.
 *
 * The URL is passed to Exa as data. This process does not connect to it; see
 * the header above for why that distinction is the entire point.
 *
 * Since `tulip-browser` exists this is the fallback rather than the first
 * resort (bridge/src/browse.ts). Either way it is honest about an empty answer:
 * a page Exa would not read comes back as a failure with the reason, and a
 * page it returned nothing for says so, rather than both collapsing into
 * "nothing found" — which, for one page, reads as "that page does not exist".
 */
export async function fetchPage(url: string): Promise<ExaOutcome> {
  const host = safeHost(url);
  log('exa.fetch', { host });
  const outcome = await call('/contents', {
    urls: [url],
    text: { maxCharacters: MAX_CHARS_PER_ITEM },
  });
  if (!outcome.ok) return outcome;

  if (outcome.items.some((item) => item.text.trim().length > 0)) return { ok: true, items: outcome.items };

  const error = outcome.refusal ?? 'the search provider returned no text for that page';
  log('exa.fetchRefused', { host, reason: error.slice(0, 80) });
  return { ok: false, error };
}

/** Host only, for logging. Never log a full agent-supplied URL. */
function safeHost(url: string): string {
  try {
    return new URL(url).host.slice(0, 100);
  } catch {
    return '(unparseable)';
  }
}
