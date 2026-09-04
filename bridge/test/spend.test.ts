/**
 * The daily ceilings on the two capabilities billed per use.
 *
 * These are the only limits counted across everybody rather than per sender,
 * and that is the whole point: `turnsPerDay` bounds one person, and the bill on
 * a number open to the internet is not one person being expensive.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-spend-'));
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { claim, spentToday, resetForTests } = await import('../src/spend.js');
const { paths } = await import('../src/paths.js');

const DAY = Date.UTC(2026, 8, 4, 12, 0, 0);
const NEXT = DAY + 24 * 60 * 60 * 1000;

beforeEach(() => { resetForTests(); rmSync(paths.spend, { force: true }); });

describe('a day’s allowance', () => {
  it('is spent one at a time and then refused', () => {
    expect(claim('images', 2, DAY)).toBe(true);
    expect(claim('images', 2, DAY)).toBe(true);
    expect(claim('images', 2, DAY)).toBe(false);
    expect(spentToday('images', DAY)).toBe(2);
  });

  it('is per meter, so pictures and transcriptions do not share one', () => {
    claim('images', 1, DAY);
    expect(claim('transcriptions', 1, DAY)).toBe(true);
  });

  it('refuses everything at zero, which is how a capability is switched off', () => {
    expect(claim('images', 0, DAY)).toBe(false);
    expect(spentToday('images', DAY)).toBe(0);
  });

  it('rolls over, rather than carrying yesterday forward', () => {
    claim('images', 1, DAY);
    expect(claim('images', 1, DAY)).toBe(false);
    expect(claim('images', 1, NEXT)).toBe(true);
  });
});

describe('durability', () => {
  it('survives a restart, because a process that forgets is a cap that resets', () => {
    claim('images', 5, DAY);
    claim('images', 5, DAY);
    resetForTests(); // as if the bridge had restarted
    expect(spentToday('images', DAY)).toBe(2);
    expect(claim('images', 2, DAY)).toBe(false);
  });

  it('starts today from zero when the ledger cannot be read', () => {
    writeFileSync(paths.spend, 'not json at all');
    resetForTests();
    // A corrupt ledger must not refuse every paid capability: one generous day
    // is a better failure than a dead one.
    expect(claim('images', 1, DAY)).toBe(true);
  });

  it('ignores a ledger from another day rather than trusting its counts', () => {
    writeFileSync(paths.spend, JSON.stringify({ day: '2020-01-01', counts: { images: 999 } }));
    resetForTests();
    expect(spentToday('images', DAY)).toBe(0);
  });
});
