/**
 * GIF search, performed by the bridge on the agent's behalf.
 *
 * The agent has no route to the internet, which at first looks like a reason it
 * cannot send GIFs and is actually the reason this design is the right one: the
 * agent names *what it wants* — a search phrase — and the trusted side decides
 * what that turns into. Three things follow, all of them good:
 *
 *   - **The API key stays out of the agent container.** It lives here, on the
 *     side the threat model does not assume is compromised. Giving the agent a
 *     key and a hole in the egress allowlist would have been the obvious
 *     implementation and a strictly worse one.
 *   - **The egress allowlist is untouched.** No new destination is reachable
 *     from inside the jail, so the residual channel in THREAT-MODEL §T2 does
 *     not widen.
 *   - **The rating filter is enforced where the agent cannot reach it.** A
 *     prompt-injected agent can choose a search phrase; it cannot choose to
 *     turn off the content filter, because that decision is not expressible in
 *     the action it writes.
 *
 * What the agent *can* still do is pick a search phrase, and a phrase is enough
 * to steer results within whatever the rating permits. That is a real residual
 * and the rating filter is the only thing bounding it.
 */
import { z } from 'zod';
import { log } from './log.js';

/** Giphy's own content rating. `g` and `pg` are the defensible ones for a public bot. */
export type Rating = 'g' | 'pg' | 'pg-13' | 'r';

/** WhatsApp will not play anything large as an inline GIF, and we should not try. */
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

/**
 * The slice of Giphy's response we rely on.
 *
 * Parsed rather than trusted: this is a third-party API answering a query an
 * untrusted process chose, so it is a boundary like any other. Everything
 * unrecognised is dropped instead of being passed along.
 */
const SearchResponse = z.object({
  data: z
    .array(
      z.object({
        images: z
          .object({
            downsized_small: z.object({ mp4: z.string().url() }).partial().optional(),
            fixed_height: z.object({ mp4: z.string().url() }).partial().optional(),
            original: z.object({ mp4: z.string().url() }).partial().optional(),
          })
          .passthrough(),
        title: z.string().optional(),
      }),
    )
    .default([]),
});

export type GifResult = { ok: true; video: Buffer; title: string } | { ok: false; reason: string };

/** Prefer the smallest rendition that plays: WhatsApp re-encodes anyway. */
function pickRendition(images: z.infer<typeof SearchResponse>['data'][number]['images']): string | null {
  return images.downsized_small?.mp4 ?? images.fixed_height?.mp4 ?? images.original?.mp4 ?? null;
}

/**
 * Find a GIF for a search phrase and return it as an MP4 ready to send.
 *
 * Never throws: a missing GIF is a cosmetic failure, and the caller falls back
 * to sending words. Nothing here should be able to fail a conversation.
 */
export async function findGif(
  query: string,
  options: { apiKey: string; rating: Rating; lang?: string },
): Promise<GifResult> {
  if (options.apiKey.length === 0) return { ok: false, reason: 'no GIPHY_API_KEY is configured' };

  // The query comes from the agent. Length-capped and URL-encoded; it reaches
  // Giphy as a query parameter and nothing else.
  const q = query.trim().slice(0, 100);
  if (q.length === 0) return { ok: false, reason: 'empty search' };

  const url =
    'https://api.giphy.com/v1/gifs/search' +
    `?api_key=${encodeURIComponent(options.apiKey)}` +
    `&q=${encodeURIComponent(q)}` +
    `&limit=8&offset=0&rating=${encodeURIComponent(options.rating)}` +
    `&lang=${encodeURIComponent(options.lang ?? 'en')}&bundle=messaging_non_clips`;

  let parsed: z.infer<typeof SearchResponse>;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: `giphy search returned ${response.status}` };
    const result = SearchResponse.safeParse(await response.json());
    if (!result.success) return { ok: false, reason: 'giphy returned an unexpected shape' };
    parsed = result.data;
  } catch (err) {
    return { ok: false, reason: `giphy search failed: ${(err as Error).name}` };
  }

  if (parsed.data.length === 0) return { ok: false, reason: `nothing found for "${q}"` };

  // A little variety: the top hit every time makes a bot that sends the same
  // GIF for the same joke forever.
  const choice = parsed.data[Math.floor(Math.random() * Math.min(parsed.data.length, 5))];
  const rendition = choice ? pickRendition(choice.images) : null;
  if (!rendition) return { ok: false, reason: 'no playable rendition' };

  try {
    const response = await fetch(rendition, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: `giphy media returned ${response.status}` };

    // Checked before reading the body where the header is present, and again
    // after, because the header is the server's claim.
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return { ok: false, reason: 'gif is too large' };

    const video = Buffer.from(await response.arrayBuffer());
    if (video.length > MAX_BYTES) return { ok: false, reason: 'gif is too large' };
    if (video.length === 0) return { ok: false, reason: 'gif was empty' };

    log('giphy.found', { query: q, bytes: video.length });
    return { ok: true, video, title: choice?.title ?? q };
  } catch (err) {
    return { ok: false, reason: `giphy download failed: ${(err as Error).name}` };
  }
}
