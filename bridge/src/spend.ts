/**
 * Daily ceilings on the two capabilities that cost money per use.
 *
 * Everything else here is bounded per person: `turnsPerDay` caps what one
 * sender can spend, and that is the right shape for a closed allow list. It is
 * the wrong shape for a number open to the internet, where the bill is not one
 * person being expensive but a hundred people each being reasonable.
 *
 * So these are counted across everybody. A per-sender cap cannot bound a total,
 * and the total is what arrives as an invoice.
 *
 * Deliberately not a rate limit. There is no burst, no refill, no smoothing: a
 * day's allowance, spent in whatever order it arrives, and refused after that
 * until the day rolls. The failure mode is somebody being told "not today"
 * rather than a surprise, and that is the trade being made.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '@tulip/shared';
import { paths } from './paths.js';
import { log } from './log.js';

/** UTC, so the day rolls at the same instant regardless of where the box is. */
function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface Ledger {
  day: string;
  counts: Record<string, number>;
}

let ledger: Ledger | null = null;

function load(now: number): Ledger {
  if (ledger !== null && ledger.day === today(now)) return ledger;

  let loaded: Ledger = { day: today(now), counts: {} };
  try {
    if (existsSync(paths.spend)) {
      const parsed = JSON.parse(readFileSync(paths.spend, 'utf8')) as Partial<Ledger>;
      // A ledger from a previous day is not carried forward: the counts are the
      // point, and yesterday's are spent.
      if (parsed.day === loaded.day && typeof parsed.counts === 'object' && parsed.counts !== null) {
        loaded = { day: loaded.day, counts: parsed.counts as Record<string, number> };
      }
    }
  } catch {
    // A ledger we cannot read is a ledger we start again. The alternative is
    // refusing every paid capability because of a corrupt file, which is a
    // worse failure than a day's allowance being generous once.
    log('spend.unreadable', { note: 'starting today from zero' });
  }
  ledger = loaded;
  return ledger;
}

function persist(): void {
  if (ledger === null) return;
  try {
    writeJsonAtomic(paths.spend, ledger, 0o600);
  } catch (err) {
    log('spend.writeFailed', { err: String((err as Error).message) });
  }
}

/** How many of `meter` have been spent today. */
export function spentToday(meter: string, now = Date.now()): number {
  return load(now).counts[meter] ?? 0;
}

/**
 * Take one, if there is one left.
 *
 * Claimed before the work rather than after, so a slow provider cannot let two
 * requests through the same last unit. A failure afterwards costs the allowance
 * — which is the right way round: the money is spent when the request is made,
 * not when it succeeds.
 */
export function claim(meter: string, perDay: number, now = Date.now()): boolean {
  const state = load(now);
  const used = state.counts[meter] ?? 0;
  if (used >= perDay) {
    log('spend.refused', { meter, used, perDay });
    return false;
  }
  state.counts[meter] = used + 1;
  persist();
  return true;
}

/** Test seam: the ledger is module state and a test must not inherit another's. */
export function resetForTests(): void {
  ledger = null;
}
