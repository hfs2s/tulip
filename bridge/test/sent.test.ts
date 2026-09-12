/**
 * The store that makes a correction possible, and the bound that makes it safe.
 *
 * Two separate things are being tested here and they fail differently:
 *
 *   - **Resolution.** `edit -n 2` has to reach the message the agent counted to
 *     and no other. Off by one and it rewords somebody's answer to a different
 *     question, silently, from the agent's point of view successfully.
 *   - **Containment.** Positions are the only handle the agent gets, and they
 *     are scoped per chat. A position that resolved across conversations would
 *     hand the untrusted side a way to edit a message in a chat it is not in —
 *     which is the property THREAT-MODEL §T4 exists to protect.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sent } from '../src/sent.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

let dir: string;
let file: string;
let sent: Sent;

beforeEach(() => {
  // Its own file per test rather than the module-level store, so nothing here
  // depends on the order the suite happens to run in.
  dir = mkdtempSync(join(tmpdir(), 'tulip-sent-'));
  file = join(dir, 'sent.json');
  sent = new Sent(file);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolving a position', () => {
  it('counts backwards from the most recent, 1-based', () => {
    sent.record(A, 'id-first', 'text', 'first');
    sent.record(A, 'id-second', 'text', 'second');
    sent.record(A, 'id-third', 'text', 'third');

    expect(sent.nth(A, 1)?.text).toBe('third');
    expect(sent.nth(A, 2)?.text).toBe('second');
    expect(sent.nth(A, 3)?.text).toBe('first');
  });

  it('returns nothing rather than the nearest row for a position past the end', () => {
    // The refusal is the point: "you have not said that many things" is a
    // correctable mistake, and editing whatever happens to be last is not.
    sent.record(A, 'id-one', 'text', 'only');
    expect(sent.nth(A, 2)).toBeNull();
    expect(sent.nth(A, 99)).toBeNull();
  });

  it('refuses a position that is not a positive whole number', () => {
    sent.record(A, 'id-one', 'text', 'only');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(sent.nth(A, bad), String(bad)).toBeNull();
    }
  });
});

describe('the bound between conversations', () => {
  /**
   * The containment property, stated as a test rather than as a comment.
   *
   * Positions are per chat. If they were global, a message arriving in one
   * conversation could talk the agent into a position that lands in another —
   * and the agent would have no way to know it had.
   */
  it('never resolves a position into another chat', () => {
    sent.record(A, 'id-a', 'text', 'said in A');
    sent.record(B, 'id-b', 'text', 'said in B');

    expect(sent.nth(A, 1)?.text).toBe('said in A');
    expect(sent.nth(B, 1)?.text).toBe('said in B');
    // One message each: a second position exists in neither.
    expect(sent.nth(A, 2)).toBeNull();
    expect(sent.nth(B, 2)).toBeNull();
  });

  it('ignores a chat key that is not one', () => {
    sent.record('../../etc', 'id-x', 'text', 'nope');
    sent.record('', 'id-y', 'text', 'nope');
    expect(sent.recent('../../etc')).toEqual([]);
  });
});

describe('what is recorded', () => {
  it('skips a send whose id never came back, rather than throwing', () => {
    // A send can succeed while the acknowledgement carrying the key does not
    // arrive. The message is delivered; it simply cannot be corrected. Throwing
    // here would fail a turn *after* the words had already gone out.
    expect(() => sent.record(A, null, 'text', 'went out')).not.toThrow();
    expect(() => sent.record(A, undefined as unknown as null, 'text', 'went out')).not.toThrow();
    expect(() => sent.record(A, '', 'text', 'went out')).not.toThrow();
    expect(sent.recent(A)).toEqual([]);
  });

  it('keeps media, so it can be retracted even though it cannot be reworded', () => {
    sent.record(A, 'id-pic', 'image', null);
    expect(sent.nth(A, 1)?.kind).toBe('image');
  });
});

describe('after a correction', () => {
  it('keeps what a message said before it was edited', () => {
    sent.record(A, 'id-one', 'text', 'Tuesday');
    sent.edited(A, 'id-one', 'Thursday');

    const row = sent.nth(A, 1);
    expect(row?.text).toBe('Thursday');
    expect(row?.wasText).toEqual(['Tuesday']);
  });

  it('accumulates every earlier version, not just the last', () => {
    sent.record(A, 'id-one', 'text', 'one');
    sent.edited(A, 'id-one', 'two');
    sent.edited(A, 'id-one', 'three');
    expect(sent.nth(A, 1)?.wasText).toEqual(['one', 'two']);
  });

  /**
   * A retracted message stops being offered but does not stop existing.
   *
   * Both halves matter. Still offering it would make `edit 1` mean "edit the
   * thing I just deleted"; forgetting it would break the audit trail, which is
   * the reason the operator agreed to this capability at all.
   */
  it('stops offering a retracted message, and renumbers what is left', () => {
    sent.record(A, 'id-one', 'text', 'first');
    sent.record(A, 'id-two', 'text', 'second');
    sent.retracted(A, 'id-two');

    expect(sent.nth(A, 1)?.text).toBe('first');
    expect(sent.recent(A).map((r) => r.text)).toEqual(['first']);
  });
});

describe('persistence', () => {
  /**
   * The difference from `lastInbound`, which `react` uses and which is
   * deliberately memory-only. A correction is most wanted for something said
   * minutes ago; turns are separate processes and a restart in between is
   * ordinary. A store that forgot on restart would be useless exactly when it
   * was needed.
   */
  it('survives a restart', () => {
    sent.record(A, 'id-one', 'text', 'still here');

    // A second instance over the same file is what a restart is.
    expect(new Sent(file).nth(A, 1)?.text).toBe('still here');
  });

  it('starts empty rather than throwing when the file is unreadable', () => {
    expect(new Sent(join(dir, 'does-not-exist.json')).recent(A)).toEqual([]);
  });

  it('numbers rows by their feed uid, so a listing and a correction agree', () => {
    sent.record(A, 'id-one', 'text', 'first', 'uid-1');
    sent.record(A, 'id-two', 'text', 'second', 'uid-2');

    const slots = sent.positions(A);
    // Newest is 1, matching what `nth` resolves — the two countings must not
    // drift apart, or the number an operator reads edits a different message.
    expect(slots.get('uid-2')).toBe(1);
    expect(slots.get('uid-1')).toBe(2);
    expect(sent.nth(A, slots.get('uid-1') as number)?.text).toBe('first');
  });
});
