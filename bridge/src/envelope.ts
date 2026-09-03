/**
 * Raw Baileys message → the flat shape the rest of the bridge works with.
 *
 * This is trust boundary B1: everything here comes off the wire from an
 * arbitrary sender. The parser's job is to be *total* — to produce a defined
 * result for every input, including message types it has never seen — because
 * the alternative is a thrown exception that drops a real person's message with
 * no record of it having arrived.
 *
 * Attachment handling is where the abuse controls bite first. The declared size
 * is checked **before** the download starts, so a claimed two-gigabyte
 * attachment costs one comparison rather than the bandwidth and the disk.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadMediaMessage, type WAMessage, type WASocket } from 'baileys';
import type { InboundMedia, MediaKind } from '@tulip/shared';
import { bare, identities, isGroup, slug, userPart } from './jid.js';
import { log } from './log.js';

export interface Envelope {
  readonly id: string;
  readonly ts: number;
  readonly chatJid: string;
  readonly isGroup: boolean;
  readonly groupName: string | null;
  /** Every identifier this sender arrived under, for allowlist matching. */
  readonly senderIds: readonly string[];
  readonly pushName: string | null;
  readonly text: string;
  readonly mentionsMe: boolean;
  readonly quoted: { text: string; isMine: boolean } | null;
  readonly media: readonly InboundMedia[];
  readonly isReaction: boolean;
  readonly isPollVote: boolean;
}

export interface ParseContext {
  /** Opaque chat handle; media is filed under it. */
  readonly chatKey: string;
  /** Root of the inbound volume's media directory. */
  readonly mediaRoot: string;
  readonly maxMediaBytes: number;
  readonly maxMediaPerMessage: number;
  readonly maxInboundChars: number;
}

type Content = Record<string, unknown>;

const asRecord = (value: unknown): Content | null =>
  typeof value === 'object' && value !== null ? (value as Content) : null;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Unwrap the envelope types WhatsApp nests real content inside. */
function unwrap(message: unknown, depth = 0): Content | null {
  const m = asRecord(message);
  if (!m || depth > 5) return m;
  for (const key of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
    const inner = asRecord(m[key]);
    if (inner) return unwrap(inner['message'], depth + 1);
  }
  return m;
}

/** The text a human actually typed, or a rendering of what they sent instead. */
function extractText(m: Content | null): string {
  if (!m) return '';

  const direct = asString(m['conversation']);
  if (direct) return direct;

  for (const key of ['extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage']) {
    const node = asRecord(m[key]);
    const text = asString(node?.['text']) ?? asString(node?.['caption']);
    if (text) return text;
  }

  const buttons = asRecord(m['buttonsResponseMessage']);
  const selected = asString(buttons?.['selectedDisplayText']);
  if (selected) return selected;

  const list = asRecord(m['listResponseMessage']);
  const title = asString(list?.['title']);
  if (title) return title;

  return describe(m);
}

/**
 * Render message types that carry no text but were still sent by a person: a
 * location, a shared contact, a poll.
 *
 * Without this they parse as empty and are discarded before anything records
 * them, so someone could send their address and the system would hold no trace
 * of it arriving. Protocol traffic — receipts, edits, key distribution — is
 * deliberately left empty, because nobody sent it.
 */
function describe(m: Content): string {
  const location = asRecord(m['locationMessage']) ?? asRecord(m['liveLocationMessage']);
  if (location) {
    const label = m['liveLocationMessage'] ? 'live location' : 'location';
    const where = [asString(location['name']), asString(location['address'])].filter(Boolean).join(', ');
    return `[${label}]${where ? ` ${where}` : ''}`;
  }

  const contact = asRecord(m['contactMessage']);
  if (contact) return `[contact] ${asString(contact['displayName']) ?? 'shared a contact'}`;
  if (m['contactsArrayMessage']) return '[contacts] shared several contacts';

  for (const key of ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3']) {
    const poll = asRecord(m[key]);
    if (poll) return `[poll] ${asString(poll['name']) ?? 'poll'}`;
  }

  const reaction = asRecord(m['reactionMessage']);
  const emoji = asString(reaction?.['text']);
  if (emoji) return `[reacted ${emoji}]`;

  const event = asRecord(m['eventMessage']);
  const name = asString(event?.['name']);
  if (name) return `[event] ${name}`;

  return '';
}

const MEDIA_NODES: ReadonlyArray<readonly [string, MediaKind]> = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['audioMessage', 'audio'],
  ['stickerMessage', 'sticker'],
  ['documentMessage', 'document'],
];

const EXTENSION: Record<MediaKind, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'ogg',
  sticker: 'webp',
  document: 'bin',
};

function mediaNode(m: Content | null): { kind: MediaKind; node: Content } | null {
  if (!m) return null;
  for (const [key, kind] of MEDIA_NODES) {
    const node = asRecord(m[key]);
    if (node) return { kind, node };
  }
  return null;
}

/**
 * Download an attachment, subject to the size cap.
 *
 * The file name is composed entirely from values we control — timestamp,
 * message id, a fixed extension per kind — never from the sender's
 * `fileName`, which is arbitrary attacker text and would be a path traversal
 * if concatenated into a path. The original name is preserved as *data* on the
 * record so the agent can still refer to it.
 */
