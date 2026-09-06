/**
 * Keeping one memory current across sessions that cannot see each other.
 *
 * Each chat has its own session and its own brief, and the brief carries the
 * shared memory as it stood when that session spawned. Before this, that was
 * the only time it was ever read — so a note recorded in one conversation did
 * not reach another until the other restarted, up to four hours later on this
 * deployment. Tulip is meant to know the same things everywhere; a memory that
 * arrives that late is a different assistant with the same voice.
 *
 * The arithmetic below decides what a turn is told. Its two failure modes are
 * opposite and both bad: repeat what the brief already contains and every first
 * turn pays for the whole store twice, or skip a note and Tulip is confidently
 * out of date with no way to notice.
 */
import { describe, expect, it } from 'vitest';
import { MAX_CATCHUP, catchUpText, notesSince } from '../src/memory-delta.js';

const notes = (...texts: string[]): Array<{ id: string; text: string }> =>
  texts.map((text, i) => ({ id: `n${i + 1}`, text }));

describe('notesSince', () => {
  it('sends nothing when nothing has been recorded', () => {
    const d = notesSince([], null);
    expect(d.notes).toEqual([]);
    expect(d.tip).toBeNull();
  });

  it('sends nothing when the session has already seen the newest note', () => {
    // The ordinary turn. It must cost nothing.
    const all = notes('a', 'b', 'c');
    expect(notesSince(all, 'n3').notes).toEqual([]);
  });

  it('sends only what arrived after the last one seen', () => {
    const all = notes('a', 'b', 'c', 'd');
    expect(notesSince(all, 'n2').notes.map((n) => n.text)).toEqual(['c', 'd']);
  });

  it('reports the newest id as the tip, so the marker can move', () => {
    expect(notesSince(notes('a', 'b'), 'n1').tip).toBe('n2');
  });

  it('reports a tip even when there is nothing new', () => {
    // Otherwise a session that never receives a note never records a marker,
    // and the first note it does see arrives alongside the entire history.
    expect(notesSince(notes('a', 'b'), 'n2').tip).toBe('n2');
  });

  it('sends everything when the session has seen nothing', () => {
    // Only before a marker exists. The spawn writes one, so in practice this is
    // a session older than the marker rather than a new one.
    expect(notesSince(notes('a', 'b'), null).notes.map((n) => n.text)).toEqual(['a', 'b']);
  });
});

describe('notesSince — when the marker has aged out', () => {
  it('treats an id no longer in the store as everything being new', () => {
    // The store keeps two hundred notes and drops the oldest. A marker pointing
    // at one that has gone cannot be positioned, and the safe answer is to
    // resend rather than to skip: a repeat is noise, a gap is Tulip being wrong.
    const all = notes('c', 'd', 'e');
    expect(notesSince(all, 'n-long-gone').notes.map((n) => n.text)).toEqual(['c', 'd', 'e']);
  });

  it('caps the catch-up and says it did', () => {
    const many = Array.from({ length: MAX_CATCHUP + 5 }, (_, i) => ({ id: `n${i}`, text: `note ${i}` }));
    const d = notesSince(many, null);
    expect(d.notes).toHaveLength(MAX_CATCHUP);
    expect(d.truncated).toBe(true);
  });

  it('keeps the newest when it caps, not the oldest', () => {
    // The oldest are the ones most likely already in the brief.
    const many = Array.from({ length: MAX_CATCHUP + 3 }, (_, i) => ({ id: `n${i}`, text: `note ${i}` }));
    const d = notesSince(many, null);
    expect(d.notes[d.notes.length - 1]?.text).toBe(`note ${MAX_CATCHUP + 2}`);
    expect(d.tip).toBe(`n${MAX_CATCHUP + 2}`);
  });

  it('does not claim truncation when everything fits', () => {
    expect(notesSince(notes('a', 'b'), null).truncated).toBe(false);
  });
});

describe('catchUpText', () => {
  it('says nothing when there is nothing', () => {
    expect(catchUpText({ notes: [], tip: null, truncated: false })).toBeNull();
  });

  it('frames a note as something already known, not as a message', () => {
    // The one thing that must not happen: repeating a note back as though the
    // person in *this* chat had just said it.
    const text = catchUpText(notesSince(notes('Les prefers voice notes'), null)) ?? '';
    expect(text).toContain('Les prefers voice notes');
    expect(text).toContain('things you already know');
    expect(text).toContain('never in a way that reveals which chat');
  });

  it('never names the chat a note came from', () => {
    // The note records its source for the operator's audit; the agent is told
    // the text and nothing else.
    const text = catchUpText(notesSince(notes('a decision was made'), null)) ?? '';
    expect(text).not.toMatch(/chatKey|17f1f7d2|@lid/);
  });

  it('admits when it left older ones out', () => {
    const many = Array.from({ length: MAX_CATCHUP + 2 }, (_, i) => ({ id: `n${i}`, text: `note ${i}` }));
    expect(catchUpText(notesSince(many, null))).toContain('older ones are omitted');
  });
});
