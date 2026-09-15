/**
 * Bot Framework activity → the flat shape the rest of the bridge works with.
 *
 * This is trust boundary B1 again, on a second wire. Everything here arrives
 * over HTTPS from whoever holds a valid connector token — Microsoft, in the
 * intended case, relaying what a person in a tenant typed — and the body is
 * that person's to shape. The parser's job is the one `envelope.ts` has: to be
 * *total*, producing a defined result for every input including activity
 * types it has never seen, because the alternative is a thrown exception that
 * drops a real person's message with no record of it having arrived.
 *
 * Three things are decided here and nowhere else:
 *
 *   - **What a chat is.** A personal chat and a group chat are keyed on the
 *     conversation id. A channel post is keyed on its *thread*: Teams names a
 *     channel conversation `19:…@thread.tacv2;messageid=<root post>`, and the
 *     whole id is kept, so each post in a channel is its own chat with its own
 *     context. That is the multi-thread behaviour the operator asked for, and
 *     it is also what makes a reply land in the thread it answers.
 *   - **Who spoke.** `from.aadObjectId` is the person's Entra object id and is
 *     the identifier an allowlist can carry; `from.id` is Teams' own opaque
 *     `29:` form, recorded beside it so a denial log shows what actually
 *     arrived. Neither is a phone number, so `senderPn` is always null.
 *   - **Whether we were addressed.** From the mention *entities*, never from
 *     the text: `<at>Name</at>` in the body is typed by the sender and proves
 *     nothing, while the entity carries the id Teams resolved the mention to.
 *     Our own mention is then stripped from the text so the agent reads the
 *     question rather than its own name.
 *
 * `serviceUrl` gets special treatment because it is the one field a hostile
 * body could use to point the bridge at something. It is validated to be an
 * absolute `https://` URL with no credentials, query or fragment, and is only
 * trusted after the listener has matched it against the token's own claim.
 * The bridge sits on both networks; an unchecked URL here is an SSRF.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { InboundMedia, MediaKind } from '@2lp/shared';
import type { Envelope, ParseContext } from '../envelope.js';
import { log } from '../log.js';

const Account = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  aadObjectId: z.string().max(64).optional(),
});

const Conversation = z.object({
  id: z.string().min(1).max(256),
  conversationType: z.string().max(32).optional(),
  name: z.string().max(256).optional(),
  tenantId: z.string().max(64).optional(),
  isGroup: z.boolean().optional(),
});

const Reaction = z.object({ type: z.string().max(32) });

/**
 * The activity, as loosely as the wire allows.
 *
 * Not `.strict()`, unlike the agent's outbox: Microsoft adds fields to
 * activities at will and documents that a bot must tolerate them. Unknown keys
 * are dropped rather than refused. What *is* pinned is every field this file
 * reads, each with a ceiling, so a hostile body cannot be arbitrarily large in
 * any dimension the bridge then iterates over.
 */
export const Activity = z.object({
  type: z.string().min(1).max(64),
  id: z.string().max(256).optional(),
  timestamp: z.string().max(64).optional(),
  serviceUrl: z.string().min(1).max(512),
  channelId: z.string().max(64).optional(),
  from: Account.optional(),
  recipient: Account.optional(),
  conversation: Conversation,
  text: z.string().max(200_000).optional(),
  textFormat: z.string().max(32).optional(),
  replyToId: z.string().max(256).optional(),
  entities: z.array(z.unknown()).max(64).optional(),
  attachments: z.array(z.unknown()).max(32).optional(),
  channelData: z.unknown().optional(),
  membersAdded: z.array(Account).max(512).optional(),
  reactionsAdded: z.array(Reaction).max(32).optional(),
  reactionsRemoved: z.array(Reaction).max(32).optional(),
});

export type Activity = z.infer<typeof Activity>;

/** Parse an activity body, or say why not. Never throws. */
export function parseActivity(raw: unknown): Activity | null {
  const parsed = Activity.safeParse(raw);
  if (parsed.success) return parsed.data;
  log('teams.badActivity', { issues: parsed.error.issues.length, first: parsed.error.issues[0]?.path.join('.') ?? '' });
  return null;
}

