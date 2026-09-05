/**
 * A voice per language.
 *
 * One mouth for eight languages is one mouth that is wrong for seven of them.
 * The map is keyed on what the agent *says* rather than on what goes to the
 * provider, and Cebuano is why: it and Filipino send the same boost, because
 * there is one Austronesian voice family, but an operator may still want a
 * different voice reading each. Collapsing them before the lookup would make
 * that unsayable.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGE_BOOSTS, spokenLanguageFor, SPOKEN_LANGUAGES } from '@tulip/shared';

describe('finding the row', () => {
  it('takes the eight languages by name, however capitalised', () => {
    for (const row of SPOKEN_LANGUAGES) {
      expect(spokenLanguageFor(row.name)?.name, row.name).toBe(row.name);
      expect(spokenLanguageFor(row.name.toLowerCase())?.name, row.name).toBe(row.name);
    }
  });

  it('keeps Cebuano and Filipino apart, while sending the same boost', () => {
    const ceb = spokenLanguageFor('Cebuano');
    const fil = spokenLanguageFor('Filipino');
    expect(ceb?.name).toBe('Cebuano');
    expect(fil?.name).toBe('Filipino');
    // Same mouth as far as the provider is concerned; different rows here.
    expect(ceb?.boost).toBe('Filipino');
    expect(fil?.boost).toBe('Filipino');
  });

  it('lands the regional Visayan names on Cebuano, not on Filipino', () => {
    // These alias to Filipino for the API, and would have been folded into the
    // Filipino row before anybody could choose a voice for them.
    for (const name of ['Bisaya', 'binisaya', 'Visayan']) {
      expect(spokenLanguageFor(name)?.name, name).toBe('Cebuano');
    }
    // Tagalog is Filipino proper, and stays there.
    expect(spokenLanguageFor('Tagalog')?.name).toBe('Filipino');
  });

  it('follows an alias to the row it belongs to', () => {
    expect(spokenLanguageFor('Valencian')?.name).toBe('Catalan');
    expect(spokenLanguageFor('Castilian')?.name).toBe('Spanish');
    expect(spokenLanguageFor('brazilian')?.name).toBe('Portuguese');
  });

  it('is null for a language this deployment does not speak', () => {
    // Valid for the provider, but not one of the eight — so there is no row and
    // no voice, and the caller falls back to the default rather than guessing.
    expect(spokenLanguageFor('Japanese')).toBeNull();
    expect(spokenLanguageFor('Klingon')).toBeNull();
    expect(spokenLanguageFor('')).toBeNull();
    expect(spokenLanguageFor('   ')).toBeNull();
  });

  it('every row sends a boost the provider accepts', () => {
    // The two lists are separate and could drift; this is what stops a row
    // being added with a boost that fails the whole request.
    for (const row of SPOKEN_LANGUAGES) {
      expect(LANGUAGE_BOOSTS as readonly string[], row.name).toContain(row.boost);
    }
  });
});
