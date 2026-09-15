/**
 * What the bridge needs from a messaging platform, and nothing more.
 *
 * Tulip was written against WhatsApp and for a long time `WhatsApp` was the
 * type every consumer named — the dispatcher, the outbox, the scheduler, the
 * panel. Adding a second platform meant finding out which of the class's
 * fourteen methods those consumers actually call, and the answer was
 * uncomfortably close to "all of them". This file is that answer written down:
 * the contract is derived from the call sites, not designed from the outside,
 * so that WhatsApp implements it by construction and its behaviour does not
 * change by one byte.
 *
 * Two shapes of thing are on the contract:
 *
 *   - **Required**, because every consumer relies on it: sending text and a
 *     picture, typing, a read receipt (which may be a no-op), connection state,
 *     and the inbound event.
 *   - **Optional**, because a platform may genuinely lack it: voice notes as
 *     push-to-talk audio, reactions, editing and retracting, files, group
 *     membership. A caller that finds one absent degrades — a voice note goes
 *     out as its own script, a reaction is logged and skipped — and says so in
 *     the log. Nothing here fakes a capability, which is the alternative the
 *     rest of the codebase rejects everywhere else: a silently dropped send is
 *     indistinguishable from one that never happened.
 *
 * The inbound side is a handle rather than a parsed message, and that is the
 * one non-obvious decision. Parsing a WhatsApp message needs the chat key —
 * attachments are filed under it — and deriving the chat key needs two things
 * from the raw message before any parsing has happened. The handle carries
 * that cheap half up front and parses on request, which is exactly the split
 * `senderPnOf` and `toEnvelope` already make; the transport just owns it now.
 */
import type { EventEmitter } from 'node:events';
import type { Envelope, ParseContext } from './envelope.js';

export type TransportKind = 'whatsapp' | 'teams';

/**
 * The id of a message we just sent, when the platform told us one.
 *
 * Null is a real and ordinary answer, not an error case to assert away: a send
 * can succeed while the acknowledgement carrying the key is absent. Callers
 * treat null as "delivered, not correctable".
 */
export type SentKey = string | null;

/** One inbound message, not yet parsed. */
export interface Inbound {
  /**
   * The platform's own identifier for the chat, in the form the registry keys
   * on. For WhatsApp that is the jid without a device suffix; for Teams the
   * conversation id, thread included. Opaque to everything but the transport.
   */
  readonly chatId: string;
  readonly isGroup: boolean;
  /**
   * A second identifier for the same direct chat, when the platform has one.
   * WhatsApp's phone-number form of a sender it delivered under a linked id;
   * null everywhere else. See `ChatRegistry.keyFor`.
   */
  readonly altChatId: string | null;
  /**
   * Turn the raw message into an envelope. Null when the transport cannot do
   * it right now — WhatsApp mid-reconnect has no socket to download with —
   * and the caller records that rather than guessing.
   */
  parse(ctx: ParseContext): Promise<Envelope | null>;
}

export interface Transport extends EventEmitter {
  readonly kind: TransportKind;
  readonly connected: boolean;
  /** Our own identity on the platform, once known. Display only. */
  readonly me: { readonly id?: string | undefined; readonly name?: string | undefined } | null;

  start(): Promise<void>;

  // Three events, typed. `EventEmitter.on` satisfies these by itself, so an
  // implementation adds nothing; a transport with extra events of its own —
  // WhatsApp's `qr` — keeps them on the class, behind an `instanceof`.
  on(event: 'message', listener: (inbound: Inbound) => void): this;
  on(event: 'ready', listener: (me: { id: string | undefined; name: string | undefined }) => void): this;
  on(event: 'fatal', listener: (err: Error) => void): this;

  /**
   * The chat id a bare phone number reaches, or null when the platform has no
   * such notion. The watchdog alerts operators by number; a transport that
   * returns null here has no way to, and the caller says so once.
   */
  directChatId(number: string): string | null;

  sendText(chatId: string, text: string): Promise<SentKey>;
  /** Buffer rather than a path: nothing touches disk. */
  sendImage(chatId: string, image: Buffer, caption: string | null): Promise<SentKey>;
  /** Cosmetic; must never throw into a turn. */
  typing(chatId: string, on: boolean): Promise<void>;
  /** Best effort; a no-op on a platform without read receipts. */
  readReceipt(chatId: string, id: string, participant?: string): Promise<void>;

  // ── Optional capabilities ──────────────────────────────────────────────
  // Absent means the platform cannot, not that it is switched off. Callers
  // test for the method and degrade in the open.

  /** Bytes, not a path; see `resolveOutboundFile` for why. */
  sendFile?(chatId: string, buffer: Buffer, mimetype: string, name: string, caption: string | null): Promise<SentKey>;
  /** OGG/Opus, rendered as a held-to-record voice note. */
  sendVoice?(chatId: string, audio: Buffer): Promise<SentKey>;
  react?(chatId: string, messageId: string, emoji: string, participant?: string): Promise<void>;
  editText?(chatId: string, messageId: string, text: string): Promise<void>;
  unsend?(chatId: string, messageId: string): Promise<void>;
  groupMembership?(groupId: string): Promise<{ state: 'member' | 'not-member' | 'unknown'; members: number | null; detail: string | null }>;
  isInGroup?(groupId: string): Promise<boolean>;
  leaveGroup?(groupId: string): Promise<void>;
}

/** What a platform is called in the panel, the log and `!status`. */
export function transportLabel(kind: TransportKind): string {
  return kind === 'teams' ? 'Teams' : 'WhatsApp';
}