/**
 * The only shape of `serviceUrl` the bridge will ever dial.
 *
 * Absolute, `https:` only, a real hostname, no userinfo, no query, no
 * fragment; returned with the trailing slash the connector paths are appended
 * to. Null for anything else, and null is final: the listener refuses the
 * activity and the reference store refuses to remember it.
 */
export function validServiceUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.hostname.length === 0 || url.hostname === 'localhost') return null;
  // A bare IP is not how Microsoft names a service, and it is exactly how an
  // SSRF names one.
  if (/^[0-9.]+$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `${url.protocol}//${url.host}${path}`;
}

/** `personal` is a person; everything else — `groupChat`, `channel` — is a room. */
export function isRoom(activity: Pick<Activity, 'conversation'>): boolean {
  const type = activity.conversation.conversationType;
  if (type !== undefined) return type !== 'personal';
  return activity.conversation.isGroup === true;
}

const ChannelData = z.object({
  team: z.object({ id: z.string().max(256).optional(), name: z.string().max(256).optional() }).optional(),
  channel: z.object({ id: z.string().max(256).optional(), name: z.string().max(256).optional() }).optional(),
  tenant: z.object({ id: z.string().max(64).optional() }).optional(),
  eventType: z.string().max(64).optional(),
});

function channelData(activity: Activity): z.infer<typeof ChannelData> {
  const parsed = ChannelData.safeParse(activity.channelData ?? {});
  return parsed.success ? parsed.data : {};
}

/** The tenant, wherever Teams put it this time. */
export function tenantOf(activity: Activity): string | null {
  return activity.conversation.tenantId ?? channelData(activity).tenant?.id ?? null;
}

/** What to call the room: "Team › channel" when both are known, else whichever is. */
export function roomName(activity: Activity): string | null {
  const data = channelData(activity);
  const team = data.team?.name;
  const channel = data.channel?.name;
  if (team && channel) return `${team} › ${channel}`;
  return channel ?? team ?? activity.conversation.name ?? null;
}

/** Whether the bot itself is among `membersAdded` — i.e. it was just installed here. */
export function botWasAdded(activity: Activity, botId: string): boolean {
  const mine = botId.toLowerCase();
  return (activity.membersAdded ?? []).some((m) => m.id.toLowerCase() === mine);
}

const Mention = z.object({
  type: z.literal('mention'),
  text: z.string().max(512).optional(),
  mentioned: z.object({ id: z.string().max(256), name: z.string().max(256).optional() }),
});

/**
 * Strip mentions from the text, and say whether one of them was us.
 *
 * Our own mention is removed outright; anyone else's `<at>Name</at>` becomes
 * `@Name` so the agent still sees who was addressed. Decided from the entities,
 * which carry the id Teams resolved, and never from the text.
 */
export function stripMentions(text: string, entities: readonly unknown[], botId: string): { text: string; mentionsMe: boolean } {
  const mine = botId.toLowerCase();
  let out = text;
  let mentionsMe = false;
  for (const raw of entities) {
    const parsed = Mention.safeParse(raw);
    if (!parsed.success) continue;
    const mention = parsed.data;
    const isMe = mention.mentioned.id.toLowerCase() === mine;
    if (isMe) mentionsMe = true;
    if (mention.text !== undefined && mention.text.length > 0) {
      out = out.split(mention.text).join(isMe ? '' : `@${mention.mentioned.name ?? ''}`);
    }
  }
  // Anything left in `<at>` tags was not in the entities: an unresolved
  // mention, or somebody typing the markup by hand. Shown as words either way.
  out = out.replace(/<at>([^<]*)<\/at>/g, '@$1');
  return { text: out.replace(/[ \t]+/g, ' ').trim(), mentionsMe };
}

export interface FetchedAttachment {
  readonly ok: true;
  readonly data: Buffer;
}
export interface FetchFailure {
  readonly ok: false;
  readonly error: string;
}

