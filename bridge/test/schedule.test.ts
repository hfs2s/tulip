/**
 * Keeping a promise, and — more importantly — never pretending to.
 *
 * The bug this exists to prevent is not "the reminder fired at the wrong time".
 * It is the shape of failure Tulip keeps rediscovering: something that cannot
 * happen looks, from where the agent stands, exactly like something that did.
 * An action is written, the file disappears, and the agent reports success. So
 * the properties tested here are mostly about *saying no loudly*:
 *
 *   - a cap refuses and names the number, rather than truncating;
 *   - a reminder that came due while the bridge was down is either delivered
 *     late with a note, or recorded as `missed` in the feed — never dropped;
 *   - a fire is an ordinary outbound message: it spends the destination chat's
 *     hourly allowance and appears in the record like anything else;
 *   - one broken entry cannot stop the others, and cannot throw out of the tick.
 *
 * Written with real registries and a fake WhatsApp, in the style of
 * `outbox-destinations.test.ts` — the question worth asking of a scheduler is
 * "which jid actually received bytes", and a test that only checked the store
 * would pass through every bug worth having.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MADRID = 'Europe/Madrid';
const PHONE = '15551234567@s.whatsapp.net';
const OTHER = '15559876543@s.whatsapp.net';

let roots: string[] = [];
let sent: Array<{ jid: string; text: string }> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  sent = [];
});

interface Harness {
  createSchedule: typeof import('../src/schedule.js').createSchedule;
  cancelSchedule: typeof import('../src/schedule.js').cancelSchedule;
  readSchedule: typeof import('../src/schedule.js').readSchedule;
  schedulesFor: typeof import('../src/schedule.js').schedulesFor;
  scheduler: import('../src/schedule.js').Scheduler;
  config: import('../src/config.js').Config;
  chats: {
    keyFor: (jid: string, isGroup: boolean, now: number) => string;
    setBlocked: (key: string, blocked: boolean) => boolean;
    touch: (key: string, patch: { name?: string }, now: number) => void;
  };
  scheduleView: (deps: never) => { items: Array<Record<string, unknown>> };
  /** Feed rows written during the test, so a claim about the record is checkable. */
  feedRows: () => Array<{ kind: string; event?: string; chatKey?: string; text?: string | null }>;
  scheduleFile: string;
}

async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'tulip-sched-'));
  roots.push(root);
  mkdirSync(join(root, 'in'), { recursive: true });
  mkdirSync(join(root, 'out'), { recursive: true });
  vi.stubEnv('TULIP_STATE_DIR', root);
  vi.stubEnv('TULIP_IN_DIR', join(root, 'in'));
  vi.stubEnv('TULIP_OUT_DIR', join(root, 'out'));

  vi.resetModules();
  const scheduleModule = await import('../src/schedule.js');
  const { ChatRegistry } = await import('../src/chats.js');
  const { Limiter } = await import('../src/ratelimit.js');
  const { parseConfig } = await import('../src/config.js');
  const { paths } = await import('../src/paths.js');
  const { scheduleView } = await import('../src/panel-api.js');

  const config = parseConfig({ timezone: MADRID, ...overrides });
  const chats = new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
  const limiter = new Limiter({
    messagesPerHour: 1000,
    burst: 50,
    turnsPerDay: 1000,
    newSendersPerHour: 1000,
    outboundPerChatPerHour: config.limits.outboundPerChatPerHour,
  });

  const wa = {
    sendText: async (jid: string, text: string) => {
      sent.push({ jid, text });
    },
  };

  return {
    createSchedule: scheduleModule.createSchedule,
    cancelSchedule: scheduleModule.cancelSchedule,
    readSchedule: scheduleModule.readSchedule,
    schedulesFor: scheduleModule.schedulesFor,
    scheduleView,
    scheduler: new scheduleModule.Scheduler({ wa: wa as never, config, chats, limiter }),
    config,
    chats: chats as never,
    scheduleFile: paths.schedule,
    feedRows: () => {
      try {
        return readFileSync(paths.feed, 'utf8')
          .trimEnd()
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as { kind: string; event?: string });
      } catch {
        return [];
      }
    },
  };
}

/** A fixed Friday midday in Madrid, so every expectation can be read by hand. */
const NOW = Date.parse('2026-09-25T10:00:00.000Z');
const tomorrowAt9 = { kind: 'once' as const, at: '2026-09-26T07:00:00.000Z' };

