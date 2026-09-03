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
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readFileSync as read, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { log } from './log.js';
import { paths } from './paths.js';

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

export type WhatsAppEvents = {
  ready: [{ id: string | undefined; name: string | undefined }];
  message: [WAMessage];
  qr: [string];
  fatal: [Error];
};

export class WhatsApp extends EventEmitter {
  private socket: WASocket | null = null;
  private attempt = 0;
  private generation = 0;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();

  connected = false;

  async start(): Promise<void> {
    acquireLock();
    await this.connect();
  }

  get me(): WASocket['user'] | null {
    return this.socket?.user ?? null;
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

        this.emit('message', message);
      }
    });
  }

  private require(): WASocket {
    if (!this.socket || !this.connected) throw new Error('whatsapp is not connected');
    return this.socket;
  }

  async sendText(chatJid: string, text: string): Promise<void> {
    await this.require().sendMessage(chatJid, { text });
  }

  async sendFile(chatJid: string, file: string, mimetype: string, caption: string | null): Promise<void> {
    const buffer = readFileSync(file);
    const socket = this.require();
    // Spread rather than `caption: caption ?? undefined`: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent key, and Baileys declares the property as optional-not-nullable.
    const withCaption = caption === null ? {} : { caption };
    if (mimetype.startsWith('image/')) {
      await socket.sendMessage(chatJid, { image: buffer, ...withCaption });
    } else if (mimetype.startsWith('video/')) {
      await socket.sendMessage(chatJid, { video: buffer, ...withCaption });
    } else if (mimetype.startsWith('audio/')) {
      await socket.sendMessage(chatJid, { audio: buffer, mimetype });
    } else {
      await socket.sendMessage(chatJid, {
        document: buffer,
        mimetype,
        fileName: file.split('/').pop() ?? 'file',
      });
    }
  }

  /**
   * Send an animated GIF.
   *
   * WhatsApp has no GIF type: an animated GIF is a short video with
   * `gifPlayback`, which is why Giphy's MP4 rendition is what gets fetched.
   * Sending the actual `.gif` bytes as an image produces a still frame.
   */
  async sendGif(chatJid: string, video: Buffer, caption: string | null): Promise<void> {
    await this.require().sendMessage(chatJid, {
      video,
      gifPlayback: true,
      ...(caption === null ? {} : { caption }),
    });
  }

  async react(chatJid: string, messageId: string, emoji: string, participant?: string): Promise<void> {
    await this.require().sendMessage(chatJid, {
      react: {
        text: emoji,
        key: { remoteJid: chatJid, id: messageId, fromMe: false, participant: participant ?? null },
      },
    });
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
