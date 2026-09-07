/**
 * The spoken-language list and the sentences that demonstrate it.
 *
 * The panel's voice test bench speaks one line per language, and the failure it
 * would otherwise have is silent: a language added to `SPOKEN_LANGUAGES` with
 * no sample gets a row and a Play button that produces nothing, which reads as
 * a broken provider rather than as a missing string. So the pairing is asserted
 * here as well as in the type — a total `Record<SpokenLanguage, string>` already
 * makes the gap a compile error, and this is the same rule stated where someone
 * looking for it will find it.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGE_BOOSTS, LANGUAGE_LIMITS, LANGUAGE_SAMPLES, SPOKEN_LANGUAGES, isUnspoken, spokenLanguageFor } from '../src/languages.js';

describe('every spoken language can be heard', () => {
  it('has a sample sentence', () => {
    for (const row of SPOKEN_LANGUAGES) {
      const sample = LANGUAGE_SAMPLES[row.name];
      expect(sample, row.name).toBeTypeOf('string');
      expect(sample.trim().length, row.name).toBeGreaterThan(0);
    }
  });

  it('has no sample for a language nobody speaks', () => {
    // The other direction. A leftover line for a row that has been removed is
    // harmless but misleading — it looks like a language this deployment
    // supports and is nowhere in the list the panel renders.
    const spoken = new Set<string>(SPOKEN_LANGUAGES.map((l) => l.name));
    for (const name of Object.keys(LANGUAGE_SAMPLES)) {
      expect(spoken.has(name), name).toBe(true);
    }
  });

  it('sends a boost the provider accepts for every one of them', () => {
    // Restated from the bridge's own suite because the list lives here: a row
    // added with an invented boost fails the whole synthesis request, and the
    // voice note arrives as text with no explanation.
    for (const row of SPOKEN_LANGUAGES) {
      expect(LANGUAGE_BOOSTS as readonly string[], row.name).toContain(row.boost);
    }
  });
});

describe('the languages added alongside the original nine', () => {
  it('finds each of them by name', () => {
    for (const name of ['Dutch', 'German', 'Arabic', 'Mandarin', 'Russian', 'Japanese']) {
      expect(spokenLanguageFor(name)?.name, name).toBe(name);
    }
  });

  it('offers no row for a language this deployment will not speak', () => {
    // Removing a row is only half of withdrawing a language. It takes the
    // voice field out of the panel; it does not stop the language being read
    // aloud, because `resolveVoice` falls through to the raw boost and the
    // default voice. Both halves are asserted together here so neither can be
    // done without the other.
    //
    // Swedish is deliberately NOT in this list. It is unspoken too, but it
    // keeps its row and its limitation note — see the next test. Adding it here
    // has twice cost the operator a language they never asked to lose.
    for (const withdrawn of ['Vietnamese', 'Turkish']) {
      expect(spokenLanguageFor(withdrawn), withdrawn).toBeNull();
      expect(isUnspoken(withdrawn), withdrawn).toBe(true);
      // Still a value the provider accepts: written replies are unaffected, and
      // the boost list is a transcription of its reference, not our opinion.
      expect(LANGUAGE_BOOSTS as readonly string[], withdrawn).toContain(withdrawn);
    }
  });

  it('recognises a withdrawn language however it is cased', () => {
    // Defence in depth. `LanguageBoost` matches the provider's list exactly, so
    // a miscased value is refused long before this — but this list is the last
    // thing standing between a withdrawn language and a voice note, and it
    // should not depend on an upstream check staying strict.
    for (const cased of ['swedish', 'SWEDISH', ' Swedish ', 'vietnamese']) {
      expect(isUnspoken(cased), cased).toBe(true);
    }
    expect(isUnspoken('Spanish')).toBe(false);
  });

  it('speaks every language it offers a row for, except the one that says so', () => {
    // The other direction, and the one that stops the unspoken list growing by
    // accident: a row the bridge would refuse to speak is a control that
    // changes nothing — *unless* the row itself explains why, which is what
    // LANGUAGE_LIMITS is for.
    //
    // Swedish is that case and the only one permitted to be: it has a real
    // boost and no voice at all, so the row is worth showing and the audio is
    // withheld. The pairing is asserted rather than the exception waived — a
    // row that is silent without a note beside it is the bug this guards.
    for (const row of SPOKEN_LANGUAGES) {
      if (LANGUAGE_LIMITS[row.name]?.voiceless === true) {
        expect(isUnspoken(row.boost), row.name).toBe(true);
        expect(LANGUAGE_LIMITS[row.name]?.note.length, row.name).toBeGreaterThan(0);
        continue;
      }
      expect(isUnspoken(row.boost), row.name).toBe(false);
    }
  });

  it('sends Mandarin as the provider spells it', () => {
    // The row is named for what the agent says; `Chinese` is what the request
    // carries. Cantonese is a different value — `Chinese,Yue` — and has no row,
    // so it must not quietly land on this one.
    expect(spokenLanguageFor('Mandarin')?.boost).toBe('Chinese');
    expect(spokenLanguageFor('Chinese')?.name).toBe('Mandarin');
    expect(spokenLanguageFor('Cantonese')).toBeNull();
  });
});
