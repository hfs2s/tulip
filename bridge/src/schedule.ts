/**
 * Messages promised for later — the store, and the thing that keeps the promise.
 *
 * Tulip had no scheduling of any kind. On 2026-09-06 somebody asked, in a real
 * group, for a reminder about a meetup on the 28th to be sent on the 26th at
 * nine in the morning. Nothing in the system could have fired it: no cron, no
 * timer, no store. The agent had no way to know that, so the likely outcome was
 * a promise made warmly and broken silently, discovered by nobody until the day
 * went past. This file is the mechanism that makes that promise keepable, and
 * — just as importantly — makes it *refusable* out loud when it is not.
 *
 * ## Shaped after `memory.ts`, for the same reasons
 *
 * The agent asks; the bridge owns the store; the operator can see it. What is
 * different, and stricter, is where the file lives. `memory.json` sits on the
 * inbound volume, which the agent mounts read-only. This one sits on `state/`,
 * which the agent has **no mount for at all** — see the comment on
 * `paths.schedule`. A scheduled send is a message that leaves with nobody
 * watching, so forging, editing and replaying one all have to be impossible
 * rather than merely refused.
 *
 * ## Four rules, each of which was a decision
 *
 *   1. **A scheduled send goes only to the chat that created it.** The action
 *      has no `chatKey` field, so this is not enforced here — it is
 *      unrepresentable in the vocabulary. See the `schedule` action's comment
 *      in shared/src/handoff.ts for why a delayed cross-chat send is a worse
 *      primitive than an immediate one.
 *   2. **A fire is an ordinary outbound message.** It spends the destination's
 *      hourly outbound allowance and lands in the feed via `feed.outbound`,
 *      exactly as `case 'text'` does. A message that reached somebody but is
 *      missing from the record is a message an operator cannot audit.
 *   3. **Firing never throws into the tick loop.** One entry with a broken
 *      destination must not stop the other nine, and an exception escaping a
 *      `setInterval` callback is an unhandled rejection at best.
 *   4. **Nothing is ever silently dropped.** Late inside the grace window it
 *      fires with a note saying so; outside it, the entry is marked `missed`
 *      and the feed says which chat and when. Silence is the one outcome that
 *      is always wrong, because it is indistinguishable from the bug this file
 *      exists to fix.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ScheduleSpec,
  formatLocal,
  formatLocalTime,
  nextOccurrence,
  writeJsonAtomic,
} from '@tulip/shared';
import type { ScheduleSpec as ScheduleSpecType } from '@tulip/shared';
import { feed } from './feed.js';
import { log } from './log.js';
import { paths } from './paths.js';
import type { ChatRegistry } from './chats.js';
import type { Config } from './config.js';
import type { Limiter } from './ratelimit.js';
import type { WhatsApp } from './whatsapp.js';

/**
 * What an entry is doing, in one word an operator can scan a column of.
 *
 *   active     — waiting for `nextAt`, or repeating
 *   done       — a one-off that fired, or a rule with nothing left to fire
 *   cancelled  — called off, by the agent or an operator
 *   missed     — came due while nothing was running, too long ago to send now
 *   failed     — we tried to send it and could not
 *
 * `missed` and `failed` are deliberately separate. One says the bridge was not
 * there; the other says it was there and the send did not work. Collapsing them
 * would lose exactly the distinction an operator needs to know whether to look
 * at the box or at the chat.
 */
export const ScheduleState = z.enum(['active', 'done', 'cancelled', 'missed', 'failed']);