/**
 * How an attachment's bytes are obtained; supplied by the transport.
 *
 * `withAuth` says whether the bot's own connector token goes on the request.
 * It is true only for the service host — inline images live there and need
 * it — and never for a download link, which points at the tenant's SharePoint
 * and would otherwise be handed our bearer token.
 */
export type AttachmentFetcher = (url: URL, withAuth: boolean, maxBytes: number) => Promise<FetchedAttachment | FetchFailure>;

const FileInfo = z.object({
  contentType: z.literal('application/vnd.microsoft.teams.file.download.info'),
  name: z.string().max(256).optional(),
  content: z.object({
    downloadUrl: z.string().max(2048),
    fileType: z.string().max(16).optional(),
  }),
});

const InlineImage = z.object({
  contentType: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
  contentUrl: z.string().max(2048),
  name: z.string().max(256).optional(),
});

const IMAGE_TYPES: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const EXTENSION: Readonly<Record<MediaKind, string>> = { image: 'jpg', video: 'mp4', audio: 'ogg', sticker: 'webp', document: 'bin' };

/** The hosts a download link may point at: the tenant's own SharePoint, nothing else. */
function sharePointHost(host: string): boolean {
  return /(^|\.)sharepoint(-df)?\.com$/i.test(host);
}

interface Found {
  readonly kind: MediaKind;
  readonly url: URL | null;
  readonly withAuth: boolean;
  readonly mimetype: string | null;
  readonly fileName: string | null;
  readonly refused: string | null;
}

/**
 * What an attachment is, and whether it may be fetched at all.
 *
 * Two shapes are recognised. An inline image is a `contentUrl` on the service
 * host, fetched with our token; a file card carries a `downloadUrl` on
 * SharePoint, fetched without one. Anything else — a card, an HTML rendering
 * of the text, a link to somewhere the bridge has no business dialling — is
 * left alone. The refusal is a record on the envelope, not a silent skip.
 */
function classify(raw: unknown, serviceHost: string): Found | null {
  const file = FileInfo.safeParse(raw);
  if (file.success) {
    const type = (file.data.content.fileType ?? '').toLowerCase();
    const kind: MediaKind = IMAGE_TYPES.has(type) ? 'image' : 'document';
    const fileName = file.data.name ?? null;
    let url: URL | null = null;
    try {
      url = new URL(file.data.content.downloadUrl);
    } catch {
      url = null;
    }
    const refused = url === null || url.protocol !== 'https:'
      ? 'download link is not https'
      : sharePointHost(url.hostname) ? null : 'download link is not on the tenant\'s SharePoint';
    return { kind, url: refused === null ? url : null, withAuth: false, mimetype: null, fileName, refused };
  }
  const image = InlineImage.safeParse(raw);
  if (image.success) {
    let url: URL | null = null;
    try {
      url = new URL(image.data.contentUrl);
    } catch {
      url = null;
    }
    const refused = url === null || url.protocol !== 'https:'
      ? 'image link is not https'
      : url.host.toLowerCase() === serviceHost.toLowerCase() ? null : 'image link is not on the service host';
    return {
      kind: 'image',
      url: refused === null ? url : null,
      withAuth: true,
      mimetype: image.data.contentType.toLowerCase(),
      fileName: image.data.name ?? null,
      refused,
    };
  }
  return null;
}

/**
 * Fetch one attachment, subject to the size cap, and file it under the chat.
 *
 * The file name is composed entirely from values we control, as in
 * `envelope.ts`: the sender's `name` is arbitrary text and is kept as data on
 * the record, never used in a path.
 */
