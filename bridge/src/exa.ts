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

const ExaResponse = z.object({ results: z.array(ExaResult).default([]) });

export interface ExaItem {
  title: string;
  url: string;
  published: string | null;
  text: string;
}

export type ExaOutcome = { ok: true; items: ExaItem[] } | { ok: false; error: string };

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
async function call(path: '/search' | '/contents', body: unknown): Promise<ExaOutcome> {
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
      return { ok: true, items: normalise(parsed.data) };
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
  return call('/search', {
    query: trimmed,
    numResults: Math.min(Math.max(numResults, 1), 10),
    type: 'auto',
    contents: { text: { maxCharacters: MAX_CHARS_PER_ITEM } },
  });
}

/**
 * Read one page.
 *
 * The URL is passed to Exa as data. This process does not connect to it; see
 * the header above for why that distinction is the entire point.
 */
export async function fetchPage(url: string): Promise<ExaOutcome> {
  log('exa.fetch', { host: safeHost(url) });
  return call('/contents', {
    urls: [url],
    text: { maxCharacters: MAX_CHARS_PER_ITEM },
  });
}

/** Host only, for logging. Never log a full agent-supplied URL. */
function safeHost(url: string): string {
  try {
    return new URL(url).host.slice(0, 100);
  } catch {
    return '(unparseable)';
  }
}
