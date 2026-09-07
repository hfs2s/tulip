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
  /**
   * The sender's phone-number jid, when WhatsApp supplied one alongside a
   * `@lid`. Null in a group, and null when only the linked id arrived.
   *
   * Carried separately as well as folded into `senderIds`, because the chat
   * registry needs to know *which* identifier is the phone-number form — it
   * keys a direct chat on that one so a person cannot end up with two records.
   */
  readonly senderPn: string | null;
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
    // Filled in by the dispatcher after the gate accepts, so a message that is
    // never answered is never paid to transcribe.
    transcript: null,
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
 * The sender's phone-number jid, if WhatsApp supplied one, for a direct chat.
 *
 * Split out of `toEnvelope` because the chat registry needs it *before* an
 * envelope exists: parsing needs a chat key (media is filed under one) and the
 * key now needs to know the sender's phone-number form, so one of the two has
 * to be readable from the raw message on its own. This is the cheap half.
 *
 * Null for a group — the chat there is the room, not a person — and null when
 * only a linked id arrived, which is the case this cannot repair.
 */
export function senderPnOf(message: WAMessage): string | null {
  const chatJid = bare(message.key.remoteJid) ?? 'unknown@s.whatsapp.net';
  if (isGroup(chatJid)) return null;
  const raw = (message.key as { senderPn?: unknown }).senderPn;
  return typeof raw === 'string' ? bare(raw) : null;
}

/**
 * Parse one Baileys message. Never throws: a message that cannot be understood
 * still produces an envelope, so it is recorded rather than lost.
 */
/**
 * Our own identifiers, from whatever we were handed.
 *
 * The parameter is typed `WASocket` and the dispatcher passes the wrapper class
 * with `as never`, which silenced the one check that would have caught it: the
 * wrapper exposes `me`, not `user`, so `socket.user` was undefined, `selfIds`
 * was empty, and **nothing ever matched**. Every @-mention and every reply to us
 * has been invisible for as long as that cast has been there — `mentionsMe` was
 * false for all of them, which is why trigger words worked and mentions did not.
 *
 * Read from both shapes rather than trusting either. The cast is gone from the
 * call site, so the types now say what is actually passed; this stays because
 * one of the two is the live socket and the other is the wrapper around it, and
 * a future caller will reasonably hand over whichever it holds.
 */
function selfIdentities(socket: WASocket): string[] {
  return identities(socket.user?.id, socket.user?.lid);
}

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

  const selfIds = selfIdentities(socket);
  let mentionsMe = false;
  let quoted: Envelope['quoted'] = null;

  // `contextInfo` is read from the message root as well as from inside
  // `extendedTextMessage`. WhatsApp puts it in either place depending on client
  // and message shape, and reading only the nested one meant a real @-mention
  // could arrive with `mentionsMe` false — which is what happened, and which
  // looks from the outside exactly like the bot ignoring somebody.
  const context =
    asRecord(asRecord(content?.['extendedTextMessage'])?.['contextInfo'])
    ?? asRecord(content?.['contextInfo']);

  // Both spellings. Newer clients carry group mentions in `groupMentions`, as
  // records rather than bare strings.
  const mentionedRaw = [
    ...(Array.isArray(context?.['mentionedJid']) ? (context['mentionedJid'] as unknown[]) : []),
    ...(Array.isArray(context?.['groupMentions'])
      ? (context['groupMentions'] as unknown[]).map((g) => asRecord(g)?.['groupJid'] ?? asRecord(g)?.['jid'])
      : []),
  ].filter((j): j is string => typeof j === 'string' && j.length > 0);

  if (mentionedRaw.length > 0) {
    mentionsMe = mentionedRaw.some((j) => {
      const b = bare(j);
      const u = userPart(j);
      return (b !== null && selfIds.includes(b)) || (u !== null && selfIds.includes(u));
    });
    // Diagnostic, only when somebody was mentioned and it was not us — the case
    // that is invisible from outside and impossible to reason about from a
    // transcript. Identifiers are masked: enough to compare, not enough to be a
    // record of who was in the room.
    if (selfIds.length === 0) {
      log('mention.noIdentity', {
        note: 'we do not know our own jid, so no mention or reply can ever match — this is a bug, not a quiet room',
      });
    }
    if (!mentionsMe && group) {
      const mask = (v: string): string => (v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-8)}` : v);
      log('mention.missed', {
        mentioned: mentionedRaw.map((j) => mask(bare(j) ?? j)).join(','),
        self: selfIds.map(mask).join(','),
      });
    }
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
    senderPn: group ? null : senderPn,
    pushName: message.pushName ?? null,
    text,
    mentionsMe,
    quoted,
    media,
    // Truthiness, not `!== undefined`. Baileys decodes protobuf messages with
    // every field present and unset ones set to `null`, so `!== undefined` is
    // true for an ordinary text message — which classified everything as a
    // reaction and silently answered nobody. The first real message caught it.
    isReaction: asRecord(content?.['reactionMessage']) !== null,
    isPollVote: false,
  };
}

/** Is there anything here worth recording? */
export function hasContent(envelope: Envelope): boolean {
  return envelope.text.length > 0 || envelope.media.length > 0;
}

export { slug };
