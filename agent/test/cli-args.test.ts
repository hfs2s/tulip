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
import {
  goodbyeProblem,
  parseCallArgs,
  strayFlag,
  takeCall,
  takeDestination,
  takeFetch,
  takeLanguage,
  takeLeave,
  takePosition,
} from '../src/cli-args.js';

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
      ['--to', '0123456789abcdef', '--language', 'Catalan', "d'acord"],
      ['--language', 'Catalan', '--to', '0123456789abcdef', "d'acord"],
    ]) {
      const first = takeDestination(argv, 'voice');
      expect(ok<string | null>(first) && first.value).toBe('0123456789abcdef');
      const second = takeLanguage(ok<string | null>(first) ? first.rest : [], 'voice');
      expect(ok<string>(second) && second.value).toBe('Catalan');
      expect(ok<string>(second) && second.rest).toEqual(["d'acord"]);
    }
  });

  it('leaves nothing for the backstop to find', () => {
    // The property that matters: after both lifts, `strayFlag` sees no flags,
    // so a legitimate command is never refused as if it carried a typo.
    const first = takeDestination(['--to', '0123456789abcdef', '--language', 'Spanish', 'hola'], 'voice');
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

/**
 * `-n`, choosing which of your own messages to correct.
 *
 * The same hazard as the rest of this module, one step worse: what is left over
 * here is not spoken, it *replaces* a message somebody has already read. A
 * position left in the remainder becomes part of the new wording; a position
 * misread points the edit at a different message entirely.
 */
describe('takePosition', () => {
  it('defaults to the last thing said, which is the case that comes up', () => {
    const r = takePosition(['that', 'should', 'read', 'Tuesday'], 'edit');
    expect(ok<number>(r) && r.value).toBe(1);
    expect(ok<number>(r) && r.rest).toEqual(['that', 'should', 'read', 'Tuesday']);
  });

  it('lifts the flag and its value out of the new wording', () => {
    const r = takePosition(['-n', '3', 'I', 'meant', 'Thursday'], 'edit');
    expect(ok<number>(r) && r.value).toBe(3);
    expect(ok<number>(r) && r.rest).toEqual(['I', 'meant', 'Thursday']);
  });

  /**
   * The reason this is a flag rather than a leading bare number.
   *
   * `edit 5 more minutes` has two honest readings and the wrong one edits the
   * wrong message to the wrong words. With a flag, a leading digit is content.
   */
  it('treats a leading number as words, not as a position', () => {
    const r = takePosition(['5', 'more', 'minutes'], 'edit');
    expect(ok<number>(r) && r.value).toBe(1);
    expect(ok<number>(r) && r.rest).toEqual(['5', 'more', 'minutes']);
  });

  it('refuses a position that is not a whole number in range', () => {
    for (const bad of ['0', '-2', '21', '1.5', 'two', '']) {
      const r = takePosition(['-n', bad, 'text'], 'edit');
      expect(r.ok, bad).toBe(false);
      expect(!r.ok && r.message).toContain('tulip-wa sent');
    }
  });

  it('refuses a bare -n with nothing after it, rather than eating the message', () => {
    const r = takePosition(['-n'], 'unsend');
    expect(r.ok).toBe(false);
  });

  it('leaves other flags for their own lifter and for the backstop', () => {
    const lifted = takePosition(['-n', '2', '--to', 'abcdef0123456789', 'hi'], 'edit');
    expect(ok<number>(lifted) && lifted.value).toBe(2);
    const after = takeDestination(ok<number>(lifted) ? lifted.rest : [], 'edit');
    expect(ok<string | null>(after) && after.value).toBe('abcdef0123456789');
    expect(ok<string | null>(after) && after.rest).toEqual(['hi']);
  });
});

/**
 * `fetch` speaks nothing, but a flag it does not know must still be refused by
 * name: a mistyped `--screenshot` that quietly did nothing would read as "no
 * picture came back", and the agent would pass that on as a fact about the page.
 */
describe('takeFetch', () => {
  it('reads a URL, with no picture by default', () => {
    expect(takeFetch(['https://example.com'])).toEqual({
      ok: true,
      value: { url: 'https://example.com', look: false },
      rest: [],
    });
  });

  it('lifts --look from either side of the URL', () => {
    for (const argv of [['https://example.com', '--look'], ['--look', 'https://example.com']]) {
      const r = takeFetch(argv);
      expect(r.ok && r.value).toEqual({ url: 'https://example.com', look: true });
    }
  });

  it('refuses any other flag by name', () => {
    const r = takeFetch(['https://example.com', '--screenshot']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--screenshot is not an option/);
  });

  it('needs a URL, and only one', () => {
    expect(takeFetch([]).ok).toBe(false);
    expect(takeFetch(['--look']).ok).toBe(false);
    expect(takeFetch(['https://a.example', 'https://b.example']).ok).toBe(false);
  });

  it('refuses anything that is not a web address', () => {
    const r = takeFetch(['file:///etc/passwd']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/only http and https/);
  });
});

/**
 * `leave`, where the one thing sent is the goodbye — the last words in a room
 * Juan will not be in to correct them. So nothing that slipped outside the
 * quotes is quietly dropped or quietly sent: it is refused, and nothing is done.
 */
describe('takeLeave', () => {
  const KEY = '0123456789abcdef';

  it('takes no arguments as the chat being answered, with no goodbye', () => {
    expect(takeLeave([])).toEqual({ ok: true, value: { chatKey: null, goodbye: null }, rest: [] });
  });

  it('takes a group key, and a goodbye from either side of it', () => {
    for (const argv of [[KEY, '--goodbye', 'thanks, all'], ['--goodbye', 'thanks, all', KEY]]) {
      expect(takeLeave(argv)).toEqual({ ok: true, value: { chatKey: KEY, goodbye: 'thanks, all' }, rest: [] });
    }
  });

  it('keeps `-` as the goodbye, which means stdin', () => {
    const r = takeLeave(['--goodbye', '-']);
    expect(r.ok && r.value.goodbye).toBe('-');
  });

  it('refuses words outside the quotes rather than dropping them', () => {
    const r = takeLeave(['--goodbye', 'thanks,', 'all']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/in quotes/);
  });

  it('refuses something that is not a chat key', () => {
    for (const key of ['Book club', '120363000000000001@g.us', '0123456789ABCDEF', '0123']) {
      expect(takeLeave([key]).ok, key).toBe(false);
    }
  });

  it('refuses a --goodbye with nothing after it, rather than swallowing the next flag', () => {
    expect(takeLeave(['--goodbye']).ok).toBe(false);
    expect(takeLeave(['--goodbye', '--to', KEY]).ok).toBe(false);
  });

  it('refuses two goodbyes, and any other flag by name', () => {
    expect(takeLeave(['--goodbye', 'a', '--goodbye', 'b']).ok).toBe(false);
    const r = takeLeave([KEY, '--quietly']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--quietly is not an option/);
  });

  it('refuses a goodbye it would otherwise have to cut, or one that is blank', () => {
    expect(takeLeave(['--goodbye', 'x'.repeat(1001)]).ok).toBe(false);
    expect(takeLeave(['--goodbye', '   ']).ok).toBe(false);
    expect(takeLeave(['--goodbye', 'x'.repeat(1000)]).ok).toBe(true);
  });
});

/**
 * `call`, which does something on the operator's own systems. Every word on the
 * line has to be accounted for: two names, each argument behind its own flag,
 * and anything else refused by name with nothing asked.
 */
describe('takeCall', () => {
  it('takes a plugin, an action and named arguments', () => {
    expect(takeCall(['bookings', 'lookup', '--arg', 'ref=4411'])).toEqual({
      ok: true,
      value: { plugin: 'bookings', action: 'lookup', args: { ref: '4411' }, argsJson: null },
      rest: [],
    });
  });

  it('takes a call with no arguments', () => {
    const r = takeCall(['bookings', 'today']);
    expect(r.ok && r.value.args).toEqual({});
  });

  it('keeps a value whole after the first =, whatever it contains', () => {
    const r = takeCall(['--arg', 'note=a=b --to 0123456789abcdef', 'bookings', 'lookup', '--arg', 'blank=']);
    expect(r.ok && r.value.args).toEqual({ note: 'a=b --to 0123456789abcdef', blank: '' });
  });

  it('accepts an argument named like an object property', () => {
    const r = takeCall(['bookings', 'lookup', '--arg', 'constructor=x']);
    expect(r.ok && r.value.args).toEqual({ constructor: 'x' });
  });

  it('keeps --args-json for the caller, - meaning stdin', () => {
    const r = takeCall(['bookings', 'lookup', '--args-json', '-']);
    expect(r.ok && r.value.argsJson).toBe('-');
  });

  it.each([
    ['no action', ['bookings']],
    ['a third name', ['bookings', 'lookup', '4411']],
    ['a plugin name that is not one', ['Bookings', 'lookup']],
    ['an action name that is not one', ['bookings', 'look up']],
    ['an unknown flag', ['bookings', 'lookup', '--force']],
    ['--arg with nothing after it', ['bookings', 'lookup', '--arg']],
    ['--arg without =', ['bookings', 'lookup', '--arg', 'ref']],
    ['an argument name that is not one', ['bookings', 'lookup', '--arg', '1ref=4411']],
    ['the same argument twice', ['bookings', 'lookup', '--arg', 'ref=1', '--arg', 'ref=2']],
    ['a value over the limit', ['bookings', 'lookup', '--arg', `ref=${'x'.repeat(2001)}`]],
    ['more than ten arguments', ['bookings', 'lookup', ...Array.from({ length: 11 }, (_, i) => ['--arg', `a${String(i)}=x`]).flat()]],
    ['--arg and --args-json together', ['bookings', 'lookup', '--arg', 'ref=1', '--args-json', '-']],
    ['two --args-json', ['bookings', 'lookup', '--args-json', '-', '--args-json', '{}']],
  ])('refuses %s, and says nothing was asked', (_label, argv) => {
    const r = takeCall(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Nothing was asked\.$/);
  });

  it('names the flag it does not know', () => {
    const r = takeCall(['bookings', 'lookup', '--force']);
    if (!r.ok) expect(r.message).toMatch(/--force is not an option/);
  });
});

describe('parseCallArgs', () => {
  it('reads an object of names to strings', () => {
    expect(parseCallArgs('{"ref":"4411","note":"$5 && `ls` --to x"}')).toEqual({
      ok: true,
      value: { ref: '4411', note: '$5 && `ls` --to x' },
      rest: [],
    });
  });

  it.each([
    ['not JSON', 'ref=4411'],
    ['nothing at all', ''],
    ['an array', '["4411"]'],
    ['a number where a string belongs', '{"guests":4}'],
    ['a name that is not one', '{"--to":"x"}'],
    ['a value over the limit', JSON.stringify({ ref: 'x'.repeat(2001) })],
    ['more than ten arguments', JSON.stringify(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`a${String(i)}`, 'x'])))],
  ])('refuses %s', (_label, text) => {
    const r = parseCallArgs(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Nothing was asked\.$/);
  });
});

describe('goodbyeProblem', () => {
  it('passes a goodbye that can be sent as written', () => {
    expect(goodbyeProblem('thanks, all')).toBeNull();
  });

  it('says what is wrong and that nothing was done', () => {
    expect(goodbyeProblem('')).toMatch(/empty.*nothing was done/);
    expect(goodbyeProblem('x'.repeat(1001))).toMatch(/1001 characters.*nothing was done/);
  });
});
