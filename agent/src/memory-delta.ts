/**
 * What this session has not yet been told it knows.
 *
 * The shared memory reaches a chat through its `CLAUDE.md`, which is written
 * once, when the session spawns. That was the whole of it, and it meant a note
 * recorded in one conversation did not reach another until that other session
 * next restarted — up to `TULIP_SESSION_IDLE_MS`, four hours on this
 * deployment. Long enough that Tulip could be told something in the morning and
 * still not know it that afternoon, in a chat that had been open the whole time.
 *
 * So the brief carries the memory as it stood at spawn, and the prompt hook
 * tops up the difference on each turn. This is the arithmetic for the
 * difference, kept apart from the hook because the hook writes files and exits
 * a process, and this is the part worth testing.
 *
 * The marker is a note id rather than a count. Counts lie here: the store drops
 * its oldest note once it holds two hundred, so "I had seen 30" stays true
 * while meaning something different an hour later.
 */

export interface Note {
  readonly id: string;
  readonly text: string;
}

/**
 * How many notes one turn will carry at most.
 *
 * A session that has been idle for a long time can wake to a great many new
 * notes, and pasting all of them into a single turn buys nothing — the point is
 * that Tulip is current, not that it re-reads its whole memory. Past this the
 * newest are kept, because the oldest are the ones most likely already in the
 * brief.
 */
export const MAX_CATCHUP = 20;

export interface Delta {
  /** Notes to hand to this turn, oldest first. */
  readonly notes: Note[];
  /** The id to remember having seen. Null when there is nothing at all. */
  readonly tip: string | null;
  /** True when older notes were skipped to stay within the cap. */
  readonly truncated: boolean;
}

/**
 * The notes recorded since `seen`, newest last.
 *
 * `seen` null means nothing has been seen yet, which happens only before the
 * first marker is written; everything counts as new. A `seen` that is no longer
 * in the store is the interesting case — it has aged out, so the honest answer
 * is "more than I can show you", and the cap does the rest.
 */
export function notesSince(notes: readonly Note[], seen: string | null, cap = MAX_CATCHUP): Delta {
  const tip = notes.length > 0 ? (notes[notes.length - 1]?.id ?? null) : null;
  if (notes.length === 0) return { notes: [], tip: null, truncated: false };

  const at = seen === null ? -1 : notes.findIndex((n) => n.id === seen);
  // Not found means it has rolled off the end of the store, so everything held
  // is newer than the last thing this session saw.
  const fresh = notes.slice(at === -1 ? 0 : at + 1);
  if (fresh.length === 0) return { notes: [], tip, truncated: false };

  return {
    notes: fresh.slice(-cap),
    tip,
    truncated: fresh.length > cap,
  };
}

/**
 * The block handed to the model, or null when there is nothing to say.
 *
 * Framed as something it already knows rather than as a message from anybody.
 * A note arrived from another conversation, and the one thing Tulip must not do
 * is repeat it back as though the person in *this* chat had said it — which is
 * exactly what "here is some new information" would invite.
 */
export function catchUpText(delta: Delta): string | null {
  if (delta.notes.length === 0) return null;
  const lines = delta.notes.map((n) => `- ${n.text}`).join('\n');
  const elided = delta.truncated ? ' (older ones are omitted; they are already in your brief)' : '';
  return (
    'Things you have come to know since this conversation started. They are ' +
    'part of your memory, shared across every conversation — treat them as ' +
    'things you already know, not as something anybody here just told you, and ' +
    'never in a way that reveals which chat they came from.' +
    `${elided}\n\n${lines}`
  );
}