export const ScheduleEntry = z
  .object({
    id: z.string().uuid(),
    /** Where it goes. Stamped from the turn, never read out of a request. */
    chatKey: z.string().regex(/^[0-9a-f]{16}$/),
    spec: ScheduleSpec,
    text: z.string().min(1).max(4096),
    /**
     * Who asked for it.
     *
     * Not decoration: `agent.schedule` stops agent-created entries from firing
     * and leaves an operator's alone, and the panel needs to say which is which
     * before somebody deletes the wrong one.
     */
    createdBy: z.enum(['agent', 'operator']),
    /**
     * Whose promise this is, by display name — distinct from `createdBy`, and
     * deliberately so.
     *
     * `createdBy` answers a machine's question: may this fire while agent
     * scheduling is switched off. This answers a person's: who is going to be
     * disappointed if it does not. They come apart exactly when an operator
     * sets a reminder somebody else asked for in a chat, which is the case that
     * prompted this field — the page said "you" about a promise made to Daniel.
     *
     * Defaulted rather than required, for the entries already on disk when this
     * shipped. Null is the honest reading of those: we know the chat, and we
     * did not record the person.
     */
    requestedBy: z.string().max(80).nullable().default(null),
    /**
     * The message that caused this, verbatim, and when it was sent.
     *
     * "Asked by Daniel S" is a claim; this is the evidence for it. Without the
     * sentence itself an operator cannot tell a reminder somebody requested
     * from one the agent decided to create, and telling those apart is the
     * whole reason this page exists.
     *
     * Captured by the bridge from its own feed, never accepted from the agent —
     * see `lastInbound`. Capped well below the inbound limit because this is a
     * quotation on a card, not a transcript.
     */
    sourceText: z.string().max(1000).nullable().default(null),
    sourceAt: z.string().datetime().nullable().default(null),
    createdAt: z.string().datetime(),
    /**
     * The zone this entry's times are *said* in.
     *
     * Fixed at creation rather than read from live config, so that changing the
     * deployment's zone next month does not silently re-describe a promise that
     * was already made to somebody in words. For a cron entry it is the spec's
     * own zone, which is also what the next occurrence is computed against; for
     * a one-off it is the zone the instant was resolved in, and is used only to
     * render it back.
     */
    timezone: z.string().min(1).max(64),
    nextAt: z.string().datetime().nullable(),
    lastFiredAt: z.string().datetime().nullable(),
    fireCount: z.number().int().nonnegative(),
    state: ScheduleState,
    /** Why it is in the state it is in, when that is not obvious. Shown to an operator. */
    note: z.string().max(300).nullable(),
  })
  .strict();

export type ScheduleEntry = z.infer<typeof ScheduleEntry>;
export type ScheduleState = z.infer<typeof ScheduleState>;

const ScheduleFile = z.object({ entries: z.array(ScheduleEntry).max(2000) }).strict();

/**
 * Finished entries kept for the panel before the oldest are pruned.
 *
 * They are the audit trail — "did the reminder go out, and when" — so they are
 * not discarded the moment they fire. They are also not kept forever: the file
 * is read whole on every tick.
 */
const KEEP_FINISHED = 200;

/** How late a fire has to be before the message says so. One tick is 30s. */
const LATE_NOTE_AFTER_MS = 120_000;

const isFinished = (entry: ScheduleEntry): boolean => entry.state !== 'active';

// ─── The store ───────────────────────────────────────────────────────────────

/**
 * Read the whole store.
 *
 * A file that does not parse yields an empty list *and says so in the log*,
 * exactly as `readMemory` does — but the consequence here is worse and worth
 * naming: an empty read means nothing fires. It cannot mean anything else,
 * because there is no second copy. So the failure is loud, and `writeSchedule`
 * below refuses to overwrite what it could not read, which is the rule
 * `lib/atomicFile.ts` in the sibling project exists to enforce: a failed read
 * must never be laundered into an empty result that the next write makes
 * permanent.
 */
export function readSchedule(): ScheduleEntry[] {
  try {
    if (!existsSync(paths.schedule)) return [];
    const parsed = ScheduleFile.safeParse(JSON.parse(readFileSync(paths.schedule, 'utf8')));
    if (!parsed.success) {
      log('schedule.invalid', {
        note: 'the schedule file did not parse; nothing will fire until it is fixed or removed',
        issues: parsed.error.issues.length,
      });
      return [];
    }
    return parsed.data.entries;
  } catch (err) {
    log('schedule.unreadable', { err: String((err as Error).message) });
    return [];
  }
}

/** Is the store readable at all? Separates "nothing scheduled" from "cannot tell". */
function storeIsReadable(): boolean {
  try {
    if (!existsSync(paths.schedule)) return true; // nothing written yet is a fine, empty store
    return ScheduleFile.safeParse(JSON.parse(readFileSync(paths.schedule, 'utf8'))).success;
  } catch {
    return false;
  }
}

/**
 * Persist, oldest finished entries first out of the door.
 *
 * Mode 0600 rather than the 0644 `memory.json` gets. Nothing reads this but the
 * bridge — the agent asks for a listing through an action, and the panel asks
 * over HTTP — so there is no reason for it to be world-readable inside the
 * container.
 */
export function writeSchedule(entries: readonly ScheduleEntry[]): boolean {
  const active = entries.filter((e) => !isFinished(e));
  const finished = entries.filter(isFinished).slice(-KEEP_FINISHED);
  try {
    writeJsonAtomic(paths.schedule, { entries: [...active, ...finished] }, 0o600);
    return true;
  } catch (err) {
    log('schedule.writeFailed', { err: String((err as Error).message) });
    return false;
  }
}

