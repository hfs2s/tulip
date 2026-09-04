/**
 * The arithmetic behind typing into the agent's terminal.
 *
 * Its own module rather than a function inside the supervisor, because the
 * supervisor starts a main loop the moment it is imported and this has to be
 * testable on its own. There is nothing here but a calculation.
 */

export interface TerminalKey {
  readonly text: string;
  readonly literal: boolean;
}

export interface IndexedKey extends TerminalKey {
  /** This key's position in the running total of everything ever sent. */
  readonly index: number;
}

/**
 * Which keys in a batch have not been typed yet.
 *
 * There is one request file and the bridge rewrites the whole of it — for a new
 * keystroke, and every thirty seconds to renew the watch. So it cannot send
 * only the newest key: anything the agent had not yet collected would be
 * overwritten and lost, which at a quarter-second tick is most of what somebody
 * types at speed. It sends a sliding window of recent keys instead, along with
 * `keySeq`, a running total of every key ever sent.
 *
 * That total is what makes the window safe to resend. The batch's first entry
 * has index `keySeq - keys.length + 1` and each subsequent entry follows, so a
 * key that has already been typed can be recognised however many times it comes
 * back. Per *key*, not per batch: a batch-level check would drop every
 * keystroke that arrived between two ticks.
 *
 * One off-by-one here duplicates a keystroke into a live conversation with a
 * member of the public, and the other swallows it. Hence the tests.
 */
export function keysToApply(
  keySeq: number,
  keys: readonly TerminalKey[],
  applied: number,
): IndexedKey[] {
  const firstIndex = keySeq - keys.length + 1;
  return keys
    .map((key, offset) => ({ index: firstIndex + offset, text: key.text, literal: key.literal }))
    .filter((key) => key.index > applied);
}
