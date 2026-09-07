/**
 * When a thing should happen — the arithmetic, and nothing else.
 *
 * This file exists because a real person asked Juan to remind a group about a
 * meetup, on a named day, at nine in the morning. Nothing in Tulip could have
 * kept that promise: there was no cron, no `at`, no timer, and no store. The
 * promise was made anyway, which is the worst of the available outcomes — worse
 * than refusing, because nobody found out until the day passed.
 *
 * Everything here is pure. No filesystem, no clock of its own, no sending: a
 * spec goes in and an instant comes out, so the hard part can be tested at
 * boundaries a running deployment reaches twice a year. The store, the ticker
 * and the actual send are the bridge's, in `bridge/src/schedule.ts`.
 *
 * ## Time zones are the whole problem
 *
 * The box runs UTC. The people using it do not. A reminder set for "9am" that
 * arrives at 11am is not a slightly wrong reminder — it is a reminder that
 * failed, plus a bot that now looks unreliable about the one thing it was
 * asked to be reliable about. So every wall-clock time in this file carries an
 * IANA zone, and the conversion between wall clock and instant is done with
 * `Intl.DateTimeFormat` and nothing else. There is no date library here and
 * there is not going to be one.
 *
 * The conversion is a fixed point found by iterating twice — see
 * `wallClockToInstant`, which carries the argument for why twice is enough and
 * what happens at the two boundaries where a wall clock is not a function of an
 * instant at all:
 *
 *   - a **nonexistent** local time, in the spring-forward gap, resolves to the
 *     instant the clocks jump to rather than throwing or being skipped;
 *   - an **ambiguous** local time, in the autumn overlap, resolves to the
 *     second (post-transition) occurrence.
 *
 * Both are defined, neither loops, and a reminder is delivered in both cases.
 * Delivering one an hour off the intended wall clock twice a year is a far
 * smaller failure than not delivering it, which is the trade being made.
 *
 * ## The cron parser is hand-written on purpose
 *
 * No new npm dependency, and the error messages are the point. A model writes
 * these expressions and a non-engineer reads the refusal, so "unexpected token"
 * is not an acceptable answer — every rejection below names the field, quotes
 * what was written, and says what would have been accepted.
 */

import { z } from 'zod';

// ─── Zones ───────────────────────────────────────────────────────────────────

/**
 * Is this a zone the platform actually knows?
 *
 * Round-tripped through `Intl` rather than matched against a pattern, because
 * `Europe/Madrizd` is a perfectly well-shaped string and a completely useless
 * zone. Node throws `RangeError` on an unknown one, which is exactly the check
 * — there is no list to keep up to date and nothing to drift.
 */
export function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  // `Intl` also accepts a bare offset — `+02:00` constructs perfectly well and
  // is a *fixed* zone that never observes daylight saving. Accepting one would
  // be worse than rejecting an invalid name: Madrid would be right in winter,
  // an hour out all summer, and nothing anywhere would say so. So the name has
  // to look like an IANA identifier as well as resolve like one. (`Etc/GMT+8`
  // is a real name and passes — it starts with a letter.)
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone name, checked against the platform's own database. */
export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, (zone) => ({
    message:
      `"${zone}" is not a time zone this machine knows. Use an IANA name such as ` +
      'Europe/Madrid, Asia/Manila or UTC — not an abbreviation like CEST and not an offset like +02:00.',
  }));

/**
 * One `Intl.DateTimeFormat` per zone, kept.
 *
 * A 400-day forward scan asks for the local fields of a candidate minute
 * thousands of times, and constructing a formatter is not cheap. The map is
 * bounded by the number of zones a deployment actually uses, which is one or
 * two.
 */
const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFor(zone: string): Intl.DateTimeFormat {
  const existing = partFormatters.get(zone);
  if (existing !== undefined) return existing;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    // `hourCycle` rather than `hour12: false`, which yields hour "24" for
    // midnight on some ICU builds. The `% 24` below is belt and braces.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  partFormatters.set(zone, made);
  return made;
}

