/**
 * The WhatsApp socket.
 *
 * A thin wrapper over Baileys that emits normalised envelopes and exposes the
 * four sends Tulip supports. Everything Iris grew that a public assistant does
 * not need — polls, voice synthesis, image generation — is deliberately absent:
 * each was a paid capability reachable by anyone messaging the number, which is
 * a cost-denial-of-service with extra attack surface attached.
 *
 * The pidfile lock is load-bearing rather than hygiene. Two Baileys clients on
 * one auth store kick each other off in a loop and can log the device out,
 * forcing a QR re-scan from the phone. Containers make this *more* likely, not
 * less: `docker compose up -d` while an old container is still shutting down is
 * an ordinary thing to type.
 */
import { classifyLookupError, isParticipant, type Membership } from './membership.js';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readFileSync as read, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { senderPnOf, toEnvelope, type Envelope, type ParseContext } from './envelope.js';
import { log } from './log.js';
import { paths } from './paths.js';
import type { Inbound, SentKey, Transport, TransportKind } from './transport.js';

const LOCK_FILE = join(paths.root, 'bridge.lock');

/**
 * How far back a message may be and still be answered.
 *
 * Generous enough to pick up a backlog after downtime, short enough not to
 * reply to yesterday. WhatsApp flushes queued messages on reconnect, and
 * without this a container restart after a long outage would answer everything
 * at once.
 */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Baileys calls `logger.trace` on the key store; a bare object throws there. */
function silentLogger(): Record<string, unknown> {
  const noop = (): void => {};
  const logger: Record<string, unknown> = {
    level: 'silent',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  logger['child'] = () => logger;
  return logger;
}

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const pid = Number(read(LOCK_FILE, 'utf8').trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      throw new Error(
        `another bridge (pid ${pid}) holds ${paths.session}. Refusing to start: two Baileys ` +
          `clients on one auth store will log the device out and force a QR re-scan.`,
      );
    }
    log('lock.stale', { pid });
  }
  writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });

  const release = (): void => {
    try {
      if (readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_FILE);
    } catch {
      /* already released */
    }
  };
  process.on('exit', release);
}

