/**
 * Typing into the agent's terminal, exactly once each.
 *
 * There is one request file and the bridge rewrites the whole of it — for a new
 * keystroke, and every thirty seconds to renew the watch. So the bridge cannot
 * send just the newest key: anything the agent had not yet collected would be
 * overwritten and lost, which at a 250ms tick is most of what somebody types at
 * speed. It sends a sliding window of recent keys and a running total instead,
 * and this is the half that decides which of them are new.
 *
 * The arithmetic is the whole feature. One off-by-one duplicates a keystroke
 * into a live conversation with a member of the public; the other swallows it.
 */
import { describe, expect, it } from 'vitest';
import { keysToApply } from '../src/terminal.js';

const k = (text: string, literal = true): { text: string; literal: boolean } => ({ text, literal });
const texts = (applied: Array<{ text: string }>): string[] => applied.map((a) => a.text);

describe('keysToApply — a batch nobody has seen', () => {
  it('applies every key when nothing has been applied', () => {
    expect(texts(keysToApply(3, [k('a'), k('b'), k('c')], 0))).toEqual(['a', 'b', 'c']);
  });

  it('numbers keys from the running total, not from zero', () => {
    // keySeq 10 with three keys means these are keys 8, 9 and 10.
    expect(keysToApply(10, [k('x'), k('y'), k('z')], 7).map((a) => a.index)).toEqual([8, 9, 10]);
  });

  it('applies a single key', () => {
    expect(texts(keysToApply(1, [k('a')], 0))).toEqual(['a']);
  });
});

describe('keysToApply — the same window, sent again', () => {
  it('applies nothing when the whole window has been typed', () => {
    expect(keysToApply(3, [k('a'), k('b'), k('c')], 3)).toHaveLength(0);
  });

  it('applies only the tail when the window overlaps what was typed', () => {
    // The bridge resent a, b, c and the agent had already typed a and b.
    expect(texts(keysToApply(3, [k('a'), k('b'), k('c')], 2))).toEqual(['c']);
  });

  it('is idempotent — a watch refresh mid-tick types nothing twice', () => {
    const keys = [k('h'), k('i')];
    const first = keysToApply(2, keys, 0);
    expect(texts(first)).toEqual(['h', 'i']);

    const applied = first[first.length - 1]?.index ?? 0;
    expect(keysToApply(2, keys, applied)).toHaveLength(0);
  });

  it('applies nothing from a stale request left behind by a restart', () => {
    // The agent restarted and re-read a file whose keys it had already typed.
    expect(keysToApply(5, [k('old')], 9)).toHaveLength(0);
  });
});

describe('keysToApply — the window sliding', () => {
  it('applies the new keys when older ones have fallen out of the window', () => {
    // Keys 1 and 2 have dropped off; the window now holds 3, 4 and 5.
    expect(texts(keysToApply(5, [k('c'), k('d'), k('e')], 3))).toEqual(['d', 'e']);
  });

  it('does not resurrect a key that fell out of the window unapplied', () => {
    // Keys 4 through 6 are on offer and 3 was never typed. It is gone: there is
    // nothing here that could type it, and inventing one would type the wrong
    // character. Bounding the loss is the bridge's job, not this function's.
    const applied = keysToApply(6, [k('d'), k('e'), k('f')], 2);
    expect(texts(applied)).toEqual(['d', 'e', 'f']);
    expect(applied[0]?.index).toBe(4);
  });
});

describe('keysToApply — degenerate input', () => {
  it('applies nothing for an empty batch', () => {
    // Sent on every watch refresh before anyone has typed anything.
    expect(keysToApply(0, [], 0)).toHaveLength(0);
  });

  it('applies nothing for an empty batch after keys have been typed', () => {
    expect(keysToApply(7, [], 7)).toHaveLength(0);
  });

  it('carries the literal flag through untouched', () => {
    // `literal` decides between typing text and naming a key, so losing it
    // turns an Enter into the four characters E, n, t, e, r.
    const applied = keysToApply(2, [k('hello', true), k('Enter', false)], 0);
    expect(applied.map((a) => a.literal)).toEqual([true, false]);
  });
});