// ─── Creating ────────────────────────────────────────────────────────────────

describe('setting one', () => {
  it('stores it against the chat that asked, with the resolved instant', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, {
      chatKey: key,
      spec: tomorrowAt9,
      text: 'the meetup is on the 28th',
      createdBy: 'agent',
    }, NOW);

    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.entry.chatKey).toBe(key);
    expect(made.entry.nextAt).toBe('2026-09-26T07:00:00.000Z');
    expect(made.entry.state).toBe('active');
    expect(made.entry.fireCount).toBe(0);
  });

  it('writes it where the agent has no mount at all', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);
    // `state/`, not the inbound volume `memory.json` sits on and not the
    // outbound one the agent writes actions to. A scheduled send leaves with
    // nobody watching, so forging, editing or replaying one has to be
    // impossible rather than merely refused — and impossible here means the
    // agent's container has no mount for the file at all.
    expect(h.scheduleFile).toBe(join(roots[roots.length - 1] as string, 'schedule.json'));
    expect(h.scheduleFile).not.toContain(`${sep}in${sep}`);
    expect(h.scheduleFile).not.toContain(`${sep}out${sep}`);
    expect(readFileSync(h.scheduleFile, 'utf8')).toContain('x');
  });

  it('takes the zone from a cron spec and the deployment’s zone from a one-off', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    const once = h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);
    const repeating = h.createSchedule(h.config, {
      chatKey: key,
      spec: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Manila' },
      text: 'y',
      createdBy: 'agent',
    }, NOW);
    expect(once.ok && once.entry.timezone).toBe(MADRID);
    expect(repeating.ok && repeating.entry.timezone).toBe('Asia/Manila');
  });

  it('refuses a time that has already gone, saying so in local terms', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, {
      chatKey: key,
      spec: { kind: 'once', at: '2020-01-01T00:00:00.000Z' },
      text: 'x',
      createdBy: 'agent',
    }, NOW);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error).toContain('passed');
    expect(h.readSchedule()).toHaveLength(0);
  });

  it('refuses an expression that never comes round, rather than storing a dud', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, {
      chatKey: key,
      spec: { kind: 'cron', expression: '0 0 30 2 *', timezone: MADRID },
      text: 'x',
      createdBy: 'agent',
    }, NOW);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error).toContain('30 February');
    expect(h.readSchedule()).toHaveLength(0);
  });
});

// ─── The caps ────────────────────────────────────────────────────────────────

describe('the caps refuse rather than truncate', () => {
  const fill = (h: Harness, key: string, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const made = h.createSchedule(h.config, {
        chatKey: key,
        spec: { kind: 'once', at: new Date(NOW + (i + 2) * 3_600_000).toISOString() },
        text: `note ${String(i)}`,
        createdBy: 'agent',
      }, NOW);
      expect(made.ok, `filling ${String(i)}`).toBe(true);
    }
  };

  it('stops one chat at scheduledPerChat and names the number', async () => {
    const h = await harness({ limits: { scheduledPerChat: 3 } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    fill(h, key, 3);

    const refused = h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'one too many', createdBy: 'agent' }, NOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain('3');
    // Nothing was silently dropped to make room, and nothing was added.
    expect(h.schedulesFor(key)).toHaveLength(3);
    expect(h.readSchedule().map((e) => e.text)).not.toContain('one too many');
  });

  it('does not let one chat’s cap stop another chat', async () => {
    const h = await harness({ limits: { scheduledPerChat: 2 } });
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const theirs = h.chats.keyFor(OTHER, false, NOW);
    fill(h, mine, 2);
    const made = h.createSchedule(h.config, { chatKey: theirs, spec: tomorrowAt9, text: 'ok', createdBy: 'agent' }, NOW);
    expect(made.ok).toBe(true);
  });

  it('stops the deployment at scheduledTotal', async () => {
    const h = await harness({ limits: { scheduledPerChat: 5, scheduledTotal: 3 } });
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const theirs = h.chats.keyFor(OTHER, false, NOW);
    fill(h, mine, 2);
    fill(h, theirs, 1);
    const refused = h.createSchedule(h.config, { chatKey: theirs, spec: tomorrowAt9, text: 'no', createdBy: 'agent' }, NOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain('3');
  });

  it('counts only what is still outstanding, so a cancelled one frees a slot', async () => {
    const h = await harness({ limits: { scheduledPerChat: 1 } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    const first = h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'a', createdBy: 'agent' }, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'b', createdBy: 'agent' }, NOW).ok).toBe(false);
    h.cancelSchedule(first.entry.id);
    expect(h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'b', createdBy: 'agent' }, NOW).ok).toBe(true);
  });

  it('refuses something too soon to be worth scheduling, and says to send it now', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, {
      chatKey: key,
      spec: { kind: 'once', at: new Date(NOW + 5_000).toISOString() },
      text: 'x',
      createdBy: 'agent',
    }, NOW);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error).toContain('now instead');
  });

  it('refuses something further off than the horizon, naming the horizon', async () => {
    const h = await harness({ limits: { scheduleMaxHorizonDays: 30 } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, {
      chatKey: key,
      spec: { kind: 'once', at: new Date(NOW + 40 * 86_400_000).toISOString() },
      text: 'x',
      createdBy: 'agent',
    }, NOW);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error).toContain('30 days');
  });
});

