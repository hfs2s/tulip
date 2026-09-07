/**
 * When a promise actually comes due.
 *
 * Two things are being defended here and they are not the same thing.
 *
 * The first is **arithmetic across a boundary that happens twice a year**. A
 * scheduler is trivially correct for 363 days and quietly wrong on the other
 * two, and nobody notices until a reminder arrives an hour out — by which point
 * it is a story about the bot being unreliable rather than a bug report. So the
 * DST cases below are written against real transitions in Europe/Madrid, which
 * is where this deployment's people are, with Europe/London and America/New_York
 * as second opinions and Asia/Manila as the control that never moves.
 *
 * The second is **the vocabulary**. A scheduled message that could name another
 * chat would be a better spam primitive than an immediate one — it leaves with
 * nobody watching. The test for that is not "it is refused", it is that the
 * schema has nowhere to put the idea.
 *
 * The transitions used below, so the expected values can be checked by hand:
 *
 *   Europe/Madrid   2026-03-29  02:00 → 03:00   (CET +01 → CEST +02)
 *                   2026-10-25  03:00 → 02:00   (CEST +02 → CET +01)
 *   Europe/London   2026-03-29  01:00 → 02:00
 *   America/New_York 2026-11-01 02:00 → 01:00
 *   Asia/Manila     never
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SCAN_DAYS,
  ScheduleSpec,
  formatLocal,
  isTimeZone,
  nextOccurrence,
  parseCron,
  parseWhen,
  splitWhen,
  wallClockAt,
  wallClockToInstant,
} from '../src/schedule.js';
import { OutboxAction } from '../src/handoff.js';

const MADRID = 'Europe/Madrid';
const LONDON = 'Europe/London';
const MANILA = 'Asia/Manila';
const NEW_YORK = 'America/New_York';

const cron = (expression: string, timezone = MADRID): ScheduleSpec => ({ kind: 'cron', expression, timezone });
const at = (iso: string): Date => new Date(iso);

// ─── The parser ──────────────────────────────────────────────────────────────

describe('a five-field expression', () => {
  it('accepts every shape it promises to accept', () => {
    for (const expression of [
      '* * * * *',
      '0 9 * * *',
      '30 6,18 * * *',
      '0 9-17 * * 1-5',
      '*/15 * * * *',
      '0 8-20/4 * * *',
      '0 0 1,15 * *',
      '59 23 31 12 *',
      '0 9 * * 0',
      '0 9 * * 7',
    ]) {
      expect(parseCron(expression).ok, expression).toBe(true);
    }
  });

  it('treats 0 and 7 as the same Sunday', () => {
    const zero = parseCron('0 9 * * 0');
    const seven = parseCron('0 9 * * 7');
    expect(zero.ok && seven.ok).toBe(true);
    if (!zero.ok || !seven.ok) return;
    expect([...seven.fields.daysOfWeek]).toEqual([...zero.fields.daysOfWeek]);
  });

  it('expands a stepped range to exactly the values in it', () => {
    const parsed = parseCron('0 8-20/4 * * *');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.fields.hours].sort((a, b) => a - b)).toEqual([8, 12, 16, 20]);
  });

  it('records which day field was narrowed, because the two interact', () => {
    const both = parseCron('0 0 1 * 1');
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(both.fields.domRestricted).toBe(true);
    expect(both.fields.dowRestricted).toBe(true);
  });

  /**
   * Every one of these has a message a person is meant to be able to act on.
   * The assertion is not just that it failed — it is that the refusal says
   * something, because the agent relays it verbatim to whoever asked.
   */
  it.each([
    ['0 9 * *', 'five parts'],
    ['0 9 * * * *', 'five parts'],
    ['0 9 * * MON', 'day of the week'],
    ['@daily', 'five parts'],
    ['70 9 * * *', 'minute'],
    ['0 25 * * *', 'hour'],
    ['0 9 32 * *', 'day of the month'],
    ['0 9 * 13 *', 'month'],
    ['0 9 * * 8', 'day of the week'],
    ['*/0 9 * * *', 'step'],
    ['0 17-9 * * *', 'backwards'],
    ['0 9,, * * *', 'empty piece'],
    ['0 9 * * 1-5/', 'day of the week'],
    ['0 9 L * *', 'day of the month'],
    ['0 9 * * 1#2', 'day of the week'],
  ])('refuses %s with a reason naming the problem', (expression, needle) => {
    const parsed = parseCron(expression);
    expect(parsed.ok, expression).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.toLowerCase()).toContain(needle.toLowerCase());
    expect(parsed.error.length).toBeGreaterThan(20);
  });
});