export function findSchedule(id: string): ScheduleEntry | null {
  return readSchedule().find((e) => e.id === id) ?? null;
}

/** This chat's entries, newest promise first. Nothing else's, ever. */
export function schedulesFor(chatKey: string): ScheduleEntry[] {
  return readSchedule()
    .filter((e) => e.chatKey === chatKey)
    .sort((a, b) => (a.nextAt ?? '').localeCompare(b.nextAt ?? '') || a.createdAt.localeCompare(b.createdAt));
}

// ─── Creating one ────────────────────────────────────────────────────────────

export interface CreateInput {
  readonly chatKey: string;
  readonly spec: ScheduleSpecType;
  readonly text: string;
  readonly createdBy: 'agent' | 'operator';
  /** Who asked for it, if a person did. See `ScheduleEntry.requestedBy`. */
  readonly requestedBy?: string | null;
  /** The request itself, verbatim, and when it was sent. */
  readonly sourceText?: string | null;
  readonly sourceAt?: string | null;
}

export type Created = { ok: true; entry: ScheduleEntry } | { ok: false; error: string };

/**
 * Add one, or say precisely why not.
 *
 * **Every refusal names the number it hit.** That is not politeness; it is the
 * whole design goal. The failure being fixed is a promise that quietly cannot
 * be kept, so a refusal has to arrive as words the agent can relay verbatim to
 * the person who asked — "I can hold ten reminders for this chat and I already
 * have ten" is something a person can act on, and a silent truncation to nine
 * is not. Nothing here degrades: it either schedules what was asked for or
 * schedules nothing.
 */
export function createSchedule(config: Config, input: CreateInput, now = Date.now()): Created {
  const text = input.text.trim();
  if (text.length === 0) return { ok: false, error: 'there is nothing to send — say what the reminder should say.' };

  const parsedSpec = ScheduleSpec.safeParse(input.spec);
  if (!parsedSpec.success) {
    return { ok: false, error: parsedSpec.error.issues[0]?.message ?? 'that is not a schedule I can read.' };
  }
  const spec = parsedSpec.data;
  const timezone = spec.kind === 'cron' ? spec.timezone : config.timezone;

  const next = nextOccurrence(spec, new Date(now));
  if (next === null) {
    return {
      ok: false,
      error:
        spec.kind === 'once'
          ? `that time has already passed — ${formatLocal(Date.parse(spec.at), timezone)} is in the past.`
          : `"${spec.expression}" never comes round. Check the day and month: 30 February parses fine and can never happen.`,
    };
  }

  const lead = next.getTime() - now;
  if (lead < config.limits.scheduleMinLeadMs) {
    const seconds = Math.round(config.limits.scheduleMinLeadMs / 1000);
    return {
      ok: false,
      error:
        `that is less than ${String(seconds)} seconds away, which is the least notice a reminder can be set with. ` +
        'Send the message now instead — a reminder that soon is just a message.',
    };
  }

  const horizonMs = config.limits.scheduleMaxHorizonDays * 86_400_000;
  if (lead > horizonMs) {
    return {
      ok: false,
      error:
        `that is further ahead than ${String(config.limits.scheduleMaxHorizonDays)} days, which is as far as ` +
        'reminders go. Nothing was scheduled — say so, and suggest they write it down somewhere that outlives me.',
    };
  }

  // Read once, so the two caps below and the write all see the same store.
  if (!storeIsReadable()) {
    return {
      ok: false,
      error: 'I could not read my own reminder list, so I have not added to it. Nothing was scheduled.',
    };
  }
  const entries = readSchedule();

  const mine = entries.filter((e) => !isFinished(e) && e.chatKey === input.chatKey).length;
  if (mine >= config.limits.scheduledPerChat) {
    return {
      ok: false,
      error:
        `I can hold ${String(config.limits.scheduledPerChat)} reminders for one conversation and this one ` +
        `already has ${String(mine)}. Cancel one first — nothing was scheduled.`,
    };
  }

  const total = entries.filter((e) => !isFinished(e)).length;
  if (total >= config.limits.scheduledTotal) {
    return {
      ok: false,
      error:
        `I am holding ${String(total)} reminders across every conversation, which is the limit of ` +
        `${String(config.limits.scheduledTotal)}. Nothing was scheduled — tell an operator.`,
    };
  }

  const entry: ScheduleEntry = {
    id: randomUUID(),
    chatKey: input.chatKey,
    spec,
    text,
    createdBy: input.createdBy,
    // Trimmed and emptied to null: a blank name renders as a sentence with a
    // hole in it, which is worse than not claiming to know who asked.
    requestedBy: (input.requestedBy ?? '').trim() || null,
    sourceText: ((input.sourceText ?? '').trim() || null)?.slice(0, 1000) ?? null,
    sourceAt: input.sourceAt ?? null,
    createdAt: new Date(now).toISOString(),
    timezone,
    nextAt: next.toISOString(),
    lastFiredAt: null,
    fireCount: 0,
    state: 'active',
    note: null,
  };

  if (!writeSchedule([...entries, entry])) {
    return { ok: false, error: 'the reminder could not be written, so nothing was scheduled.' };
  }

  log('schedule.created', {
    id: entry.id,
    chatKey: entry.chatKey,
    by: entry.createdBy,
    kind: spec.kind,
    nextAt: entry.nextAt,
    timezone,
  });
  return { ok: true, entry };
}