// ─── Firing ──────────────────────────────────────────────────────────────────

describe('when it comes due', () => {
  it('sends it to the chat that set it, and to nowhere else', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    h.chats.keyFor(OTHER, false, NOW);
    h.createSchedule(h.config, { chatKey: mine, spec: tomorrowAt9, text: 'the meetup is on the 28th', createdBy: 'agent' }, NOW);

    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent).toEqual([{ jid: PHONE, text: 'the meetup is on the 28th' }]);
  });

  it('records it in the feed like any other outbound message', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'ping', createdBy: 'agent' }, NOW);
    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));

    // `kind: 'out'`, not a scheduling-specific shape. Anything that reads the
    // feed to answer "what did we send this person" must not have to learn
    // about scheduling first.
    const outbound = h.feedRows().filter((r) => r.kind === 'out');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.chatKey).toBe(key);
    expect(outbound[0]?.text).toBe('ping');
  });

  it('spends the destination’s outbound allowance, and is refused when it is gone', async () => {
    // The allowance exists to bound a looping agent. A scheduler that sent
    // around it would be a way to push messages past the one ceiling that
    // protects the WhatsApp account.
    const h = await harness({ limits: { outboundPerChatPerHour: 1, scheduledPerChat: 5 } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    for (const text of ['first', 'second']) {
      h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text, createdBy: 'agent' }, NOW);
    }
    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));

    expect(sent).toHaveLength(1);
    // The one that did not go out is still due — not dropped, not failed.
    const waiting = h.readSchedule().filter((e) => e.state === 'active');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.nextAt).toBe('2026-09-26T07:00:00.000Z');
  });

  it('marks a one-off done and stops looking at it', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'once', createdBy: 'agent' }, NOW);

    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    await h.scheduler.tick(Date.parse('2026-09-26T07:05:00.000Z'));
    expect(sent).toHaveLength(1);
    expect(h.readSchedule()[0]?.state).toBe('done');
    expect(h.readSchedule()[0]?.fireCount).toBe(1);
  });

  it('advances a repeating one to its next turn instead of finishing it', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, {
      chatKey: key,
      spec: { kind: 'cron', expression: '0 9 * * *', timezone: MADRID },
      text: 'daily',
      createdBy: 'agent',
    }, NOW);

    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    const entry = h.readSchedule()[0];
    expect(entry?.state).toBe('active');
    expect(entry?.fireCount).toBe(1);
    expect(entry?.nextAt).toBe('2026-09-27T07:00:00.000Z');
  });

  it('fails an entry whose chat has been blocked, rather than sending anyway', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);
    h.chats.setBlocked(key, true);

    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent).toHaveLength(0);
    expect(h.readSchedule()[0]?.state).toBe('failed');
    expect(h.feedRows().some((r) => r.event === 'schedule.failed')).toBe(true);
  });
});

// ─── The grace window ────────────────────────────────────────────────────────

