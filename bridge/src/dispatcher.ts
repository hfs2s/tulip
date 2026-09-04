/**
 * The dispatcher: what reaches the agent, in what order.
 *
 * Two properties that Iris does not need and a public deployment does:
 *
 *   - **Fair queueing.** Turns are serialised — one Claude Code session at a
 *     time on a small machine — so a first-in-first-out queue lets one heavy
 *     user starve everyone else, which on a public number is a denial of
 *     service anybody can perform by accident. Chats are served round-robin
 *     instead, so waiting time depends on how many *people* are ahead of you,
 *     not how many messages they sent.
 *   - **A turn timeout.** A wedged turn must not hold the queue shut. The agent
 *     reports when it finishes and that is used to advance early, but the timer
 *     is the authority: at `turnTimeoutMs` the turn is abandoned and the next
 *     chat is served regardless of what the status file claims.
 */
import { EventEmitter } from 'node:events';
import type { WAMessage } from 'baileys';
import { inPaths } from '@tulip/shared';
import type { InboundMessage } from '@tulip/shared';
import type { ChatRegistry } from './chats.js';
import type { Config } from './config.js';
import { feed } from './feed.js';
import { gate, isOperator } from './gate.js';
import { publishTurn, readStatus, retireBatch } from './handoff.js';
import { log, redactNumber } from './log.js';
import { hasContent, toEnvelope, type Envelope } from './envelope.js';
import type { Limiter } from './ratelimit.js';
import { Queue, type QueuedMessage } from './queue.js';
import { state } from './state.js';
import type { TurnRegistry } from './turns.js';
import type { WhatsApp } from './whatsapp.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait for the agent to acknowledge a turn before moving on. */
const TURN_START_TIMEOUT_MS = 30_000;
/** How often the pump re-checks a turn in flight. */
const POLL_MS = 1000;

export interface DispatcherDeps {
  readonly wa: WhatsApp;
  readonly chats: ChatRegistry;
  readonly limiter: Limiter;
  readonly turns: TurnRegistry;
  readonly config: Config;
  /** Injected so control commands can answer an operator directly. */
  readonly onControl: (envelope: Envelope, chatKey: string) => Promise<void>;
}

export class Dispatcher extends EventEmitter {
  private readonly queue = new Queue();
  private readonly pending = new Map<string, QueuedMessage[]>();
  private readonly debounces = new Map<string, NodeJS.Timeout>();
  /** Chats whose debounce has elapsed, in the order they became ready. */
  private readonly ready: string[] = [];
  private pumping = false;
  private inFlight: { turnId: string; chatKey: string; startedAt: number } | null = null;
  /**
   * When the current unanswered stretch began, or null if nobody is waiting.
   *
   * This is the watchdog's actual signal — see the header of `index.ts`. Not
   * queue depth, which is zero in precisely the failure that matters: messages
   * delivered perfectly into a session that fails every turn instantly. It is
   * set when work arrives to an idle dispatcher and cleared only when nothing
   * is outstanding at all, so a hold, a wedged turn and a silent agent all keep
   * the clock running.
   */
  private waitingSince: number | null = null;
  /**
   * The newest inbound message per chat, so a `react` action has something to
   * point at. Deliberately in memory only: a reaction to a message from before
   * the last restart is not worth persisting state for.
   */
  private readonly lastInbound = new Map<string, { id: string; participant?: string }>();

  constructor(private readonly deps: DispatcherDeps) {
    super();
    this.restore();
  }

  /**
   * Reload anything queued but not delivered when we last stopped.
   *
   * Without this a restart silently swallows whatever was waiting, including
   * messages deliberately held back by an operator.
   */
  private restore(): void {
    const byChat = this.queue.byChat();
    if (byChat.size === 0) return;
    let total = 0;
    for (const [chatKey, messages] of byChat) {
      this.pending.set(chatKey, messages);
      this.ready.push(chatKey);
      total += messages.length;
    }
    log('queue.restored', { messages: total, chats: byChat.size, held: state.isHeld() });
    setTimeout(() => void this.pump(), 2000);
  }