// ─── Ordinary arithmetic ─────────────────────────────────────────────────────

describe('the next occurrence', () => {
  it('is strictly after the moment asked about, never equal to it', () => {
    // Otherwise an entry that has just fired re-fires forever: the ticker asks
    // "what is next after now", and now is exactly when it went out.
    const nine = at('2026-09-26T07:00:00.000Z'); // 09:00 in Madrid
    const next = nextOccurrence(cron('0 9 * * *'), nine);
    expect(next?.toISOString()).toBe('2026-09-27T07:00:00.000Z');
  });

  it('reads the wall clock in the entry’s zone, not the machine’s', () => {
    // The bug this whole file exists for. The box is UTC; 09:00 Madrid in
    // September is 07:00 UTC, and a scheduler that ignored the zone would fire
    // this two hours late.
    const next = nextOccurrence(cron('0 9 * * *'), at('2026-09-26T00:00:00.000Z'));
    expect(next?.toISOString()).toBe('2026-09-26T07:00:00.000Z');
    expect(formatLocal(next as Date, MADRID)).toContain('09:00');
  });

  it('honours day-of-week against the local calendar', () => {
    // 2026-09-26 is a Saturday in Madrid. Weekdays-only should skip to Monday.
    const next = nextOccurrence(cron('0 9 * * 1-5'), at('2026-09-26T00:00:00.000Z'));
    expect(formatLocal(next as Date, MADRID)).toContain('Mon');
    expect(next?.toISOString()).toBe('2026-09-28T07:00:00.000Z');
  });

  it('fires on either day when both day fields are narrowed', () => {
    // The rule everybody's cron follows: the 1st of the month OR any Monday.
    // 2026-09-01 is a Tuesday, so it only matches through day-of-month.
    const next = nextOccurrence(cron('0 0 1 * 1'), at('2026-08-31T12:00:00.000Z'));
    expect(formatLocal(next as Date, MADRID)).toContain('1 Sept');
  });

  it('answers a one-off in the past with null rather than with the past', () => {
    const spec: ScheduleSpec = { kind: 'once', at: '2020-01-01T00:00:00.000Z' };
    expect(nextOccurrence(spec, at('2026-09-26T00:00:00.000Z'))).toBeNull();
  });

  it('answers a one-off in the future with exactly that instant', () => {
    const spec: ScheduleSpec = { kind: 'once', at: '2026-09-26T07:00:00.000Z' };
    expect(nextOccurrence(spec, at('2026-09-01T00:00:00.000Z'))?.toISOString()).toBe('2026-09-26T07:00:00.000Z');
  });
});