describe('a reminder that came due while nothing was running', () => {
  const dueAt = Date.parse('2026-09-26T07:00:00.000Z');

  it('is delivered late, with a note saying so, inside the window', async () => {
    const h = await harness({ limits: { scheduleGraceMs: 2 * 3_600_000 } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'the meetup is today', createdBy: 'agent' }, NOW);

    // Ninety minutes after it was due: the bridge was restarting.
    await h.scheduler.tick(dueAt + 90 * 60_000);
    expect(sent).toHaveLength(1);
    // A 9am reminder arriving at 10:30 with no explanation reads as the bot
    // being confused about the time, which is worse than the delay.
    expect(sent[0]?.text).toContain('late');
    expect(sent[0]?.text).toContain('09:00');
    expect(sent[0]?.text).toContain('the meetup is today');
    expect(h.readSchedule()[0]?.state).toBe('done');
  });

  it('does not add the note when it is merely a tick late', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'on time', createdBy: 'agent' }, NOW);
    await h.scheduler.tick(dueAt + 20_000);
    expect(sent[0]?.text).toBe('on time');
  });

  it('is marked missed outside the window — and never silently dropped', async () => {
    const h = await harness({ limits: { scheduleGraceMs: 2 * 3_600_000 } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'a week ago', createdBy: 'agent' }, NOW);

    await h.scheduler.tick(dueAt + 7 * 86_400_000);
    expect(sent).toHaveLength(0);

    const entry = h.readSchedule()[0];
    expect(entry?.state).toBe('missed');
    expect(entry?.note).toContain('missed');
    // Loud, in the record an operator actually reads. Silence is the one
    // outcome that is always wrong, because it is what the absence of any
    // scheduler at all looked like.
    const missed = h.feedRows().filter((r) => r.event === 'schedule.missed');
    expect(missed).toHaveLength(1);
    expect(missed[0]?.kind).toBe('event');
  });

  it('lets a repeating rule survive a missed turn, and records the miss', async () => {
    const h = await harness({ limits: { scheduleGraceMs: 3_600_000 } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, {
      chatKey: key,
      spec: { kind: 'cron', expression: '0 9 * * *', timezone: MADRID },
      text: 'daily',
      createdBy: 'agent',
    }, NOW);

    // Three days later. Yesterday's 9am is long gone; tomorrow's still matters.
    const late = Date.parse('2026-09-29T12:00:00.000Z');
    await h.scheduler.tick(late);
    expect(sent).toHaveLength(0);

    const entry = h.readSchedule()[0];
    expect(entry?.state).toBe('active');
    expect(entry?.nextAt).toBe('2026-09-30T07:00:00.000Z');
    expect(h.feedRows().some((r) => r.event === 'schedule.missed')).toBe(true);
  });
});

// ─── The switch ──────────────────────────────────────────────────────────────

describe('when the operator switches scheduling off', () => {
  it('holds the agent’s reminders rather than sending or deleting them', async () => {
    const h = await harness({ agent: { schedule: false } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    // Created directly: the *action* is refused in the outbox, and this is
    // about what happens to entries that already exist when the switch moves.
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'held', createdBy: 'agent' }, NOW);

    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent).toHaveLength(0);
    const entry = h.readSchedule()[0];
    expect(entry?.state).toBe('active');
    expect(entry?.nextAt).toBe('2026-09-26T07:00:00.000Z');
    expect(h.feedRows().some((r) => r.event === 'schedule.paused')).toBe(true);
  });

  it('still sends an operator’s own, which the switch was never about', async () => {
    const h = await harness({ agent: { schedule: false } });
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'operator set this', createdBy: 'operator' }, NOW);
    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent).toHaveLength(1);
  });
});

// ─── Cancelling, listing, and not leaking ────────────────────────────────────

describe('cancelling', () => {
  it('stops it firing', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    expect(h.cancelSchedule(made.entry.id, key).ok).toBe(true);
    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent).toHaveLength(0);
    expect(h.readSchedule()[0]?.state).toBe('cancelled');
  });

  it('answers another chat’s id exactly as it answers an invented one', async () => {
    // The two must be indistinguishable, or this becomes a way to find out
    // what somebody else has been promised.
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const theirs = h.chats.keyFor(OTHER, false, NOW);
    const made = h.createSchedule(h.config, { chatKey: theirs, spec: tomorrowAt9, text: 'theirs', createdBy: 'agent' }, NOW);
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const crossed = h.cancelSchedule(made.entry.id, mine);
    const invented = h.cancelSchedule('11111111-2222-4333-8444-555555555555', mine);
    expect(crossed.ok).toBe(false);
    expect(invented.ok).toBe(false);
    expect(crossed.ok === false && crossed.error).toBe(invented.ok === false ? invented.error : '');
    // And it really is still set.
    expect(h.readSchedule()[0]?.state).toBe('active');
  });

  it('refuses to cancel one twice', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);
    if (!made.ok) return;
    expect(h.cancelSchedule(made.entry.id).ok).toBe(true);
    expect(h.cancelSchedule(made.entry.id).ok).toBe(false);
  });
});