  /** Handle one raw WhatsApp message. Never throws into the socket. */
  async handle(message: WAMessage): Promise<void> {
    const now = Date.now();
    const { chats, config, limiter, wa } = this.deps;

    const chatJid = message.key.remoteJid ?? '';
    const isGroupChat = chatJid.endsWith('@g.us');
    const chatKey = chats.keyFor(chatJid.split(':')[0] ?? chatJid, isGroupChat, now);

    const envelope = await toEnvelope(message, wa as never, {
      chatKey,
      mediaRoot: inPaths.media,
      maxMediaBytes: config.limits.maxMediaBytes,
      maxMediaPerMessage: config.limits.maxMediaPerMessage,
      maxInboundChars: config.limits.maxInboundChars,
    });

    if (!hasContent(envelope)) {
      log('msg.empty', { chatKey, note: 'nothing a person sent — protocol traffic' });
      return;
    }

    const operator = isOperator(config, envelope.senderIds);
    const summary = {
      chatKey,
      chatName: envelope.isGroup ? envelope.groupName : envelope.pushName,
      isGroup: envelope.isGroup,
      from: envelope.pushName,
      text: envelope.text,
      media: envelope.media.map((m) => ({ kind: m.kind, bytes: m.bytes })),
    };

    // Operator control commands are handled before anything else and never
    // reach the agent.
    if (operator && envelope.text.trimStart().startsWith('!')) {
      feed.inbound({ ...summary, accepted: true, reason: 'operator command' });
      await this.deps.onControl(envelope, chatKey);
      return;
    }

    // The blocklist is checked before the gate, and before the limiter, so a
    // blocked sender costs as little as possible.
    if (chats.isBlocked(chatKey)) {
      feed.inbound({ ...summary, accepted: false, reason: 'blocked' });
      log('gate.deny', { chatKey, reason: 'blocked' });
      return;
    }

    const verdict = gate(envelope, config);
    if (!verdict.accept) {
      feed.inbound({ ...summary, accepted: false, reason: verdict.reason });
      log('gate.deny', {
        chatKey,
        // The identifiers the gate actually saw, so an operator adding someone
        // to an allowlist knows which value will match.
        ids: envelope.senderIds.map(redactNumber),
        reason: verdict.reason,
      });
      return; // silence — a refusal confirms the number is live
    }

    const allowance = limiter.admitMessage(chatKey, now);
    if (!allowance.ok) {
      feed.inbound({ ...summary, accepted: false, reason: allowance.reason });
      log('limit.deny', { chatKey, reason: allowance.reason, retryAfterMs: allowance.retryAfterMs });
      return; // also silent: telling someone the rate limit is a tuning signal
    }

    feed.inbound({ ...summary, accepted: true, reason: null });
    // The display name is supplied by the other end, so it never overwrites a
    // label an operator set by hand. That label is not decoration: it is the
    // only thing the agent is shown for a contact, and the contact list is what
    // authorises the agent to open a conversation at all. Letting a sender
    // rename themselves in the agent's view would let them dress as somebody
    // the operator vouched for.
    const existing = chats.get(chatKey);
    chats.touch(
      chatKey,
      {
        ...(existing?.contact === true
          ? {}
          : { name: envelope.isGroup ? envelope.groupName : envelope.pushName }),
        messages: (existing?.messages ?? 0) + 1,
      },
      now,
    );

    if (this.waitingSince === null) this.waitingSince = now;

    const queued: QueuedMessage = { chatKey, envelope };
    const list = this.pending.get(chatKey) ?? [];
    list.push(queued);
    this.pending.set(chatKey, list);
    this.queue.add(chatKey, envelope);

    this.lastInbound.set(
      chatKey,
      envelope.isGroup && envelope.senderIds[0] !== undefined
        ? { id: envelope.id, participant: envelope.senderIds[0] }
        : { id: envelope.id },
    );

    log('msg.queued', { chatKey, chars: envelope.text.length, waiting: list.length });
    void wa.readReceipt(envelope.chatJid, envelope.id, envelope.isGroup ? envelope.senderIds[0] : undefined);
    this.debounce(chatKey, config.delivery.debounceMs);
  }