async function fetchMedia(
  found: Found,
  fetcher: AttachmentFetcher,
  ctx: ParseContext,
  messageId: string,
  ts: number,
): Promise<InboundMedia> {
  const base: Omit<InboundMedia, 'path' | 'error'> = {
    kind: found.kind,
    mimetype: found.mimetype,
    bytes: null,
    fileName: found.fileName,
    seconds: null,
    isVoiceNote: false,
    transcript: null,
  };
  if (found.refused !== null || found.url === null) {
    return { ...base, path: null, error: found.refused ?? 'attachment has no address' };
  }
  const fetched = await fetcher(found.url, found.withAuth, ctx.maxMediaBytes);
  if (!fetched.ok) return { ...base, path: null, error: fetched.error.slice(0, 200) };
  if (fetched.data.length > ctx.maxMediaBytes) {
    return { ...base, path: null, error: `attachment is larger than the ${ctx.maxMediaBytes} byte limit` };
  }
  try {
    const directory = join(ctx.mediaRoot, ctx.chatKey);
    mkdirSync(directory, { recursive: true });
    const safeId = messageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'msg';
    const name = `${ts}-${safeId}.${EXTENSION[found.kind]}`;
    writeFileSync(join(directory, name), fetched.data, { mode: 0o600 });
    return { ...base, bytes: fetched.data.length, path: `media/${ctx.chatKey}/${name}`, error: null };
  } catch (err) {
    return { ...base, path: null, error: String((err as Error).message).slice(0, 200) };
  }
}

export interface TeamsParseDeps {
  /** `28:<app id>`, as Teams names the bot in `recipient` and in mention entities. */
  readonly botId: string;
  readonly fetchAttachment: AttachmentFetcher;
}

/**
 * Parse one activity into an envelope. Never throws.
 *
 * `chatJid` on the result is the conversation id — the name is WhatsApp's and
 * every consumer already reads it as "the transport's chat id".
 */
export async function toEnvelope(activity: Activity, ctx: ParseContext, deps: TeamsParseDeps): Promise<Envelope> {
  const ts = Date.parse(activity.timestamp ?? '') || Date.now();
  const id = activity.id ?? `${ts}`;
  const room = isRoom(activity);
  const from = activity.from;

  const senderIds: string[] = [];
  for (const candidate of [from?.aadObjectId, from?.id]) {
    if (candidate && !senderIds.includes(candidate)) senderIds.push(candidate);
  }

  let text = '';
  let mentionsMe = false;
  const media: InboundMedia[] = [];

  if (activity.type === 'message') {
    const stripped = stripMentions(activity.text ?? '', activity.entities ?? [], deps.botId);
    mentionsMe = stripped.mentionsMe;
    // Truncated rather than refused, as on WhatsApp: a long question is not an
    // attack, and silently dropping it would look like the bot ignoring someone.
    text = stripped.text.length > ctx.maxInboundChars
      ? `${stripped.text.slice(0, ctx.maxInboundChars)}\n[truncated]`
      : stripped.text;

    const serviceHost = (() => {
      try {
        return new URL(activity.serviceUrl).host;
      } catch {
        return '';
      }
    })();
    for (const raw of activity.attachments ?? []) {
      const found = classify(raw, serviceHost);
      if (found === null) continue;
      if (media.length >= ctx.maxMediaPerMessage) {
        log('teams.mediaSkipped', { chatKey: ctx.chatKey, reason: ctx.maxMediaPerMessage === 0 ? 'attachments are disabled' : 'too many attachments' });
        break;
      }
      media.push(await fetchMedia(found, deps.fetchAttachment, ctx, id, ts));
    }
  } else if (activity.type === 'messageReaction') {
    // Rendered so it is recorded — the gate then refuses it as a reaction,
    // exactly as a WhatsApp thumbs-up is recorded and not answered.
    const added = (activity.reactionsAdded ?? []).map((r) => r.type);
    const removed = (activity.reactionsRemoved ?? []).map((r) => r.type);
    text = added.length > 0 ? `[reaction] ${added.join(', ')}` : removed.length > 0 ? `[reaction removed] ${removed.join(', ')}` : '[reaction]';
  }

  return {
    id,
    ts,
    chatJid: activity.conversation.id,
    isGroup: room,
    groupName: room ? roomName(activity) : null,
    senderIds,
    senderPn: null,
    pushName: from?.name ?? null,
    text,
    mentionsMe,
    // Teams hands a bot no quoted text: a reply in a thread is addressed by
    // the thread's own id, which is already the chat.
    quoted: null,
    media,
    isReaction: activity.type === 'messageReaction',
    isPollVote: false,
  };
}
