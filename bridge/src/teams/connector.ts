/**
 * The Bot Connector REST calls Tulip makes, and the activities it sends.
 *
 * Three verbs cover everything the transport does:
 *
 *   POST   {serviceUrl}v3/conversations/{id}/activities              send
 *   PUT    {serviceUrl}v3/conversations/{id}/activities/{activityId} edit
 *   DELETE {serviceUrl}v3/conversations/{id}/activities/{activityId} unsend
 *
 * A reply in a channel thread is the same POST with the thread's own
 * conversation id — the one with `;messageid=` on it — which is why the chat
 * is keyed on that id and not on the channel.
 *
 * The URL is built from a stored reference and nothing else, and the stored
 * reference passed `validServiceUrl` on the way in. It is checked again here
 * because this is the line that actually dials: the bridge is on both
 * networks, and a function that takes a URL and a bearer token is the one that
 * must never be handed an address of somebody else's choosing.
 *
 * Text goes out as Markdown. The bridge's own copy — `!status`, the operator
 * commands — is written in WhatsApp's `*bold*` and `~strike~`, which Markdown
 * reads as emphasis and nothing, so those two are converted. Single newlines
 * are made paragraph breaks: Teams' Markdown swallows a bare newline, and a
 * list the agent wrote one item per line would otherwise arrive as one line.
 *
 * Size: Teams takes roughly 100 KB of message, base64 images not counted. The
 * outbox schema caps text at 4096 characters, so nothing here chunks; an image
 * is refused above `MAX_INLINE_IMAGE_BYTES` and its caption sent instead,
 * because a send that fails on size would be retried four times to the same
 * result.
 */
import { log } from '../log.js';
import type { SentKey } from '../transport.js';
import { validServiceUrl } from './activity.js';
import type { TokenSource } from './auth.js';
import type { ConversationReference } from './references.js';

/** Generous for a generated picture, well inside what the service has taken. */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export interface OutboundActivity {
  readonly type: 'message' | 'typing';
  readonly textFormat?: 'markdown';
  readonly text?: string;
  readonly attachments?: ReadonlyArray<{ contentType: string; contentUrl: string; name?: string }>;
}

/**
 * WhatsApp's markup → Markdown, for the strings the bridge composes itself.
 *
 * Conservative on purpose: only a `*` or `~` pair that is not already doubled,
 * does not touch a word character on the outside, and stays on one line. Code
 * spans and `_italic_` are already Markdown and are left alone.
 */
export function toTeamsMarkdown(text: string): string {
  return text
    .replace(/(?<![*\w])\*(?![*\s])([^*\n]*?[^*\s])\*(?![*\w])/g, '**$1**')
    .replace(/(?<![~\w])~(?![~\s])([^~\n]*?[^~\s])~(?![~\w])/g, '~~$1~~')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?<!\n)\n(?!\n)/g, '\n\n');
}

export function textActivity(text: string): OutboundActivity {
  return { type: 'message', textFormat: 'markdown', text: toTeamsMarkdown(text) };
}

export function typingActivity(): OutboundActivity {
  return { type: 'typing' };
}

/**
 * A picture, inlined as a `data:` URL.
 *
 * Inline rather than linked because the bytes live on a volume with no public
 * address, and publishing them to mint a URL is the opposite of what the agent
 * was asked for. Microsoft documents base64 attachments as the way to embed an
 * image where external links cannot be fetched, which is the same situation.
 */
export function imageActivity(image: Buffer, mimetype: string, caption: string | null): OutboundActivity {
  return {
    type: 'message',
    ...(caption === null ? {} : { textFormat: 'markdown', text: toTeamsMarkdown(caption) }),
    attachments: [{ contentType: mimetype, contentUrl: `data:${mimetype};base64,${image.toString('base64')}`, name: 'image' }],
  };
}

/** What Teams reports for a picture's bytes, from the bytes themselves. */
export function imageMimetype(image: Buffer): string {
  if (image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (image.subarray(0, 4).equals(Buffer.from([0x47, 0x49, 0x46, 0x38]))) return 'image/gif';
  if (image.subarray(0, 4).toString('ascii') === 'RIFF' && image.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/png';
}

export class Connector {
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private activitiesUrl(ref: ConversationReference, activityId?: string): string {
    // Not a redundant check. This is the function that dials, and it must not
    // depend on every writer of `references.json` having been careful.
    if (validServiceUrl(ref.serviceUrl) !== ref.serviceUrl) {
      throw new Error('refusing to send: the stored service url is not one this bridge will dial');
    }
    const base = `${ref.serviceUrl}v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;
    return activityId === undefined ? base : `${base}/${encodeURIComponent(activityId)}`;
  }

  private async call(method: 'POST' | 'PUT' | 'DELETE', url: string, ref: ConversationReference, activity?: OutboundActivity): Promise<Response> {
    const token = await this.tokens.bearer();
    const body = activity === undefined
      ? undefined
      : JSON.stringify({ ...activity, from: { id: ref.botId }, conversation: { id: ref.conversationId } });
    const response = await this.fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The status and a little of the body, which names the error code.
      // Never the request: that carried the token.
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 160).replace(/\s+/g, ' ');
      } catch {
        /* the status is enough */
      }
      throw new Error(`Teams returned ${String(response.status)}${detail ? `: ${detail}` : ''}`);
    }
    return response;
  }

  /** Send into a conversation. The id Teams assigns comes back, when it gives one. */
  async send(ref: ConversationReference, activity: OutboundActivity): Promise<SentKey> {
    const response = await this.call('POST', this.activitiesUrl(ref), ref, activity);
    try {
      const payload = (await response.json()) as { id?: unknown };
      return typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : null;
    } catch {
      return null;
    }
  }

  async update(ref: ConversationReference, activityId: string, activity: OutboundActivity): Promise<void> {
    await this.call('PUT', this.activitiesUrl(ref, activityId), ref, activity);
  }

  async remove(ref: ConversationReference, activityId: string): Promise<void> {
    await this.call('DELETE', this.activitiesUrl(ref, activityId), ref);
  }

  /**
   * Fetch an attachment a person sent, within a byte cap.
   *
   * No redirects: a 3xx is a failure, because following one is how a link on
   * an allowed host becomes a request to any host. The token goes only where
   * `activity.ts` said it may.
   */
  async fetchAttachment(url: URL, withAuth: boolean, maxBytes: number): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
    try {
      const headers: Record<string, string> = {};
      if (withAuth) headers['authorization'] = `Bearer ${await this.tokens.bearer()}`;
      const response = await this.fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) return { ok: false, error: `attachment fetch returned ${String(response.status)}` };
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return { ok: false, error: `attachment is larger than the ${String(maxBytes)} byte limit` };
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > maxBytes) return { ok: false, error: 'attachment exceeded the size limit once downloaded' };
      return { ok: true, data };
    } catch (err) {
      log('teams.attachmentFailed', { err: String((err as Error).message).slice(0, 120) });
      return { ok: false, error: String((err as Error).message).slice(0, 200) };
    }
  }
}