/** A wall-clock reading: what a clock on the wall in that zone would show. */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** What the clocks in `zone` read at this instant. */
export function wallClockAt(zone: string, instant: number): WallClock {
  const parts = partsFor(zone).formatToParts(new Date(instant));
  const field = (name: string): number => {
    const found = parts.find((p) => p.type === name);
    return found === undefined ? 0 : Number(found.value);
  };
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour') % 24,
    minute: field('minute'),
  };
}

/**
 * How far ahead of UTC `zone` is at this instant, in milliseconds.
 *
 * Positive east of Greenwich. Derived by formatting the instant in the zone and
 * reading the result back as though it were UTC: the difference between that
 * and the real instant *is* the offset, and it costs one format instead of a
 * table of transitions nobody maintains.
 */
export function zoneOffsetMs(zone: string, instant: number): number {
  const parts = partsFor(zone).formatToParts(new Date(instant));
  const field = (name: string): number => {
    const found = parts.find((p) => p.type === name);
    return found === undefined ? 0 : Number(found.value);
  };
  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );
  return asIfUtc - instant;
}

/**
 * The instant at which the clocks in `zone` read this wall time.
 *
 * The problem is that the offset depends on the instant, and the instant is
 * what we are solving for. So: guess the offset from the wall time read as
 * though it were UTC, correct, then correct once more using the offset at the
 * corrected guess. Two passes converge everywhere a single DST transition is
 * involved, which is everywhere — the first pass lands within an hour or two of
 * the answer, and the second is evaluated on the correct side of the boundary.
 *
 * **The two boundaries where no exact answer exists**, stated because they are
 * the ones a reminder actually meets:
 *
 *   - **Spring forward.** 02:30 does not happen in Madrid on the last Sunday in
 *     March; the clocks go 02:00 → 03:00. The fixed point does not exist, and
 *     what comes back is the instant one gap-width later — 03:30 local. The
 *     reminder fires, an hour off in wall-clock terms, once a year.
 *   - **Autumn fallback.** 02:30 happens twice in Madrid on the last Sunday in
 *     October. Both are correct answers; this returns the second, the one after
 *     the clocks went back. The reminder fires once, not twice.
 *
 * Neither throws and neither loops, which is the requirement. A caller that
 * needs to know whether the wall time it asked for actually exists can compare
 * `wallClockAt(zone, result)` with what it passed in.
 */
export function wallClockToInstant(zone: string, wall: WallClock): number {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  const firstGuess = asIfUtc - zoneOffsetMs(zone, asIfUtc);
  return asIfUtc - zoneOffsetMs(zone, firstGuess);
}

/**
 * A wall clock rendered for a person to read, with the zone named.
 *
 * The zone name is not decoration. The whole failure this file exists to
 * prevent is two people meaning different nine o'clocks, so every time this
 * system quotes a time back it quotes the zone with it.
 */
export function formatLocal(instant: number | Date, zone: string): string {
  const at = instant instanceof Date ? instant : new Date(instant);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(at);
  } catch {
    // An unknown zone should have been refused at the boundary. If one reaches
    // here anyway, say the instant plainly rather than throwing inside a render.
    return `${at.toISOString()} (UTC)`;
  }
}

/** Just the clock face, for a short "this was meant to reach you at …" note. */
export function formatLocalTime(instant: number | Date, zone: string): string {
  const at = instant instanceof Date ? instant : new Date(instant);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
  } catch {
    return at.toISOString().slice(11, 16);
  }
}

// ─── The cron parser ─────────────────────────────────────────────────────────

interface FieldShape {
  readonly label: string;
  readonly min: number;
  readonly max: number;
}

/** Five fields, in the order every crontab in the world writes them. */
const FIELDS: readonly FieldShape[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of the month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12 },
  // 7 is accepted and folded onto 0. Both mean Sunday, and which one a person
  // reaches for depends entirely on where they learned cron.
  { label: 'day of the week', min: 0, max: 7 },
];

export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** Whether the day-of-month field was narrowed from `*`. See `dayMatches`. */
  readonly domRestricted: boolean;
  /** Whether the day-of-week field was narrowed from `*`. */
  readonly dowRestricted: boolean;
}

export type CronParse = { ok: true; fields: CronFields } | { ok: false; error: string };