export type Cancelled = { ok: true; entry: ScheduleEntry } | { ok: false; error: string };

/**
 * Call one off.
 *
 * `chatKey` scopes it, and passing it is what makes the agent's version safe:
 * an id belonging to another conversation gets the same answer as an id that
 * never existed, so this cannot be used to enumerate or to interfere. The panel
 * passes nothing, because an operator is allowed to cancel anybody's.
 */
export function cancelSchedule(id: string, chatKey?: string): Cancelled {
  const entries = readSchedule();
  const entry = entries.find((e) => e.id === id && (chatKey === undefined || e.chatKey === chatKey));
  if (entry === undefined) return { ok: false, error: 'no reminder with that id.' };
  if (entry.state !== 'active') return { ok: false, error: `that reminder is already ${entry.state}.` };

  entry.state = 'cancelled';
  entry.nextAt = null;
  entry.note = 'cancelled';
  if (!writeSchedule(entries)) return { ok: false, error: 'the reminder list could not be written.' };

  log('schedule.cancelled', { id, chatKey: entry.chatKey });
  return { ok: true, entry };
}

// ─── The ticker ──────────────────────────────────────────────────────────────

export interface SchedulerDeps {
  readonly wa: WhatsApp;
  /** Live, so an operator switching `agent.schedule` off is felt on the next tick. */
  readonly config: Config;
  readonly chats: ChatRegistry;
  readonly limiter: Limiter;
}

/** How often the store is checked. Cron has minute resolution; this is finer. */
const TICK_MS = 30_000;

