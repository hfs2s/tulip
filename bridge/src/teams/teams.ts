/**
 * The Microsoft Teams transport.
 *
 * Where WhatsApp is a socket the bridge dials, Teams is a service that dials
 * the bridge: Microsoft's Bot Connector posts every activity to an HTTPS
 * endpoint of ours and expects a `200` within about fifteen seconds. So this
 * transport is a small HTTP listener with one route, `POST /api/messages`,
 * and the whole of the bridge's inbound trust for this platform rests on what
 * that route checks before it emits anything:
 *
 *   1. the bearer token verifies — see `auth.ts` for the six requirements;
 *   2. the body parses as an activity — see `activity.ts`;
 *   3. the token's `serviceurl` claim names the activity's `serviceUrl`, and
 *      that URL is one the bridge would ever dial.
 *
 * Only then is the request answered `200`, and only then — after the
 * response, on the next tick — is the activity handed to the dispatcher, so
 * a slow turn can never make Microsoft time out and redeliver.
 *
 * **This listener is not the panel's.** The panel is fronted by Cloudflare
 * Access in production and the connector cannot sign in to that, so this one
 * is published separately (`TULIP_TEAMS_BIND:TULIP_TEAMS_PORT`) and is meant
 * to sit behind a tunnel route with no Access policy — the token is its
 * authentication. Nothing else is served on it: no `GET`, no status page, no
 * hint of what is behind the port.
 *
 * The capabilities Teams does not give a bot are simply absent from this
 * class rather than stubbed: no voice notes, no reactions, no file uploads
 * (v1), no read receipts, no leaving a room. The interface marks each optional
 * and the callers degrade in the open — see `transport.ts`.
 */
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { feed } from '../feed.js';
import type { TeamsEnv } from '../config.js';
import type { Envelope, ParseContext } from '../envelope.js';
import { AGENT_NAME } from '../instance.js';
import { acquireBridgeLock } from '../lock.js';
import { log } from '../log.js';
import type { Inbound, SentKey, Transport, TransportKind } from '../transport.js';
import { botWasAdded, isRoom, parseActivity, roomName, tenantOf, toEnvelope, validServiceUrl, type Activity } from './activity.js';
import { BotTokenVerifier, serviceUrlMatches, TokenSource } from './auth.js';
import { Connector, MAX_INLINE_IMAGE_BYTES, imageActivity, imageMimetype, textActivity, typingActivity } from './connector.js';
import { ConversationReferences } from './references.js';