/** What every field will accept, said once so five error messages agree. */
function accepted(shape: FieldShape): string {
  // Sunday is the one number nobody can guess, and the one people get wrong.
  const sunday = shape.label === 'day of the week' ? ' — 0 and 7 both mean Sunday' : '';
  return (
    `a number from ${String(shape.min)} to ${String(shape.max)}${sunday}, ` +
    `a list like ${String(shape.min)},${String(shape.min + 1)}, ` +
    `a range like ${String(shape.min)}-${String(shape.max)}, a step like */2, or * for every one`
  );
}

function parseItem(item: string, shape: FieldShape): { ok: true; values: number[] } | { ok: false; error: string } {
  const whole = /^\*$/.exec(item);
  const wholeStep = /^\*\/(\d{1,3})$/.exec(item);
  const single = /^(\d{1,3})$/.exec(item);
  const range = /^(\d{1,3})-(\d{1,3})$/.exec(item);
  const rangeStep = /^(\d{1,3})-(\d{1,3})\/(\d{1,3})$/.exec(item);

  let from = shape.min;
  let to = shape.max;
  let step = 1;

  if (whole !== null) {
    // the defaults above
  } else if (wholeStep !== null) {
    step = Number(wholeStep[1]);
  } else if (single !== null) {
    from = Number(single[1]);
    to = from;
  } else if (range !== null) {
    from = Number(range[1]);
    to = Number(range[2]);
  } else if (rangeStep !== null) {
    from = Number(rangeStep[1]);
    to = Number(rangeStep[2]);
    step = Number(rangeStep[3]);
  } else {
    return {
      ok: false,
      error: `"${item}" is not something I understand in the ${shape.label} field. Use ${accepted(shape)}.`,
    };
  }

  if (step < 1) {
    return { ok: false, error: `a step of ${String(step)} in the ${shape.label} field means nothing — use 1 or more.` };
  }
  if (from < shape.min || from > shape.max || to < shape.min || to > shape.max) {
    return {
      ok: false,
      error:
        `the ${shape.label} field only goes from ${String(shape.min)} to ${String(shape.max)}, ` +
        `and "${item}" is outside that.`,
    };
  }
  if (from > to) {
    return {
      ok: false,
      error:
        `"${item}" runs backwards. A range in the ${shape.label} field has to count upwards — ` +
        `write it as two pieces separated by a comma if you meant to wrap around.`,
    };
  }

  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return { ok: true, values };
}

function parseField(text: string, shape: FieldShape): { ok: true; values: Set<number> } | { ok: false; error: string } {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        error: `the ${shape.label} field has an empty piece in it — a list is written 1,3,5 with nothing left dangling.`,
      };
    }
    const parsed = parseItem(trimmed, shape);
    if (!parsed.ok) return parsed;
    for (const value of parsed.values) values.add(value === 7 && shape.max === 7 ? 0 : value);
  }
  return { ok: true, values };
}

/**
 * Parse a five-field expression, or say why not.
 *
 * Deliberately narrow. `@daily`, names like `MON`, `L`, `#` and `?` are all
 * refused rather than half-supported, because a scheduler that silently means
 * something other than what was written is the failure this whole file is
 * about. The refusal names what would have worked.
 */
export function parseCron(expression: string): CronParse {
  const parts = expression.trim().split(/\s+/).filter((p) => p.length > 0);
  if (parts.length !== 5) {
    return {
      ok: false,
      error:
        `a cron expression has five parts — minute hour day-of-month month day-of-week — and this has ` +
        `${String(parts.length)}. "0 9 * * 1-5" is nine in the morning on weekdays.`,
    };
  }

  const sets: Array<Set<number>> = [];
  for (const [index, shape] of FIELDS.entries()) {
    const parsed = parseField(parts[index] as string, shape);
    if (!parsed.ok) return parsed;
    if (parsed.values.size === 0) {
      return { ok: false, error: `the ${shape.label} field matches nothing at all.` };
    }
    sets.push(parsed.values);
  }

  return {
    ok: true,
    fields: {
      minutes: sets[0] as Set<number>,
      hours: sets[1] as Set<number>,
      daysOfMonth: sets[2] as Set<number>,
      months: sets[3] as Set<number>,
      daysOfWeek: sets[4] as Set<number>,
      domRestricted: (parts[2] as string).trim() !== '*',
      dowRestricted: (parts[4] as string).trim() !== '*',
    },
  };
}