describe('the panel’s view', () => {
  it('names the conversation each one lands in, not just its key', async () => {
    // The page renders "Goes to …", and a chat key cannot fill that sentence —
    // it is sixteen hex characters chosen to be meaningless. This is the field
    // an operator reads before cancelling something, and cancelling the wrong
    // reminder is the mistake this page can actually cause.
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.chats.touch(key, { name: 'ChatBot Test Group' }, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);

    const view = h.scheduleView({ chats: h.chats } as never);
    expect(view.items[0]?.['chatName']).toBe('ChatBot Test Group');
    // And both halves of the time: the instant a machine sorts on, and the
    // string a person reads — pre-rendered here because the browser would
    // otherwise show it in the *viewer's* zone, which is not the promise.
    expect(view.items[0]?.['nextAt']).toBe('2026-09-26T07:00:00.000Z');
    expect(String(view.items[0]?.['nextAtLocal'])).toContain('09:00');
  });

  it('says nothing rather than inventing a name for a chat it has lost', async () => {
    const h = await harness();
    const key = h.chats.keyFor(PHONE, false, NOW);
    h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);
    const view = h.scheduleView({ chats: { get: () => undefined } } as never);
    expect(view.items[0]?.['chatName']).toBeNull();
  });
});

describe('listing', () => {
  it('shows one chat only its own', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const theirs = h.chats.keyFor(OTHER, false, NOW);
    h.createSchedule(h.config, { chatKey: mine, spec: tomorrowAt9, text: 'mine', createdBy: 'agent' }, NOW);
    h.createSchedule(h.config, { chatKey: theirs, spec: tomorrowAt9, text: 'theirs', createdBy: 'agent' }, NOW);

    expect(h.schedulesFor(mine).map((e) => e.text)).toEqual(['mine']);
    expect(h.schedulesFor(theirs).map((e) => e.text)).toEqual(['theirs']);
  });
});

// ─── The store itself ────────────────────────────────────────────────────────

describe('a store that cannot be trusted', () => {
  it('reads as empty when it is not JSON, rather than throwing into the tick', async () => {
    const h = await harness();
    writeFileSync(h.scheduleFile, 'not json');
    expect(h.readSchedule()).toEqual([]);
    await expect(h.scheduler.tick(NOW)).resolves.toBeUndefined();
  });

  it('refuses to add to a store it could not read, rather than overwriting it', async () => {
    // The failure this guards is the one `atomicFile.ts` was written for in the
    // sibling project: a read that failed and an empty store are the same value
    // to a caller, and the next write makes the wrong one permanent.
    const h = await harness();
    writeFileSync(h.scheduleFile, '{"entries": [{"broken": true}]}');
    const key = h.chats.keyFor(PHONE, false, NOW);
    const made = h.createSchedule(h.config, { chatKey: key, spec: tomorrowAt9, text: 'x', createdBy: 'agent' }, NOW);
    expect(made.ok).toBe(false);
    if (made.ok) return;
    expect(made.error).toContain('could not read');
    expect(made.error).toContain('Nothing was scheduled');
    // And the unreadable file is left exactly as it was, rather than being
    // replaced by a store containing only the new entry.
    expect(readFileSync(h.scheduleFile, 'utf8')).toContain('broken');
  });

  it('never lets one bad entry stop the others', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const good = h.createSchedule(h.config, { chatKey: mine, spec: tomorrowAt9, text: 'good', createdBy: 'agent' }, NOW);
    expect(good.ok).toBe(true);
    if (!good.ok) return;

    // An entry pointing at a chat this bridge has never issued a key for: a
    // merge, a wiped registry, or an operator deleting a conversation.
    const entries = JSON.parse(readFileSync(h.scheduleFile, 'utf8')) as { entries: unknown[] };
    entries.entries.unshift({
      ...(entries.entries[0] as Record<string, unknown>),
      id: '11111111-2222-4333-8444-555555555555',
      chatKey: 'deadbeefdeadbeef',
      text: 'orphan',
    });
    writeFileSync(h.scheduleFile, JSON.stringify(entries));

    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent.map((s) => s.text)).toEqual(['good']);
    const states = Object.fromEntries(h.readSchedule().map((e) => [e.text, e.state]));
    expect(states['orphan']).toBe('failed');
    expect(states['good']).toBe('done');
  });
});
