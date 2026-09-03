/**
 * Abuse and cost control.
 *
 * Iris needs none of this: six friends cannot meaningfully abuse it, and a
 * limiter would only ever get in their way. A public number is different in
 * kind. Every turn is a model call somebody pays for, the queue is serial, and
 * the sender is anonymous and free to acquire another number — so the limits
 * here are the difference between a service and a way to spend someone else's
 * money.
 *
 * Three separate mechanisms, because they bound different things:
 *
 *   - a **token bucket** per sender, bounding rate while allowing the burst a
 *     real person produces when they send four short lines in a row;
 *   - a **daily turn budget** per sender, bounding cost, which a bucket does not
 *     — a bucket refills forever;
 *   - a **new-sender window** across all senders, bounding enumeration and bulk
 *     onboarding of throwaway numbers.
 *
 * State is persisted, so restarting the bridge is not a way to clear someone's
 * limits. It is keyed by `chatKey`, so nothing here writes down a phone number.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '@tulip/shared';
import { z } from 'zod';
import { log } from './log.js';

const SenderRecord = z
  .object({
    /** Token bucket level at `updatedAt`, in messages. Fractional between refills. */
    tokens: z.number(),
    updatedAt: z.number().int(),
    /** Turns spent today, against `limits.turnsPerDay`. */
    turnsToday: z.number().int().nonnegative(),
    /** UTC date the turn counter belongs to, so it resets without a scheduler. */
    day: z.string(),
    firstSeenAt: z.number().int(),
    messages: z.number().int().nonnegative(),
    /** Outbound sends in the current hour, against `outboundPerChatPerHour`. */
    sent: z.number().int().nonnegative().default(0),
    sentHour: z.string().default(''),
  })
  .strict();

const Persisted = z
  .object({
    senders: z.record(z.string(), SenderRecord).default({}),
    /** Timestamps of recent first-contacts, for the global new-sender window. */
    newSenders: z.array(z.number().int()).default([]),
  })
  .strict();

type SenderRecord = z.infer<typeof SenderRecord>;

export interface LimiterOptions {
  messagesPerHour: number;
  burst: number;
  turnsPerDay: number;
  newSendersPerHour: number;
  outboundPerChatPerHour: number;
}

export type Verdict = { ok: true } | { ok: false; reason: string; retryAfterMs: number };

const HOUR_MS = 3_600_000;

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
const utcHour = (now: number): string => new Date(now).toISOString().slice(0, 13);

/**
 * Durable, per-sender rate limiting.
 *
 * `now` is a parameter on every method rather than a call to `Date.now()`
 * inside, so the whole thing is deterministic under test. Time-dependent
 * security logic that can only be tested by sleeping does not get tested.
 */
export class Limiter {
  private senders = new Map<string, SenderRecord>();
  private newSenders: number[] = [];
  private dirty = false;