/** Don't repeat "scheduling is off" into the log every thirty seconds. */
const REFUSAL_LOG_EVERY_MS = 600_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastRefusalLoggedAt = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  start(): this {
    // `unref` like every other loop in the bridge: this must never be the
    // reason the process stays alive.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over the store.
   *
   * Re-entrancy is guarded rather than assumed: a send can take longer than a
   * tick, and two passes over the same due entry would send it twice.
   */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const entries = readSchedule();
      const due = entries.filter(
        (e) => e.state === 'active' && e.nextAt !== null && Date.parse(e.nextAt) <= now,
      );
      if (due.length === 0) return;

      let changed = false;
      for (const entry of due) {
        try {
          changed = (await this.fire(entry, now)) || changed;
        } catch (err) {
          // Rule 3. One entry cannot be allowed to stop the rest, and an
          // exception out of a timer callback is an unhandled rejection.
          entry.state = 'failed';
          entry.nextAt = null;
          entry.note = String((err as Error).message).slice(0, 300);
          changed = true;
          log('schedule.threw', { id: entry.id, err: entry.note });
          feed.event('schedule.failed', 'a reminder could not be sent — see the log');
        }
      }
      if (changed) writeSchedule(entries);
    } catch (err) {
      log('schedule.tickFailed', { err: String((err as Error).message) });
    } finally {
      this.ticking = false;
    }
  }

  /** Advance a repeating entry to its next occurrence, or finish a one-off. */
  private advance(entry: ScheduleEntry, from: number): void {
    if (entry.spec.kind === 'once') {
      entry.state = 'done';
      entry.nextAt = null;
      return;
    }
    const next = nextOccurrence(entry.spec, new Date(from));
    if (next === null) {
      entry.state = 'done';
      entry.nextAt = null;
      entry.note = 'nothing left to fire';
      return;
    }
    entry.nextAt = next.toISOString();
  }

  /**
   * Deal with one due entry. Returns whether the entry was modified.
   *
   * The order of the checks is the interesting part, and each one is a
   * different kind of "no":
   *
   *   - **switched off** — leave it exactly where it is. The operator has
   *     paused the agent's reminders, not deleted them, so nothing is written.
   *     If they come back inside the grace window it goes out late; if not it
   *     is marked missed, loudly, which is the honest record of what happened.
   *   - **too late to be useful** — mark it, say so, move on.
   *   - **no destination** — the chat was blocked or forgotten. Failed, not
   *     missed: we were here and chose not to send.
   *   - **throttled** — leave it due and try again next tick. The hourly
   *     allowance rolls, so this resolves itself; and if it does not resolve
   *     before the grace window closes, the entry becomes missed rather than
   *     retrying forever.
   */
  private async fire(entry: ScheduleEntry, now: number): Promise<boolean> {
    const dueAt = Date.parse(entry.nextAt ?? '');
    if (!Number.isFinite(dueAt)) {
      entry.state = 'failed';
      entry.nextAt = null;
      entry.note = 'its next time was unreadable';
      return true;
    }

    if (entry.createdBy === 'agent' && !this.deps.config.agent.schedule) {
      if (now - this.lastRefusalLoggedAt > REFUSAL_LOG_EVERY_MS) {
        this.lastRefusalLoggedAt = now;
        log('schedule.paused', {
          note: 'agent.schedule is off; due reminders are held, not sent',
          due: entry.id,
        });
        feed.event('schedule.paused', 'a reminder came due while scheduling is switched off');
      }
      return false;
    }

    const lateBy = now - dueAt;
    if (lateBy > this.deps.config.limits.scheduleGraceMs) {
      const minutes = Math.round(lateBy / 60_000);
      log('schedule.missed', { id: entry.id, chatKey: entry.chatKey, lateByMinutes: minutes });
      // Loud, like `memory.remembered`. A promise that was not kept is exactly
      // the thing an operator should scroll past even if they never open the
      // page — it is the failure this whole file was built to stop being silent.
      feed.event(
        'schedule.missed',
        `a reminder due ${formatLocal(dueAt, entry.timezone)} was ${String(minutes)} minutes late and was not sent`,
      );
      entry.note = `missed — it came due ${formatLocal(dueAt, entry.timezone)} and nothing was running`;
      if (entry.spec.kind === 'cron') {
        // A rule keeps its future even when one occurrence was lost.
        this.advance(entry, now);
      } else {
        entry.state = 'missed';
        entry.nextAt = null;
      }
      return true;
    }

    const jid = this.deps.chats.jidFor(entry.chatKey);
    if (jid === null || this.deps.chats.isBlocked(entry.chatKey)) {
      log('schedule.noDestination', { id: entry.id, chatKey: entry.chatKey, blocked: jid !== null });
      feed.event('schedule.failed', 'a reminder had nowhere to go — the chat is blocked or unknown');
      entry.state = 'failed';
      entry.nextAt = null;
      entry.note = jid === null ? 'that conversation is no longer known' : 'that conversation is blocked';
      return true;
    }

    const allowance = this.deps.limiter.admitOutbound(entry.chatKey, now);
    if (!allowance.ok) {
      log('schedule.throttled', { id: entry.id, chatKey: entry.chatKey, reason: allowance.reason });
      return false; // still due; the hour rolls and the next tick tries again
    }

    // Say it is late rather than pretending it is not. A 9am reminder that
    // turns up at 10:40 with no explanation reads as the bot being confused
    // about the time, which is worse than the delay itself.
    const text =
      lateBy > LATE_NOTE_AFTER_MS
        ? `(late — this was meant to reach you at ${formatLocalTime(dueAt, entry.timezone)}) ${entry.text}`
        : entry.text;

    await this.deps.wa.sendText(jid, text);
    // Rule 2: in the record like any other outbound message, under the same
    // kind, so nothing that reads the feed has to learn about scheduling to
    // account for a message that arrived.
    feed.outbound(entry.chatKey, 'text', text);

    entry.fireCount += 1;
    entry.lastFiredAt = new Date(now).toISOString();
    entry.note = null;
    this.advance(entry, now);

    log('schedule.fired', {
      id: entry.id,
      chatKey: entry.chatKey,
      lateByMs: lateBy,
      fireCount: entry.fireCount,
      nextAt: entry.nextAt,
    });
    return true;
  }
}
