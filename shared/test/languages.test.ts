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
import { LANGUAGE_BOOSTS, LANGUAGE_SAMPLES, SPOKEN_LANGUAGES, spokenLanguageFor } from '../src/languages.js';

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
    for (const name of ['Dutch', 'German', 'Swedish', 'Turkish', 'Arabic', 'Mandarin', 'Russian', 'Japanese', 'Vietnamese']) {
      expect(spokenLanguageFor(name)?.name, name).toBe(name);
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