/**
 * Does this date match the two day fields?
 *
 * The rule everybody's cron follows and nobody's documentation explains: when
 * *both* day-of-month and day-of-week are narrowed, a day matching *either* one
 * fires. It reads as a bug and is not — `0 0 1 * 1` is "the first of the month,
 * and also every Monday", which is what a person writing it means. When only
 * one is narrowed, the other is `*` and cannot exclude anything.
 */
function dayMatches(fields: CronFields, wall: WallClock): boolean {
  const dom = fields.daysOfMonth.has(wall.day);
  const dow = fields.daysOfWeek.has(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay());
  if (fields.domRestricted && fields.dowRestricted) return dom || dow;
  return dom && dow;
}

// ─── The spec ────────────────────────────────────────────────────────────────

/**
 * A one-off, at an absolute instant.
 *
 * An instant rather than a wall clock, deliberately: by the time a spec exists
 * the ambiguity has been resolved — by `parseWhen`, in a named zone, with the
 * answer echoed back to whoever asked. Storing "9am" and resolving it later
 * would mean a zone change or a DST boundary silently moving a promise that had
 * already been made in words.
 */
export const ScheduleOnce = z
  .object({
    kind: z.literal('once'),
    /** ISO 8601 with a zone designator — `Z` or an offset. Not a bare local time. */
    at: z.string().datetime({ offset: true }),
  })
  .strict();