async function fetchMedia(
  message: WAMessage,
  socket: WASocket,
  found: { kind: MediaKind; node: Content },
  ctx: ParseContext,
  messageId: string,
  ts: number,
): Promise<InboundMedia> {
  const declared = Number(found.node['fileLength'] ?? 0);
  const base: Omit<InboundMedia, 'path' | 'error'> = {
    kind: found.kind,
    mimetype: asString(found.node['mimetype']),
    bytes: Number.isFinite(declared) && declared > 0 ? declared : null,
    fileName: asString(found.node['fileName']),
    seconds: typeof found.node['seconds'] === 'number' ? found.node['seconds'] : null,
    isVoiceNote: found.node['ptt'] === true,
  };

  // Checked before the download, so an oversized attachment costs a comparison
  // rather than the bandwidth and the disk.
  if (Number.isFinite(declared) && declared > ctx.maxMediaBytes) {
    return { ...base, path: null, error: `attachment is larger than the ${ctx.maxMediaBytes} byte limit` };
  }

  try {
    const buffer = await downloadMediaMessage(message, 'buffer', {}, {
      reuploadRequest: socket.updateMediaMessage,
      logger: undefined as never,
    });

    // The declared length is the sender's claim. Check what actually arrived.
    if (buffer.length > ctx.maxMediaBytes) {
      return { ...base, path: null, error: 'attachment exceeded the size limit once downloaded' };
    }

    const directory = join(ctx.mediaRoot, ctx.chatKey);
    mkdirSync(directory, { recursive: true });
    const safeId = messageId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'msg';
    const name = `${ts}-${safeId}.${EXTENSION[found.kind]}`;
    writeFileSync(join(directory, name), buffer, { mode: 0o600 });

    return { ...base, bytes: buffer.length, path: `media/${ctx.chatKey}/${name}`, error: null };
  } catch (err) {
    return { ...base, path: null, error: String((err as Error).message).slice(0, 200) };
  }
}

/**
 * Parse one Baileys message. Never throws: a message that cannot be understood
 * still produces an envelope, so it is recorded rather than lost.
 */
export async function toEnvelope(
  message: WAMessage,
  socket: WASocket,
  ctx: ParseContext,
): Promise<Envelope> {
  const chatJid = bare(message.key.remoteJid) ?? 'unknown@s.whatsapp.net';
  const group = isGroup(chatJid);
  const senderJid = bare(group ? (message.key.participant ?? message.participant) : message.key.remoteJid);
  // `senderPn` is present on the wire but absent from this Baileys version's
  // key type. It carries the phone-number identity for a sender WhatsApp
  // delivered as a bare @lid, which is the difference between an allowlist
  // entry matching and silently not matching — so it is read defensively
  // rather than dropped for want of a declaration.
  const senderPnRaw = (message.key as { senderPn?: unknown }).senderPn;
  const senderPn = typeof senderPnRaw === 'string' ? bare(senderPnRaw) : null;
  const content = unwrap(message.message);
  const ts = (Number(message.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
  const id = message.key.id ?? `${ts}`;

  // Truncated rather than refused. A long question is not an attack, and
  // silently dropping it would look like the bot ignoring someone.
  const raw = extractText(content).trim();
  const text = raw.length > ctx.maxInboundChars ? `${raw.slice(0, ctx.maxInboundChars)}\n[truncated]` : raw;

  const selfIds = identities(socket.user?.id, socket.user?.lid);
  let mentionsMe = false;
  let quoted: Envelope['quoted'] = null;

  const context = asRecord(asRecord(content?.['extendedTextMessage'])?.['contextInfo']);
  const mentioned = context?.['mentionedJid'];
  if (Array.isArray(mentioned)) {
    mentionsMe = mentioned.some((j) => {
      const b = bare(String(j));
      const u = userPart(String(j));
      return (b !== null && selfIds.includes(b)) || (u !== null && selfIds.includes(u));
    });
  }

  const quotedMessage = context?.['quotedMessage'];
  if (quotedMessage) {
    const participant = bare(asString(context?.['participant']));
    const isMine = participant !== null && selfIds.includes(participant);
    quoted = { text: extractText(unwrap(quotedMessage)).trim().slice(0, 2000), isMine };
    // A reply to us is consent to be addressed, exactly like an @mention.
    if (isMine) mentionsMe = true;
  }

  let groupName: string | null = null;
  if (group) {
    try {
      groupName = (await socket.groupMetadata(chatJid))?.subject ?? null;
    } catch {
      /* metadata is best-effort and not worth failing a message over */
    }
  }

  const media: InboundMedia[] = [];
  const found = mediaNode(content);
  if (found && ctx.maxMediaPerMessage > 0) {
    media.push(await fetchMedia(message, socket, found, ctx, id, ts));
  } else if (found) {
    log('envelope.mediaSkipped', { chatKey: ctx.chatKey, reason: 'attachments are disabled' });
  }

  return {
    id,
    ts,
    chatJid,
    isGroup: group,
    groupName,
    senderIds: identities(senderJid, senderPn),
    pushName: message.pushName ?? null,
    text,
    mentionsMe,
    quoted,
    media,
    isReaction: content?.['reactionMessage'] !== undefined,
    isPollVote: false,
  };
}

/** Is there anything here worth recording? */
export function hasContent(envelope: Envelope): boolean {
  return envelope.text.length > 0 || envelope.media.length > 0;
}

export { slug };
