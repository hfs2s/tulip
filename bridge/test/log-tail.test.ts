/**
 * The Logs page's reader.
 *
 * The log writer names one file per **UTC** day, and the panel's reader used to
 * open exactly one of them: today's. Every UTC midnight the Logs page therefore
 * went blank — 02:00 for an operator in CEST, mid-evening — and stayed blank
 * until the next line happened to be written, with the whole of the previous day
 * sitting unreachable in a file right beside the one being read. `?n=200` could
 * never be satisfied across that boundary either.
 *
 * So these tests are mostly about the day *before* the one the clock says: the
 * second case is the regression, and it returned `[]` before the fix.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-logs-'));
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { logTail } = await import('../src/panel-api.js');
const { paths } = await import('../src/paths.js');

/** The writer's own naming, `offset` days from now. UTC, exactly as `log.ts`. */
const day = (offset: number): string =>
  `tulip-${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}.jsonl`;

const writeDay = (name: string, events: string[]): void => {
  mkdirSync(paths.logs, { recursive: true });
  writeFileSync(join(paths.logs, name), events.map((e) => `${JSON.stringify({ at: '', event: e })}\n`).join(''));
};

const events = (rows: unknown): string[] => (rows as Array<{ event: string }>).map((r) => r.event);

// Removed rather than emptied: one case is about the directory not being there
// at all, which is the state of a deployment that has not logged yet.
beforeEach(() => rmSync(paths.logs, { recursive: true, force: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('one day', () => {
  it('returns the newest rows, oldest first', () => {
    writeDay(day(0), ['one', 'two', 'three', 'four', 'five']);
    expect(events(logTail(3))).toEqual(['three', 'four', 'five']);
  });

  it('returns everything when there is less than asked for', () => {
    writeDay(day(0), ['only']);
    expect(events(logTail(200))).toEqual(['only']);
  });
});

describe('across midnight', () => {
  it("reads yesterday when today's file does not exist yet", () => {
    // The observed failure: at 00:02 UTC the directory holds yesterday and the
    // day before, nothing has been written since the boundary, and the panel
    // showed an empty page indistinguishable from a broken deployment.
    writeDay(day(-1), ['before midnight']);
    expect(events(logTail(200))).toEqual(['before midnight']);
  });

  it('spans two files in order, truncated to what was asked for', () => {
    writeDay(day(-1), ['y1', 'y2', 'y3']);
    writeDay(day(0), ['t1', 't2']);
    expect(events(logTail(4))).toEqual(['y2', 'y3', 't1', 't2']);
  });

  it('does not reach further back than the cap, however much is asked for', () => {
    for (let i = 0; i < 6; i += 1) writeDay(day(-i), [`day-${String(i)}`]);
    // Three files is enough to cross a midnight; a year of them is a request
    // that reads the whole disk.
    expect(events(logTail(1000))).toEqual(['day-2', 'day-1', 'day-0']);
  });
});

describe('what it will not choke on', () => {
  it('keeps a line it cannot parse, rather than dropping the tail with it', () => {
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(join(paths.logs, day(0)), `${JSON.stringify({ at: '', event: 'fine' })}\n{ half a li\n`);
    expect(logTail(10)).toEqual([
      { at: '', event: 'fine' },
      { at: '', event: 'unparsed', raw: '{ half a li' },
    ]);
  });

  it('ignores files that are not day files', () => {
    writeDay(day(0), ['real']);
    writeFileSync(join(paths.logs, 'tulip.jsonl'), '{"at":"","event":"stray"}\n');
    writeFileSync(join(paths.logs, 'notes.txt'), 'not a log at all\n');
    expect(events(logTail(200))).toEqual(['real']);
  });

  it('is empty when the directory is not there, rather than throwing', () => {
    expect(logTail(200)).toEqual([]);
  });
});