  /** Hold a chat briefly so a burst of short messages becomes one prompt. */
  private debounce(chatKey: string, delayMs: number): void {
    clearTimeout(this.debounces.get(chatKey));
    this.debounces.set(
      chatKey,
      setTimeout(() => {
        this.debounces.delete(chatKey);
        if (!this.ready.includes(chatKey)) this.ready.push(chatKey);
        void this.pump();
      }, delayMs),
    );
  }

  /**
   * Deliver ready batches, one turn at a time, round-robin across chats.
   *
   * Re-entrant callers are ignored rather than queued: `pump` loops until there
   * is nothing ready, so a second call would only duplicate work.
   *
   * **The loop also runs while a turn is in flight, and that is the whole
   * point.** It used to be `while (this.ready.length > 0)`, which meant
   * `awaitTurnEnd` — reached only at the top of the loop — never ran after the
   * *last* batch was delivered. The common case is exactly that: one message,
   * one reply, nothing else queued. So the turn was never closed, and three
   * things silently did not happen.
   *
   *   - `turnEnd` never fired, so the typing indicator stayed on forever. From
   *     the outside Tulip looked permanently about to say something.
   *   - `retireBatch` never ran, so the batch stayed on the inbound volume and
   *     the agent was re-prompted with a message it had already answered. The
   *     agent noticed this itself and reported it: the same batch arrived three
   *     times and it went quiet rather than answer twice.
   *   - `turns.close` never ran, so the turn sat open until its TTL.
   *
   * Everything recovered on the *next* inbound message, which is why it looked
   * intermittent rather than total.
   */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.ready.length > 0 || this.inFlight !== null) {
        if (state.isHeld()) {
          log('msg.held', { waiting: this.queue.size });
          return;
        }
        if (!(await this.awaitTurnEnd())) return;

        // Round-robin: take the chat that has waited longest for a *turn*,
        // regardless of how many messages any chat has queued.
        const chatKey = this.ready.shift();
        if (chatKey === undefined) continue;

        const all = this.pending.get(chatKey) ?? [];
        if (all.length === 0) {
          this.pending.delete(chatKey);
          continue;
        }

        const batch = all.slice(0, this.deps.config.delivery.maxBatch);
        const rest = all.slice(batch.length);
        if (rest.length > 0) {
          // More than one batch's worth: keep the remainder and re-enter the
          // rotation at the back, behind everyone else waiting.
          this.pending.set(chatKey, rest);
          this.ready.push(chatKey);
        } else {
          this.pending.delete(chatKey);
        }

        try {
          await this.deliver(chatKey, batch);
        } catch (err) {
          log('dispatch.error', { chatKey, err: String((err as Error).message) });
          // Put them back so nothing is lost, and try again shortly.
          this.pending.set(chatKey, [...batch, ...(this.pending.get(chatKey) ?? [])]);
          if (!this.ready.includes(chatKey)) this.ready.push(chatKey);
          await sleep(5000);
          return;
        }
      }
    } finally {
      this.pumping = false;
      if (
        this.pending.size === 0 &&
        this.ready.length === 0 &&
        this.queue.size === 0 &&
        this.inFlight === null
      ) {
        this.waitingSince = null;
      }
    }
  }

  /**
   * Wait until no turn is in flight.
   *
   * The agent's status is consulted to finish early; the timeout is what
   * guarantees progress. Returns false if the caller should stop pumping for
   * now (the loop is re-entered by the next debounce or the watchdog).
   */
  private async awaitTurnEnd(): Promise<boolean> {
    while (this.inFlight !== null) {
      const { turnId, chatKey, startedAt } = this.inFlight;
      const elapsed = Date.now() - startedAt;

      const status = readStatus();
      if (status !== null && status.busyTurn !== turnId) {
        this.finishTurn('agent reported idle');
        return true;
      }
      if (elapsed > this.deps.config.limits.turnTimeoutMs) {
        log('turn.timeout', { chatKey, elapsedMs: elapsed, note: 'abandoned so the queue can advance' });
        feed.event('turn.timeout', `a turn ran past ${Math.round(elapsed / 60_000)} minutes and was abandoned`);
        this.finishTurn('timed out');
        return true;
      }
      await sleep(POLL_MS);
    }
    return true;
  }

  private finishTurn(why: string): void {
    if (!this.inFlight) return;
    const { turnId, chatKey } = this.inFlight;
    this.deps.turns.close(turnId, Date.now());
    retireBatch(turnId);
    this.inFlight = null;
    log('turn.end', { chatKey, why });
    this.emit('turnEnd', { chatKey, turnId });
  }

  /** Open a turn and publish it to the inbound volume. */
  private async deliver(chatKey: string, batch: readonly QueuedMessage[]): Promise<void> {
    const now = Date.now();
    const last = batch[batch.length - 1];
    if (!last) return;

    const record = this.deps.chats.get(chatKey);
    const turn = this.deps.turns.open(last.envelope.chatJid, chatKey, now);

    const messages: InboundMessage[] = batch.map(({ envelope }) => ({
      from: envelope.pushName ?? 'someone',
      at: new Date(envelope.ts).toISOString(),
      text: envelope.text,
      quoted: envelope.quoted,
      media: [...envelope.media],
    }));

    publishTurn({
      turnId: turn.turnId,
      chatKey,
      chatName: record?.name ?? (last.envelope.isGroup ? 'a group' : 'someone'),
      isGroup: last.envelope.isGroup,
      receivedAt: new Date(now).toISOString(),
      messages,
    });

    this.inFlight = { turnId: turn.turnId, chatKey, startedAt: now };
    this.deps.limiter.spendTurn(chatKey, now);
    this.queue.remove(batch);
    feed.delivered(chatKey, batch.length);
    log('turn.start', { chatKey, turnId: turn.turnId, messages: batch.length });
    this.emit('turnStart', { chatKey, turnId: turn.turnId });

    await this.awaitTurnStart(turn.turnId);
  }

  /**
   * Wait for the agent to acknowledge the turn.
   *
   * If it never does, carry on anyway. The agent may be restarting, and holding
   * every other chat hostage to one unacknowledged turn is worse than the
   * duplicate-delivery risk it avoids.
   */
  private async awaitTurnStart(turnId: string): Promise<void> {
    const deadline = Date.now() + TURN_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (readStatus()?.busyTurn === turnId) return;
      await sleep(500);
    }
    log('turn.noAck', { turnId, note: 'agent never acknowledged; continuing' });
  }

  /** The message a `react` action should attach to, if there is one. */
  lastMessageIn(chatKey: string): { id: string; participant?: string } | null {
    return this.lastInbound.get(chatKey) ?? null;
  }

  /** For the panel and the watchdog. */
  snapshot(): {
    pending: number;
    ready: number;
    queued: number;
    inFlight: string | null;
    waitingSince: number | null;
  } {
    let pending = 0;
    for (const list of this.pending.values()) pending += list.length;
    const outstanding =
      pending > 0 || this.ready.length > 0 || this.queue.size > 0 || this.inFlight !== null;
    return {
      pending,
      ready: this.ready.length,
      queued: this.queue.size,
      inFlight: this.inFlight?.chatKey ?? null,
      waitingSince: outstanding ? this.waitingSince : null,
    };
  }
}