describe('an expression that can never fire', () => {
  it('returns null instead of spinning', () => {
    // 30 February parses perfectly. Without the forward-scan cap this searches
    // until the process is killed — inside a tick loop, which is a hung bridge
    // rather than a rejected reminder.
    const started = Date.now();
    expect(nextOccurrence(cron('0 0 30 2 *'), at('2026-01-01T00:00:00.000Z'))).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('returns null for anything beyond the scan horizon', () => {
    // 29 February 2032 is over 400 days from 2026, so this is unreachable
    // *from here* even though it is a real date. Null is the honest answer:
    // the store would otherwise hold an entry with nothing to fire.
    expect(nextOccurrence(cron('0 0 29 2 *'), at('2026-03-01T00:00:00.000Z'))).toBeNull();
    expect(MAX_SCAN_DAYS).toBeLessThan(1000);
  });
});

// ─── Daylight saving ─────────────────────────────────────────────────────────

describe('spring forward, when an hour does not happen', () => {
  it('keeps a daily 9am at 9am across the Madrid transition', () => {
    // 08:00Z before (CET), 07:00Z after (CEST). An implementation that stepped
    // instants by 24 hours would deliver 10:00 local on the Sunday.
    let cursor = at('2026-03-27T00:00:00.000Z');
    const fired: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = nextOccurrence(cron('0 9 * * *'), cursor) as Date;
      fired.push(next.toISOString());
      cursor = next;
    }
    expect(fired).toEqual([
      '2026-03-27T08:00:00.000Z',
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
    ]);
    for (const instant of fired) expect(formatLocal(new Date(instant), MADRID)).toContain('09:00');
  });

  it('still fires a reminder set inside the gap, an hour later in wall terms', () => {
    // 02:30 does not exist in Madrid on 2026-03-29. Documented behaviour: it
    // resolves past the jump rather than being skipped, because a reminder that
    // arrives an hour off once a year is better than one that never arrives.
    const next = nextOccurrence(cron('30 2 * * *'), at('2026-03-28T12:00:00.000Z')) as Date;
    expect(next.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(formatLocal(next, MADRID)).toContain('03:30');
    // And the following day is back to normal.
    const after = nextOccurrence(cron('30 2 * * *'), next) as Date;
    expect(formatLocal(after, MADRID)).toContain('02:30');
  });

  it('does the same thing in London, where the gap is at a different hour', () => {
    const next = nextOccurrence(cron('30 1 * * *', LONDON), at('2026-03-28T12:00:00.000Z')) as Date;
    expect(next.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(formatLocal(next, LONDON)).toContain('02:30');
  });
});

describe('autumn fallback, when an hour happens twice', () => {
  it('holds a daily 9am at 9am across the Madrid transition', () => {
    let cursor = at('2026-10-23T00:00:00.000Z');
    const fired: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = nextOccurrence(cron('0 9 * * *'), cursor) as Date;
      fired.push(next.toISOString());
      cursor = next;
    }
    expect(fired).toEqual([
      '2026-10-23T07:00:00.000Z',
      '2026-10-24T07:00:00.000Z',
      '2026-10-25T08:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ]);
    for (const instant of fired) expect(formatLocal(new Date(instant), MADRID)).toContain('09:00');
  });

  it('fires an ambiguous time once, not twice', () => {
    // 02:30 happens twice in Madrid on 2026-10-25. Both are correct answers and
    // only one may be delivered, or somebody gets the same reminder twice.
    const first = nextOccurrence(cron('30 2 * * *'), at('2026-10-24T12:00:00.000Z')) as Date;
    expect(first.toISOString()).toBe('2026-10-25T01:30:00.000Z');
    const second = nextOccurrence(cron('30 2 * * *'), first) as Date;
    // The next one is the following day, not the same clock face again.
    expect(second.toISOString()).toBe('2026-10-26T01:30:00.000Z');
  });

  it('does the same across the New York transition, on a different date entirely', () => {
    // 2026-11-01, a week after Europe. A single hard-coded transition date
    // would pass every test above and fail here.
    let cursor = at('2026-10-30T00:00:00.000Z');
    const fired: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = nextOccurrence(cron('0 9 * * *', NEW_YORK), cursor) as Date;
      fired.push(next.toISOString());
      cursor = next;
    }
    expect(fired).toEqual([
      '2026-10-30T13:00:00.000Z',
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ]);
  });
});

describe('a zone that never moves', () => {
  it('runs at the same instant every day in Manila, right through both European transitions', () => {
    for (const start of ['2026-03-28T00:00:00.000Z', '2026-10-24T00:00:00.000Z']) {
      const first = nextOccurrence(cron('0 9 * * *', MANILA), at(start)) as Date;
      const second = nextOccurrence(cron('0 9 * * *', MANILA), first) as Date;
      expect(second.getTime() - first.getTime()).toBe(86_400_000);
      expect(formatLocal(first, MANILA)).toContain('09:00');
    }
  });

  it('is eight hours ahead of UTC, which is the whole of its complexity', () => {
    const next = nextOccurrence(cron('0 9 * * *', MANILA), at('2026-09-26T00:00:00.000Z')) as Date;
    expect(next.toISOString()).toBe('2026-09-26T01:00:00.000Z');
  });
});

describe('wall clock to instant, directly', () => {
  it('round-trips any ordinary time', () => {
    const wall = { year: 2026, month: 9, day: 26, hour: 9, minute: 0 };
    const instant = wallClockToInstant(MADRID, wall);
    expect(wallClockAt(MADRID, instant)).toEqual(wall);
  });

  it('does not throw or loop on a time that does not exist', () => {
    const instant = wallClockToInstant(MADRID, { year: 2026, month: 3, day: 29, hour: 2, minute: 30 });
    expect(Number.isFinite(instant)).toBe(true);
    // It resolved to *something* defined, on the far side of the jump.
    expect(wallClockAt(MADRID, instant).hour).toBe(3);
  });

  it('resolves an ambiguous time to the second occurrence', () => {
    const instant = wallClockToInstant(MADRID, { year: 2026, month: 10, day: 25, hour: 2, minute: 30 });
    // 00:30Z is the first (CEST) pass; 01:30Z is the second (CET).
    expect(new Date(instant).toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });
});

describe('zone names', () => {
  it('accepts real ones and refuses shapes that merely look real', () => {
    for (const good of [MADRID, MANILA, 'UTC', 'America/New_York']) expect(isTimeZone(good), good).toBe(true);
    for (const bad of ['Europe/Madrizd', 'CEST', '+02:00', '', 'Mars/Olympus']) {
      expect(isTimeZone(bad), bad).toBe(false);
    }
  });
});

// ─── Saying when ─────────────────────────────────────────────────────────────

describe('the words a person uses for a time', () => {
  // Midday in Madrid on a Friday in September (CEST, +02:00).
  const now = at('2026-09-25T10:00:00.000Z');

  it.each([
    ['2026-09-26T09:00:00Z', '2026-09-26T09:00:00.000Z'],
    ['2026-09-26T09:00:00+02:00', '2026-09-26T07:00:00.000Z'],
    ['2026-09-26 09:00', '2026-09-26T07:00:00.000Z'],
    ['2026-09-26 9am', '2026-09-26T07:00:00.000Z'],
    ['tomorrow 9am', '2026-09-26T07:00:00.000Z'],
    ['tomorrow 09:00', '2026-09-26T07:00:00.000Z'],
    ['today 18:30', '2026-09-25T16:30:00.000Z'],
    ['in 2 hours', '2026-09-25T12:00:00.000Z'],
    ['in 30 minutes', '2026-09-25T10:30:00.000Z'],
    ['in 3 days', '2026-09-28T10:00:00.000Z'],
    // It is exactly noon in Madrid at `now`, and a reminder must be in the
    // future — so the next noon is tomorrow's. Rolling forward is the right
    // direction: the alternative is a reminder due at the instant it was set.
    ['noon', '2026-09-26T10:00:00.000Z'],
  ])('reads %s as %s', (text, expected) => {
    const parsed = parseWhen(text, MADRID, now);
    expect(parsed.ok, text).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.at.toISOString()).toBe(expected);
  });

  it('resolves a bare time to the next time it comes round', () => {
    // 12:00 local has just passed, so 9am means tomorrow morning.
    const parsed = parseWhen('9am', MADRID, now);
    expect(parsed.ok && parsed.at.toISOString()).toBe('2026-09-26T07:00:00.000Z');
  });

  it('reads an unqualified time as local, which is the entire point', () => {
    // The same words in two zones must not produce the same instant, or the
    // zone is decoration.
    const madrid = parseWhen('tomorrow 9am', MADRID, now);
    const manila = parseWhen('tomorrow 9am', MANILA, now);
    expect(madrid.ok && manila.ok).toBe(true);
    if (!madrid.ok || !manila.ok) return;
    expect(madrid.at.toISOString()).not.toBe(manila.at.toISOString());
  });

  it('refuses what it cannot read, and says what it would have taken', () => {
    for (const bad of ['next Michaelmas', 'soon', 'in a bit', '', '25:00']) {
      const parsed = parseWhen(bad, MADRID, now);
      expect(parsed.ok, bad).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toContain('tomorrow 9am');
    }
  });
});

describe('splitting <when> from <text>', () => {
  const now = at('2026-09-25T10:00:00.000Z');

  it('handles the time as one quoted argument', () => {
    const split = splitWhen(['tomorrow 9am', 'feed the cat'], MADRID, now);
    expect(split.ok && split.text).toBe('feed the cat');
  });

  it('handles the time unquoted, which is what a model actually types', () => {
    const split = splitWhen(['tomorrow', '9am', 'feed', 'the', 'cat'], MADRID, now);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.when).toBe('tomorrow 9am');
    expect(split.text).toBe('feed the cat');
    expect(split.at.toISOString()).toBe('2026-09-26T07:00:00.000Z');
  });

  it('takes the longest prefix, so "tomorrow" cannot swallow "9am"', () => {
    // The failure mode of a shortest-match rule: "tomorrow" parses on its own,
    // and the reminder would then be set for 9am tomorrow with the text "9am
    // feed the cat" — wrong in both halves.
    const split = splitWhen(['tomorrow', '9am', 'x'], MADRID, now);
    expect(split.ok && split.text).toBe('x');
  });

  it('reads a three-word relative offset', () => {
    const split = splitWhen(['in', '2', 'hours', 'check', 'the', 'oven'], MADRID, now);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(split.at.toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(split.text).toBe('check the oven');
  });

  it('always leaves something to say, rather than eating the message', () => {
    expect(splitWhen(['tomorrow 9am'], MADRID, now).ok).toBe(false);
    expect(splitWhen([], MADRID, now).ok).toBe(false);
  });
});

// ─── The vocabulary ──────────────────────────────────────────────────────────

describe('a scheduled message cannot name another chat', () => {
  const base = {
    id: '11111111-2222-4333-8444-555555555555',
    turnId: '11111111-2222-4333-8444-555555555556',
    kind: 'schedule' as const,
    spec: { kind: 'once' as const, at: '2026-09-26T07:00:00.000Z' },
    text: 'the meetup is on Monday',
  };

  it('accepts the action as written', () => {
    expect(OutboxAction.safeParse(base).success).toBe(true);
  });

  /**
   * The point of the whole exercise. `sendTo` *refuses* a cross-chat send when
   * the operator has not enabled it; this cannot be asked for at all, because
   * the schema is strict and there is no field to put it in. A delayed send is
   * a worse primitive than an immediate one — it happens with nobody watching —
   * so the answer is "unrepresentable" rather than "refused".
   */
  it('rejects one that tries, because the field does not exist', () => {
    const parsed = OutboxAction.safeParse({ ...base, chatKey: 'a1b2c3d4e5f60718' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a phone number, a jid and a null destination alike', () => {
    for (const smuggled of [
      { chatKey: null },
      { to: '15551234567' },
      { jid: '15551234567@s.whatsapp.net' },
      { chatKey: 'a1b2c3d4e5f60718', spec: base.spec },
    ]) {
      expect(OutboxAction.safeParse({ ...base, ...smuggled }).success).toBe(false);
    }
  });

  it('refuses a cron spec with no zone, so nothing resolves against the box clock', () => {
    const parsed = OutboxAction.safeParse({
      ...base,
      spec: { kind: 'cron', expression: '0 9 * * *' },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a cron spec whose expression does not parse, with the parser’s own words', () => {
    const parsed = OutboxAction.safeParse({
      ...base,
      spec: { kind: 'cron', expression: '0 9 * * MON', timezone: MADRID },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(parsed.error.issues)).toContain('day of the week');
  });

  it('refuses a one-off with a bare local time, which would be ambiguous', () => {
    // No `Z`, no offset. A stored "2026-09-26T09:00:00" would mean whatever the
    // reader's clock happened to be, which is the bug in one field.
    expect(OutboxAction.safeParse({ ...base, spec: { kind: 'once', at: '2026-09-26T09:00:00' } }).success).toBe(false);
  });
});