/** Activities are small; anything near this is not one. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface TeamsDeps {
  readonly fetcher?: typeof fetch;
  readonly referencesFile?: string;
  readonly now?: () => number;
}

export class Teams extends EventEmitter implements Transport {
  readonly kind: TransportKind = 'teams';
  connected = false;

  private server: Server | null = null;
  private readonly botId: string;
  private botName: string | undefined;
  private readonly verifier: BotTokenVerifier;
  private readonly tokens: TokenSource;
  private readonly connector: Connector;
  private readonly references: ConversationReferences;
  private readonly seen = new Set<string>();

  constructor(
    private readonly env: TeamsEnv,
    deps: TeamsDeps = {},
  ) {
    super();
    const fetcher = deps.fetcher ?? fetch;
    const now = deps.now ?? Date.now;
    this.botId = `28:${env.appId}`;
    this.verifier = new BotTokenVerifier(env.appId, fetcher, now);
    this.tokens = new TokenSource({ appId: env.appId, appSecret: env.appSecret, tenantId: env.tenantId }, fetcher, now);
    this.connector = new Connector(this.tokens, fetcher);
    this.references = deps.referencesFile === undefined ? new ConversationReferences() : new ConversationReferences(deps.referencesFile);
  }

  get me(): { id: string; name: string | undefined } {
    return { id: this.botId, name: this.botName ?? AGENT_NAME };
  }

  /** A person on Teams is not a number; there is no chat to hand back. */
  directChatId(): null {
    return null;
  }

  async start(): Promise<void> {
    acquireBridgeLock(`the state volume and port ${this.env.port}`);
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        log('teams.requestFailed', { err: String((err as Error).message) });
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.env.port, this.env.bind, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.connected = true;
    log('teams.listening', { bind: this.env.bind, port: this.env.port, references: this.references.size });
    this.emit('ready', { id: this.botId, name: this.botName });
  }

  /** The bound address, for tests that start on port 0. */
  address(): { port: number } | null {
    const address = this.server?.address();
    return address !== null && typeof address === 'object' ? { port: address.port } : null;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.connected = false;
  }

  /**
   * The only route. Everything else is `404` with no body, including `GET` on
   * the route itself: a probe should learn nothing from this port.
   */
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = req.socket.remoteAddress ?? '';
    if (req.url !== '/api/messages') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }

    // Authentication before the body is read in full: a request that cannot
    // prove it is Microsoft's does not get a megabyte of our attention.
    const verdict = await this.verifier.verify(req.headers.authorization);
    if (!verdict.ok) {
      log('teams.rejected', { address, reason: verdict.reason });
      feed.event('teams.rejected', `a request to the Teams endpoint was refused: ${verdict.reason}`);
      res.writeHead(401).end();
      req.resume();
      return;
    }

    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) {
      res.writeHead(413).end();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8'));
    } catch {
      log('teams.badJson', { address });
      res.writeHead(400).end();
      return;
    }
    const activity = parseActivity(raw);
    if (activity === null) {
      res.writeHead(400).end();
      return;
    }

    // The token was minted for one service; the body must name the same one,
    // and that one must be an address the bridge will dial. Refused with the
    // same 401 as a bad token — it *is* a bad token for this body.
    const serviceUrl = validServiceUrl(activity.serviceUrl);
    if (serviceUrl === null || !serviceUrlMatches(verdict.serviceUrl, activity.serviceUrl)) {
      log('teams.rejected', { address, reason: serviceUrl === null ? 'service url refused' : 'service url does not match the token' });
      feed.event('teams.rejected', 'a request named a service url its token did not vouch for');
      res.writeHead(401).end();
      return;
    }

    // Answered now, before anything slow. Microsoft redelivers on a timeout,
    // and a redelivered message is a message answered twice.
    if (activity.type === 'invoke') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    } else {
      res.writeHead(200).end();
    }
    setImmediate(() => this.accept(activity, serviceUrl));
  }

  /** After the response: remember where this conversation lives, then hand it on. */
  private accept(activity: Activity, serviceUrl: string): void {
    if (activity.recipient?.name) this.botName = activity.recipient.name;
    const chatId = activity.conversation.id;
    this.references.remember(chatId, {
      serviceUrl,
      conversationId: chatId,
      tenantId: tenantOf(activity),
      botId: activity.recipient?.id ?? this.botId,
      lastActivityId: activity.id ?? null,
    });

    switch (activity.type) {
      case 'message':
      case 'messageReaction': {
        const id = activity.id;
        if (id !== undefined) {
          if (this.seen.has(id)) return; // a redelivery
          this.seen.add(id);
          if (this.seen.size > 4000) this.seen.clear();
        }
        const inbound: Inbound = {
          chatId,
          isGroup: isRoom(activity),
          altChatId: null,
          parse: (ctx: ParseContext): Promise<Envelope | null> =>
            toEnvelope(activity, ctx, {
              botId: activity.recipient?.id ?? this.botId,
              fetchAttachment: (url, withAuth, maxBytes) => this.connector.fetchAttachment(url, withAuth, maxBytes),
            }),
        };
        this.emit('message', inbound);
        return;
      }
      case 'conversationUpdate': {
        // Installed somewhere new. The reference is already kept; nothing is
        // said — a bot greeting a room of a hundred people is the spam
        // Microsoft's own guidance warns against, and the persona decides
        // what to say when somebody speaks to it.
        if (botWasAdded(activity, activity.recipient?.id ?? this.botId)) {
          const where = isRoom(activity) ? (roomName(activity) ?? 'a room') : 'a personal chat';
          log('teams.added', { chatKey: null, where });
          feed.event('teams.added', `${AGENT_NAME} was added to ${where}`);
        }
        return;
      }
      default:
        // `typing`, `installationUpdate`, `invoke` and whatever Microsoft adds
        // next: acknowledged above, not delivered. Design for unexpected
        // events, the docs say, and this is the whole of that design.
        return;
    }
  }

  private ref(chatId: string): NonNullable<ReturnType<ConversationReferences['get']>> {
    const ref = this.references.get(chatId);
    if (ref === null) throw new Error('no conversation reference for this chat — nobody has written from it yet');
    return ref;
  }

  async sendText(chatId: string, text: string): Promise<SentKey> {
    return this.connector.send(this.ref(chatId), textActivity(text));
  }

  /**
   * A picture, inlined. Over the cap it degrades to its caption and one honest
   * line rather than throwing: the outbox retries a thrown send, and a picture
   * that is too large is too large every time.
   */
  async sendImage(chatId: string, image: Buffer, caption: string | null): Promise<SentKey> {
    const ref = this.ref(chatId);
    if (image.length > MAX_INLINE_IMAGE_BYTES) {
      log('teams.imageTooLarge', { bytes: image.length, max: MAX_INLINE_IMAGE_BYTES });
      const text = `${caption === null ? '' : `${caption}\n\n`}(I made a picture, but it is too large to deliver here.)`;
      return this.connector.send(ref, textActivity(text));
    }
    return this.connector.send(ref, imageActivity(image, imageMimetype(image), caption));
  }

  /** Teams shows a typing indicator for a few seconds per activity; "off" needs nothing. */
  async typing(chatId: string, on: boolean): Promise<void> {
    if (!on) return;
    try {
      await this.connector.send(this.ref(chatId), typingActivity());
    } catch {
      /* presence is cosmetic and must never fail a turn */
    }
  }

  /** Teams gives a bot no read receipt to send. */
  async readReceipt(): Promise<void> {
    /* nothing to do */
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    await this.connector.update(this.ref(chatId), messageId, textActivity(text));
  }

  async unsend(chatId: string, messageId: string): Promise<void> {
    await this.connector.remove(this.ref(chatId), messageId);
  }
}

/** The body, or null once it passes the cap. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!done) resolve(null);
    });
  });
}