/** A repeating expression, which cannot be resolved without a zone. */
export const ScheduleCron = z
  .object({
    kind: z.literal('cron'),
    expression: z
      .string()
      .min(1)
      .max(200)
      .superRefine((value, ctx) => {
        const parsed = parseCron(value);
        if (!parsed.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
      }),
    /**
     * Required, with no default.
     *
     * A repeating "9am" with no zone is the bug in miniature: it would resolve
     * against whatever the container clock happens to be, which is UTC, which
     * is not where anybody is. Making it required means the question is answered
     * once, at the boundary, by something that knows the answer.
     */
    timezone: TimeZone,
  })
  .strict();

export const ScheduleSpec = z.discriminatedUnion('kind', [ScheduleOnce, ScheduleCron]);
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

/**
 * How far ahead a repeating expression is scanned before giving up.
 *
 * `0 0 30 2 *` — the thirtieth of February — parses perfectly and can never
 * fire. Without a bound this searches forever inside a tick loop, which is a
 * hung bridge rather than a rejected reminder. 400 days is comfortably past a
 * yearly expression's next turn while still ending.
 */
export const MAX_SCAN_DAYS = 400;

/** Iterations before the search gives up regardless. Belt to the day bound's braces. */
const MAX_STEPS = 500_000;

function startOfNextDay(wall: WallClock): WallClock {
  const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

function startOfNextMonth(wall: WallClock): WallClock {
  const next = new Date(Date.UTC(wall.year, wall.month, 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

function nextHour(wall: WallClock): WallClock {
  if (wall.hour >= 23) return startOfNextDay(wall);
  return { ...wall, hour: wall.hour + 1, minute: 0 };
}

function nextMinute(wall: WallClock): WallClock {
  if (wall.minute >= 59) return nextHour(wall);
  return { ...wall, minute: wall.minute + 1 };
}

/** Calendar order, ignoring the clock. Negative when `a` is the earlier date. */
function compareDate(a: WallClock, b: WallClock): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * The first moment this spec is due, strictly after `after`.
 *
 * Null means never: a one-off already in the past, or an expression like
 * `0 0 30 2 *` that no calendar satisfies. Null is a real answer here and the
 * callers treat it as one — an entry whose next occurrence is null is finished,
 * not broken.
 *
 * The search walks the calendar in *local* fields and converts only when it has
 * a match, rather than stepping instants and converting each one. That is what
 * makes it correct across a transition: "every day at 09:00" means the wall
 * clock, so the interval between two firings is 23 or 25 hours twice a year,
 * and an instant-stepping search would quietly deliver 08:00 or 10:00 instead.
 */
export function nextOccurrence(spec: ScheduleSpec, after: Date): Date | null {
  const from = after.getTime();
  if (!Number.isFinite(from)) return null;

  if (spec.kind === 'once') {
    const at = Date.parse(spec.at);
    if (!Number.isFinite(at)) return null;
    return at > from ? new Date(at) : null;
  }

  const parsed = parseCron(spec.expression);
  if (!parsed.ok) return null;
  const fields = parsed.fields;
  const zone = spec.timezone;
  if (!isTimeZone(zone)) return null;

  // Start at the next whole minute after `after`: cron has minute resolution,
  // and a candidate equal to `after` would re-fire the occurrence we just did.
  const start = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = wallClockAt(zone, from + MAX_SCAN_DAYS * 86_400_000);
  let wall = wallClockAt(zone, start);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (compareDate(wall, limit) > 0) return null;
    if (!fields.months.has(wall.month)) {
      wall = startOfNextMonth(wall);
      continue;
    }
    if (!dayMatches(fields, wall)) {
      wall = startOfNextDay(wall);
      continue;
    }
    if (!fields.hours.has(wall.hour)) {
      wall = nextHour(wall);
      continue;
    }
    if (!fields.minutes.has(wall.minute)) {
      wall = nextMinute(wall);
      continue;
    }

    const instant = wallClockToInstant(zone, wall);
    // A transition can map a later wall clock onto an earlier or equal instant
    // — the autumn overlap does exactly this. Stepping on rather than returning
    // keeps the sequence strictly increasing, which is what stops a repeat.
    if (instant > from) return new Date(instant);
    wall = nextMinute(wall);
  }
  return null;
}

/** One line describing what a spec will do, for an echo or a listing. */
export function describeSpec(spec: ScheduleSpec, zone: string): string {
  if (spec.kind === 'once') return formatLocal(Date.parse(spec.at), zone);
  return `"${spec.expression}" (${spec.timezone})`;
}

// ─── Saying when, in the words a person actually uses ────────────────────────

export type WhenParse = { ok: true; at: Date } | { ok: false; error: string };

/** What `parseWhen` accepts, quoted back whenever it refuses. */
export const WHEN_FORMS =
  'an exact instant like 2026-09-26T09:00:00Z, a date and time like "2026-09-26 09:00", ' +
  '"today 9am", "tomorrow 9am", "in 2 hours", or a bare time like "9am" for the next time it comes round';

/** `9am`, `9:30pm`, `21:30`, `noon`, `midnight`. Null when it is none of those. */
function parseClock(text: string): { hour: number; minute: number } | null {
  const value = text.trim().toLowerCase();
  if (value === 'noon' || value === 'midday') return { hour: 12, minute: 0 };
  if (value === 'midnight') return { hour: 0, minute: 0 };

  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(value);
  if (match === null) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute > 59) return null;

  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  }
  if (hour > 23) return null;
  return { hour, minute };
}

/** Add whole days to a wall clock without touching the time of day. */
function addDays(wall: WallClock, days: number): WallClock {
  const moved = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

/**
 * Turn the way a person says a time into an instant, in a named zone.
 *
 * Written for the shapes a model actually produces rather than for a grammar.
 * The one non-obvious rule is that **anything without an explicit offset is a
 * wall clock in `zone`** — "tomorrow 9am" from a Madrid conversation is 09:00
 * in Madrid, not 09:00 on the box. That is the entire bug this exists to close,
 * so it is the default rather than an option.
 *
 * A bare date with no time is taken as 09:00, which is a guess — and it is safe
 * to guess because every caller echoes the resolved instant back in words
 * before promising anything, so a wrong guess is visible immediately rather
 * than on the day.
 */
export function parseWhen(text: string, zone: string, now: Date = new Date()): WhenParse {
  const raw = text.trim();
  if (raw.length === 0) return { ok: false, error: `say when. I understand ${WHEN_FORMS}.` };
  if (!isTimeZone(zone)) return { ok: false, error: `"${zone}" is not a time zone I can resolve a time in.` };

  const lower = raw.toLowerCase();
  const at = now.getTime();

  // 1. An instant that already says which zone it is in. Nothing to resolve.
  if (/[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: `"${raw}" looks like an exact instant but is not one I can read.` };
    }
    return { ok: true, at: new Date(parsed) };
  }

  // 2. A relative offset. The only form with no wall clock in it at all, and
  //    therefore the only one a zone cannot change.
  const relative = /^in\s+(\d{1,5})\s*(minute|minutes|min|mins|hour|hours|hr|hrs|day|days)$/.exec(lower);
  if (relative !== null) {
    const count = Number(relative[1]);
    const unit = relative[2] as string;
    const ms = unit.startsWith('min') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
    return { ok: true, at: new Date(at + count * ms) };
  }

  const today = wallClockAt(zone, at);

  // 3. An explicit calendar date, with or without a time.
  const dated = /^(\d{4})-(\d{2})-(\d{2})(?:[t\s]+(.+))?$/.exec(lower);
  if (dated !== null) {
    const clock = dated[4] === undefined ? { hour: 9, minute: 0 } : parseClock(dated[4]);
    if (clock === null) {
      return { ok: false, error: `I read the date in "${raw}" but not the time. Try "2026-09-26 09:00".` };
    }
    const wall: WallClock = {
      year: Number(dated[1]),
      month: Number(dated[2]),
      day: Number(dated[3]),
      ...clock,
    };
    if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31) {
      return { ok: false, error: `"${raw}" is not a date that exists.` };
    }
    return { ok: true, at: new Date(wallClockToInstant(zone, wall)) };
  }

  // 4. today / tomorrow, with a time.
  const named = /^(today|tonight|tomorrow)(?:\s+(.+))?$/.exec(lower);
  if (named !== null) {
    const word = named[1] as string;
    const clock =
      named[2] === undefined ? { hour: word === 'tonight' ? 20 : 9, minute: 0 } : parseClock(named[2]);
    if (clock === null) {
      return { ok: false, error: `I read "${word}" but not the time after it. Try "${word} 9am".` };
    }
    const base = word === 'tomorrow' ? addDays(today, 1) : today;
    return { ok: true, at: new Date(wallClockToInstant(zone, { ...base, ...clock })) };
  }

  // 5. A bare time: the next time that clock face comes round.
  const clock = parseClock(lower);
  if (clock !== null) {
    const sameDay = wallClockToInstant(zone, { ...today, ...clock });
    if (sameDay > at) return { ok: true, at: new Date(sameDay) };
    return { ok: true, at: new Date(wallClockToInstant(zone, { ...addDays(today, 1), ...clock })) };
  }

  return { ok: false, error: `I cannot read "${raw}" as a time. I understand ${WHEN_FORMS}.` };
}

/**
 * Split `<when> <text>` out of an argument list.
 *
 * A shell splits on spaces and a model does not reliably quote, so
 * `remind tomorrow 9am "feed the cat"` and `remind "tomorrow 9am" "feed the
 * cat"` both arrive here and both have to work. Longest prefix wins, up to
 * three arguments, and at least one argument always has to be left over — so
 * "tomorrow" can never swallow the sentence by parsing on its own while
 * "tomorrow 9am" was meant.
 */
export function splitWhen(
  argv: readonly string[],
  zone: string,
  now: Date = new Date(),
): { ok: true; at: Date; when: string; text: string } | { ok: false; error: string } {
  if (argv.length < 2) {
    return {
      ok: false,
      error: `say when and what: \`remind "<when>" "<message>"\`. For when I understand ${WHEN_FORMS}.`,
    };
  }

  const longest = Math.min(3, argv.length - 1);
  for (let take = longest; take >= 1; take -= 1) {
    const when = argv.slice(0, take).join(' ');
    const parsed = parseWhen(when, zone, now);
    if (parsed.ok) return { ok: true, at: parsed.at, when, text: argv.slice(take).join(' ') };
  }

  // Report against the first argument alone, which is what the caller most
  // likely meant to be the time — a message about all three concatenated is
  // confusing rather than helpful.
  const first = parseWhen(argv[0] as string, zone, now);
  return { ok: false, error: first.ok ? `I could not tell when from "${argv.join(' ')}".` : first.error };
}