  constructor(
    private readonly options: LimiterOptions,
    private readonly file: string | null = null,
  ) {
    this.load();
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = Persisted.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!parsed.success) {
        // Refuse to half-load. A partially understood limiter state is worse
        // than a fresh one, because it looks like it is enforcing something.
        log('limiter.stateInvalid', { note: 'starting from empty', issues: parsed.error.issues.length });
        return;
      }
      this.senders = new Map(Object.entries(parsed.data.senders));
      this.newSenders = parsed.data.newSenders;
    } catch (err) {
      log('limiter.loadFailed', { err: String((err as Error).message) });
    }
  }

  /** Persist if anything changed. Cheap enough to call on a timer. */
  flush(): void {
    if (!this.dirty || !this.file) return;
    try {
      writeJsonAtomic(this.file, {
        senders: Object.fromEntries(this.senders),
        newSenders: this.newSenders,
      });
      this.dirty = false;
    } catch (err) {
      log('limiter.flushFailed', { err: String((err as Error).message) });
    }
  }

  private record(key: string, now: number): SenderRecord {
    const existing = this.senders.get(key);
    if (existing) return existing;

    const fresh: SenderRecord = {
      tokens: this.options.burst,
      updatedAt: now,
      turnsToday: 0,
      day: utcDay(now),
      firstSeenAt: now,
      messages: 0,
      sent: 0,
      sentHour: utcHour(now),
    };
    this.senders.set(key, fresh);
    this.newSenders.push(now);
    this.dirty = true;
    return fresh;
  }

  /** Have we seen this chat before this moment? */
  isKnown(key: string): boolean {
    return this.senders.has(key);
  }

  /**
   * Refill the bucket to `now`, capped at the burst size.
   *
   * Capping matters: without it an account dormant for a month accumulates a
   * month of tokens and can spend them all at once, which is precisely the
   * shape of the traffic the limiter exists to prevent.
   */
  private refill(record: SenderRecord, now: number): void {
    const elapsed = Math.max(0, now - record.updatedAt);
    const perMs = this.options.messagesPerHour / HOUR_MS;
    record.tokens = Math.min(this.options.burst, record.tokens + elapsed * perMs);
    record.updatedAt = now;

    if (record.day !== utcDay(now)) {
      record.day = utcDay(now);
      record.turnsToday = 0;
    }
    if (record.sentHour !== utcHour(now)) {
      record.sentHour = utcHour(now);
      record.sent = 0;
    }
  }

  /**
   * May this inbound message be accepted?
   *
   * Consumes a token when it says yes. The daily budget is checked but not
   * consumed here — it is spent per *turn*, in `spendTurn`, because a batch of
   * five messages costs one model call, and charging five would punish someone
   * for typing the way people type.
   */
  admitMessage(key: string, now: number): Verdict {
    // Checked *before* the record is created, so a sender refused by the window
    // is not thereby registered as known. Registering them would turn one
    // refusal into a permanent bypass: their next message would count as
    // familiar traffic and skip this check entirely.
    if (!this.senders.has(key)) {
      const cutoff = now - HOUR_MS;
      this.newSenders = this.newSenders.filter((t) => t > cutoff);
      if (this.newSenders.length >= this.options.newSendersPerHour) {
        this.dirty = true;
        return {
          ok: false,
          reason: 'too many first-time senders in the last hour',
          retryAfterMs: HOUR_MS,
        };
      }
    }

    const record = this.record(key, now);
    this.refill(record, now);
    this.dirty = true;

    if (record.turnsToday >= this.options.turnsPerDay) {
      const midnight = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate() + 1,
      );
      return { ok: false, reason: 'daily limit reached', retryAfterMs: midnight - now };
    }

    if (record.tokens < 1) {
      const perMs = this.options.messagesPerHour / HOUR_MS;
      return {
        ok: false,
        reason: 'sending too quickly',
        retryAfterMs: Math.ceil((1 - record.tokens) / perMs),
      };
    }

    record.tokens -= 1;
    record.messages += 1;
    return { ok: true };
  }

  /** Charge one turn against the daily budget, at delivery time. */
  spendTurn(key: string, now: number): void {
    const record = this.record(key, now);
    this.refill(record, now);
    record.turnsToday += 1;
    this.dirty = true;
  }

  /**
   * May the bridge send one more message to this chat this hour?
   *
   * This bounds the *agent*, not the user, and is the reason it exists: a
   * compromised or looping agent that queues a thousand replies is stopped here
   * rather than after WhatsApp bans the number.
   */
  admitOutbound(key: string, now: number): Verdict {
    const record = this.record(key, now);
    this.refill(record, now);
    this.dirty = true;

    if (record.sent >= this.options.outboundPerChatPerHour) {
      const nextHour = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;
      return { ok: false, reason: 'outbound hourly cap reached', retryAfterMs: nextHour - now };
    }
    record.sent += 1;
    return { ok: true };
  }

  /** For the control panel. */
  stats(key: string): SenderRecord | null {
    return this.senders.get(key) ?? null;
  }

  get size(): number {
    return this.senders.size;
  }
}