/** The id of a message we just sent, when WhatsApp told us one. See `SentKey`. */
function keyOf(sent: { key?: { id?: string | null } | null } | undefined): SentKey {
  const id = sent?.key?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export type WhatsAppEvents = {
  ready: [{ id: string | undefined; name: string | undefined }];
  message: [Inbound];
  qr: [string];
  fatal: [Error];
};

/**
 * One raw Baileys message as the dispatcher's `Inbound` handle.
 *
 * The cheap half is read here, exactly as the dispatcher used to read it
 * before parsing: the chat is the `remoteJid` with any device suffix cut off,
 * a group is anything under `@g.us`, and the alternate id is the sender's
 * phone-number form when they arrived as a linked id. The expensive half —
 * `toEnvelope`, which downloads media and asks for group metadata — waits for
 * a chat key, and needs the live socket at that moment rather than the one
 * that existed when the message arrived. `socket` is therefore a getter: null
 * means "reconnecting", and the parse says so instead of guessing.
 *
 * Exported for the tests that drive the dispatcher with a hand-built message
 * and a stubbed socket; the class below is the only production caller.
 */
export function inboundOf(message: WAMessage, socket: () => WASocket | null): Inbound {
  const chatJid = message.key.remoteJid ?? '';
  return {
    chatId: chatJid.split(':')[0] ?? chatJid,
    isGroup: chatJid.endsWith('@g.us'),
    altChatId: senderPnOf(message),
    parse: async (ctx: ParseContext): Promise<Envelope | null> => {
      const live = socket();
      return live === null ? null : toEnvelope(message, live, ctx);
    },
  };
}

export class WhatsApp extends EventEmitter implements Transport {
  readonly kind: TransportKind = 'whatsapp';
  private socket: WASocket | null = null;
  private attempt = 0;
  private generation = 0;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();

  connected = false;

  /** A number's direct chat. WhatsApp is the platform where a person *is* a number. */
  directChatId(number: string): string {
    return `${number}@s.whatsapp.net`;
  }

  async start(): Promise<void> {
    acquireLock();
    await this.connect();
  }

  get me(): NonNullable<WASocket['user']> | null {
    return this.socket?.user ?? null;
  }

  /**
   * The live Baileys socket, or null while reconnecting.
   *
   * Exposed because parsing an inbound message genuinely needs it — group
   * metadata and media download are socket calls — and the alternative in place
   * until now was the dispatcher passing *this wrapper* with `as never`. That
   * cast silenced the only check that would have caught it, and three things
   * failed quietly for as long as it stood: `socket.user` was undefined so no
   * @-mention or reply ever matched, and `socket.groupMetadata` did not exist so
   * every group name resolved to null.
   *
   * Nullable on purpose. A caller must decide what to do without a socket
   * rather than be handed something shaped like one that answers nothing.
   */
  get live(): WASocket | null {
    return this.socket ?? null;
  }

  /**
   * Tear the current socket down before opening another.
   *
   * Leaving the old one alive means two clients on the same credentials, which
   * WhatsApp resolves by kicking one off with code 440 — which triggers another
   * reconnect, which opens another socket. That loop is how one missed cleanup
   * becomes a connection storm.
   */
  private closeCurrent(): void {
    const old = this.socket;
    this.socket = null;
    if (!old) return;
    try {
      old.ev.removeAllListeners as unknown as () => void;
      old.end?.(undefined);
    } catch {
      /* nothing to close */
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // never stack reconnects
    this.attempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    log('wa.reconnect', { attempt: this.attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err: unknown) => {
        log('wa.reconnectFailed', { err: String((err as Error).message) });
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.closeCurrent();
    const generation = ++this.generation;
    try {
      await this.open(generation);
    } finally {
      this.connecting = false;
    }
  }

  private async open(generation: number): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(paths.session);
    const { version } = await fetchLatestBaileysVersion();
    const logger = silentLogger();

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as never),
      },
      browser: Browsers.ubuntu('Tulip'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      logger: logger as never,
    });
    this.socket = socket;

    socket.ev.on('creds.update', () => void saveCreds());

    socket.ev.on('connection.update', (update) => {
      // Events from a socket we have already replaced must not drive reconnects.
      if (generation !== this.generation) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log('wa.qr', { note: 'not authenticated — scan to pair this number' });
        this.emit('qr', qr);
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.connected = true;
        this.attempt = 0;
        log('wa.open', { name: socket.user?.name ?? null });
        this.emit('ready', { id: socket.user?.id, name: socket.user?.name });
      }

      if (connection === 'close') {
        this.connected = false;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        log('wa.close', { code: code ?? null });

        if (code === DisconnectReason.loggedOut) {
          log('wa.loggedOut', { fatal: true, note: 'credentials revoked — the number must be re-paired' });
          this.emit('fatal', new Error('logged out'));
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          // Something else authenticated with these credentials. Reconnecting
          // immediately just trades kicks back and forth.
          this.attempt = Math.max(this.attempt, 4);
          log('wa.replaced', { note: 'another client authenticated with these credentials' });
        }
        this.scheduleReconnect();
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (generation !== this.generation) return;
      log('wa.upsert', { type, count: messages.length });

      for (const message of messages) {
        // 'notify' is live; 'append' is how WhatsApp flushes what queued while
        // we were offline. Dropping 'append' silently loses a restart's worth.
        if (type !== 'notify' && type !== 'append') continue;
        if (!message.message || message.key.fromMe) continue;

        const ageMs = Date.now() - Number(message.messageTimestamp ?? 0) * 1000;
        if (ageMs > MAX_AGE_MS) {
          log('wa.skip', { reason: 'older than the replay window', ageMin: Math.round(ageMs / 60_000) });
          continue;
        }

        const id = message.key.id;
        if (!id || this.seen.has(id)) continue;
        this.seen.add(id);
        if (this.seen.size > 4000) this.seen.clear();

        this.emit('message', inboundOf(message, () => this.socket));
      }
    });
  }

  private require(): WASocket {
    if (!this.socket || !this.connected) throw new Error('whatsapp is not connected');
    return this.socket;
  }

  /**
   * Send text, and keep the handle.
   *
   * The return value used to be awaited and dropped. That single discarded
   * value is why nothing Juan said could be edited or taken back: `WAMessage`
   * carries the `key` both operations need, and once it is gone WhatsApp offers
   * no way to ask "what was the id of the thing I just sent?". Null rather than
   * a throw when it is missing — the message did go out, it simply cannot be
   * corrected afterwards, and failing the send over that would be worse.
   */
  async sendText(chatJid: string, text: string): Promise<SentKey> {
    return keyOf(await this.require().sendMessage(chatJid, { text }));
  }

  /**
   * Replace the words of a message already delivered.
   *
   * WhatsApp allows this for about a quarter of an hour after sending and
   * refuses it after that, which is a server-side rule we cannot soften. The
   * recipient sees the new text marked as edited; they are not told what it
   * said before, so the feed keeps that instead.
   */
  async editText(chatJid: string, messageId: string, text: string): Promise<void> {
    await this.require().sendMessage(chatJid, {
      text,
      edit: { remoteJid: chatJid, id: messageId, fromMe: true },
    });
  }

  /**
   * Retract a message for everyone.
   *
   * `fromMe: true` is doing real work: it scopes the deletion to messages this
   * account sent. Deleting somebody *else's* message is a separate, admin-only
   * power in groups, and nothing here should be able to reach for it.
   */
  async unsend(chatJid: string, messageId: string): Promise<void> {
    await this.require().sendMessage(chatJid, {
      delete: { remoteJid: chatJid, id: messageId, fromMe: true },
    });
  }

  /**
   * Send a file the agent staged.
   *
   * Takes the bytes, not a path, and that is a security property rather than a
   * style preference: `resolveOutboundFile` validates one open descriptor, and
   * reopening the name here would have reintroduced exactly the race those
   * checks exist to close. `name` is for the WhatsApp filename only and is
   * never touched as a path.
   */
  async sendFile(
    chatJid: string,
    buffer: Buffer,
    mimetype: string,
    name: string,
    caption: string | null,
  ): Promise<SentKey> {
    const socket = this.require();
    // Spread rather than `caption: caption ?? undefined`: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent key, and Baileys declares the property as optional-not-nullable.
    const withCaption = caption === null ? {} : { caption };
    if (mimetype.startsWith('image/')) {
      return keyOf(await socket.sendMessage(chatJid, { image: buffer, ...withCaption }));
    }
    if (mimetype.startsWith('video/')) {
      return keyOf(await socket.sendMessage(chatJid, { video: buffer, ...withCaption }));
    }
    if (mimetype.startsWith('audio/')) {
      return keyOf(await socket.sendMessage(chatJid, { audio: buffer, mimetype }));
    }
    return keyOf(
      await socket.sendMessage(chatJid, {
        document: buffer,
        mimetype,
        fileName: basename(name) || 'file',
      }),
    );
  }

  /** Send a generated image. Buffer rather than a path: nothing touches disk. */
  async sendImage(chatJid: string, image: Buffer, caption: string | null): Promise<SentKey> {
    return keyOf(
      await this.require().sendMessage(chatJid, {
        image,
        ...(caption === null ? {} : { caption }),
      }),
    );
  }

  /**
   * Send a voice note.
   *
   * `ptt: true` is what makes WhatsApp render it as a held-to-record voice
   * message rather than an audio file attachment.
   */
  async sendVoice(chatJid: string, audio: Buffer): Promise<SentKey> {
    return keyOf(
      await this.require().sendMessage(chatJid, {
        audio,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      }),
    );
  }

  async react(chatJid: string, messageId: string, emoji: string, participant?: string): Promise<void> {
    await this.require().sendMessage(chatJid, {
      react: {
        text: emoji,
        key: { remoteJid: chatJid, id: messageId, fromMe: false, participant: participant ?? null },
      },
    });
  }

  /**
   * Leave a group.
   *
   * Refuses anything that is not a group jid before asking WhatsApp — a second
   * lock behind the outbox's check on the chat record, because `groupLeave` on
   * a person's jid is not something this should ever be able to try. Throws on
   * failure, like every send here, so the caller can say it did not leave
   * rather than claim it did.
   */
  /**
   * WhatsApp's own answer to "is he in this group?", for the panel. Reads only.
   * A live query rather than anything cached, since the point is to find out.
   */
  async groupMembership(groupJid: string): Promise<{ state: Membership; members: number | null; detail: string | null }> {
    if (!groupJid.endsWith('@g.us')) return { state: 'unknown', members: null, detail: 'not a group' };
    const socket = this.require();
    const me = [socket.user?.id, (socket.user as { lid?: string } | undefined)?.lid];
    try {
      const meta = await socket.groupMetadata(groupJid);
      const participants = (meta.participants ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;
      if (me.every((m) => !m)) return { state: 'unknown', members: participants.length, detail: 'own identity unknown' };
      return { state: isParticipant(participants, me) ? 'member' : 'not-member', members: participants.length, detail: null };
    } catch (err) {
      return { state: classifyLookupError(err), members: null, detail: String((err as Error).message).slice(0, 120) };
    }
  }

  /** Whether he is still in a group. False on any refusal, which is what a non-member gets. */
  async isInGroup(groupJid: string): Promise<boolean> {
    try {
      await this.require().groupMetadata(groupJid);
      return true;
    } catch {
      return false;
    }
  }

  async leaveGroup(groupJid: string): Promise<void> {
    if (!groupJid.endsWith('@g.us')) throw new Error('not a group');
    await this.require().groupLeave(groupJid);
  }

  async typing(chatJid: string, on: boolean): Promise<void> {
    try {
      const socket = this.require();
      await socket.presenceSubscribe(chatJid);
      await socket.sendPresenceUpdate(on ? 'composing' : 'paused', chatJid);
    } catch {
      /* presence is cosmetic and must never fail a turn */
    }
  }

  async readReceipt(chatJid: string, id: string, participant?: string): Promise<void> {
    try {
      await this.require().readMessages([{ remoteJid: chatJid, id, participant: participant ?? null }]);
    } catch {
      /* best effort */
    }
  }
}
