/**
 * Lifting flags off a command line whose remainder gets spoken aloud.
 *
 * `tulip-wa voice` reads everything left over into a recording and sends it to
 * somebody. That has already gone wrong once — a flag and a chat key were
 * recited into a voice note and delivered to the wrong person — which is why
 * `strayFlag` exists as a backstop and why the order matters: every flag must
 * be lifted *before* the backstop runs, or the backstop is what catches it and
 * the agent is told its own valid flag is not an option.
 *
 * So these tests are less about parsing than about two failure modes: a flag
 * that gets spoken, and a chat key that reaches the wrong conversation.
 */
import { describe, expect, it } from 'vitest';
import { strayFlag, takeDestination, takeLanguage } from '../src/cli-args.js';

const ok = <T>(r: { ok: boolean }): r is { ok: true; value: T; rest: string[] } => r.ok;

describe('takeLanguage', () => {
  it('lifts the flag and its value out of what will be spoken', () => {
    const r = takeLanguage(['--language', 'Spanish', 'vale,', 'ahora'], 'voice');
    expect(ok<string>(r) && r.value).toBe('Spanish');
    expect(ok<string>(r) && r.rest).toEqual(['vale,', 'ahora']);
  });

  /**
   * Required, not defaulted. One setting for the whole deployment is wrong for
   * somebody the moment two conversations are in two languages, and wrong
   * silently: the voice note arrives, it just sounds foreign.
   */
  it('refuses a voice note that does not say which language it is in', () => {
    const r = takeLanguage(['hola', 'que', 'tal'], 'voice');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('--language is required');
    // The error carries the reason and where to look, because it is the only
    // thing the agent will read at the moment it needs to know.
    expect(!r.ok && r.message).toContain('Malay');
    expect(!r.ok && r.message).toContain('tulip-wa languages');
  });

  it('lifts it from the middle, not just the front', () => {
    // Nothing makes the agent put it first, and a flag left in the middle is a
    // flag that gets read out.
    const r = takeLanguage(['sige', '--language', 'Filipino', 'na'], 'voice');
    expect(ok<string>(r) && r.rest).toEqual(['sige', 'na']);
  });

  it('refuses a language that is not one and has no near-name', () => {
    const r = takeLanguage(['--language', 'Klingon', 'hola'], 'voice');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain('tulip-wa languages');
  });

  it('takes it however it is capitalised', () => {
    // "filipino" and "Filipino" are the same intention, and refusing one of
    // them teaches nothing — the provider's exact spelling is returned either
    // way, because that is what has to go on the wire.
    for (const typed of ['spanish', 'SPANISH', 'Spanish']) {
      const r = takeLanguage(['--language', typed, 'hola'], 'voice');
      expect(ok<string>(r) && r.value, typed).toBe('Spanish');
    }
  });

  /**
   * The failure this exists for. Juan is learning Bisaya, so "Bisaya" and
   * "Cebuano" are the words in front of him — and the provider knows neither,
   * refusing the request outright rather than degrading. Filipino is the
   * nearest mouth it has, and far nearer than English.
   */
  it('translates the name the agent would actually reach for', () => {
    for (const [typed, expected] of [
      ['Bisaya', 'Filipino'],
      ['Cebuano', 'Filipino'],
      ['Tagalog', 'Filipino'],
      ['Valencian', 'Catalan'],
      ['Castilian', 'Spanish'],
      ['Cantonese', 'Chinese,Yue'],
      ['Farsi', 'Persian'],
    ] as const) {
      const r = takeLanguage(['--language', typed, 'kumusta'], 'voice');
      expect(ok<string>(r) && r.value, typed).toBe(expected);
    }
  });

  it('never renames something the provider already accepts', () => {
    // An exact member wins before an alias is consulted, so no entry in the
    // alias table can shadow a real language by sharing its name.
    for (const real of ['Malay', 'Indonesian', 'Filipino', 'Catalan', 'Chinese,Yue', 'auto']) {
      const r = takeLanguage(['--language', real, 'x'], 'voice');
      expect(ok<string>(r) && r.value, real).toBe(real);
    }
  });

  it('refuses the flag with nothing after it', () => {
    // Otherwise the value is `undefined` and the word after it — which is the
    // message — becomes the language.
    expect(takeLanguage(['--language'], 'voice').ok).toBe(false);
  });

  it('does not swallow the next flag as its value', () => {
    const r = takeLanguage(['--language', '--to', 'hola'], 'voice');
    expect(r.ok).toBe(false);
  });
});

describe('takeDestination and takeLanguage together', () => {
  it('lifts both, in either order, leaving only the words', () => {
    for (const argv of [
      ['--to', '17f1f7d2c1a600d2', '--language', 'Catalan', "d'acord"],
      ['--language', 'Catalan', '--to', '17f1f7d2c1a600d2', "d'acord"],
    ]) {
      const first = takeDestination(argv, 'voice');
      expect(ok<string | null>(first) && first.value).toBe('17f1f7d2c1a600d2');
      const second = takeLanguage(ok<string | null>(first) ? first.rest : [], 'voice');
      expect(ok<string>(second) && second.value).toBe('Catalan');
      expect(ok<string>(second) && second.rest).toEqual(["d'acord"]);
    }
  });

  it('leaves nothing for the backstop to find', () => {
    // The property that matters: after both lifts, `strayFlag` sees no flags,
    // so a legitimate command is never refused as if it carried a typo.
    const first = takeDestination(['--to', '17f1f7d2c1a600d2', '--language', 'Spanish', 'hola'], 'voice');
    const second = takeLanguage(ok<string | null>(first) ? first.rest : [], 'voice');
    expect(strayFlag(ok<string>(second) ? second.rest : [], 'voice')).toBeNull();
  });
});

describe('strayFlag', () => {
  it('catches a flag nobody lifted, before it is spoken', () => {
    expect(strayFlag(['--speed', '2', 'hola'], 'voice')).toContain('--speed');
  });

  it('says that it would have been sent as content', () => {
    // The error has to explain the consequence, or the agent tries again with
    // the same flag somewhere else in the line.
    expect(strayFlag(['--volume', 'loud'], 'voice')).toContain('sent as content');
  });

  it('passes ordinary words, including ones with dashes inside', () => {
    expect(strayFlag(['well-meaning', 'reply'], 'voice')).toBeNull();
  });

  it('passes a lone dash, which is stdin rather than a flag', () => {
    expect(strayFlag(['-'], 'voice')).toBeNull();
  });
});

describe('takeDestination', () => {
  it('refuses something that is not a chat key', () => {
    // A wrong key here sends a private message to a stranger.
    expect(takeDestination(['--to', 'Les', 'hola'], 'send').ok).toBe(false);
    expect(takeDestination(['--to', '17f1f7d2', 'hola'], 'send').ok).toBe(false);
    expect(takeDestination(['--to'], 'send').ok).toBe(false);
  });
});
