/**
 * Which mouth the words are spoken with.
 *
 * `language_boost` decides how a sentence is *pronounced*, not what it says —
 * the agent picks the words, this picks the accent. It used to be a bare
 * `env()` call inside the synthesis request, which meant it was invisible at
 * every call site and could only be changed by restarting the container. It is
 * now a required argument, sourced from a panel setting.
 *
 * Two things are worth a test rather than a reading. A value the provider does
 * not recognise fails the entire request, and the failure surfaces as a voice
 * note quietly arriving as text — indistinguishable from a broken voice, so the
 * schema has to catch a typo before it is saved. And "empty" is a real setting
 * meaning "whatever this deployment was configured with", which must not be
 * confused with "auto".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const original = { ...process.env };
let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  sent = [];
  process.env['MINIMAX_API_KEY'] = 'test-key';
  delete process.env['MINIMAX_LANGUAGE_BOOST'];
  vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return {
      ok: true,
      json: async () => ({ data: { audio: Buffer.from('x').toString('hex') }, base_resp: { status_msg: 'ok' } }),
    };
  });
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
});

const { synthesise } = await import('../src/minimax.js');
const { LANGUAGE_BOOSTS, parseConfig } = await import('../src/config.js');

const boost = (): unknown => sent[0]?.['language_boost'];

describe('synthesise — the language it asks for', () => {
  it('sends the language it was given', async () => {
    await synthesise('hola', '', 'Spanish');
    expect(boost()).toBe('Spanish');
  });

  it('prefers the setting over the environment', async () => {
    // The panel is where this is changed now. An operator who has picked a
    // language should not have it overridden by a variable set months ago.
    process.env['MINIMAX_LANGUAGE_BOOST'] = 'English';
    await synthesise('hola', '', 'Catalan');
    expect(boost()).toBe('Catalan');
  });

  it('falls back to the environment when the setting is empty', async () => {
    // Empty is "this deployment's default", which is what an install that
    // predates the setting still has.
    process.env['MINIMAX_LANGUAGE_BOOST'] = 'Filipino';
    await synthesise('hola', '', '');
    expect(boost()).toBe('Filipino');
  });

  it('keeps the deployment default when neither is set', async () => {
    // Unchanged by this feature. `auto` is arguably the better last resort for
    // a bot that answers anyone, but it is a different decision from making the
    // setting configurable, and an install that has never touched either should
    // sound tomorrow exactly as it does today.
    await synthesise('hola', '', '');
    expect(boost()).toBe('English');
  });

  it('ignores surrounding whitespace rather than sending it', async () => {
    process.env['MINIMAX_LANGUAGE_BOOST'] = 'Spanish';
    await synthesise('hola', '', '   ');
    expect(boost()).toBe('Spanish');
  });

  it('is independent of the voice', async () => {
    await synthesise('hola', 'some_voice_id', 'Japanese');
    expect(boost()).toBe('Japanese');
    expect((sent[0]?.['voice_setting'] as Record<string, unknown>)['voice_id']).toBe('some_voice_id');
  });
});

describe('the language list', () => {
  it('offers auto, and the languages this deployment actually needs', () => {
    for (const l of ['auto', 'English', 'Spanish', 'Catalan', 'Filipino']) {
      expect(LANGUAGE_BOOSTS).toContain(l);
    }
  });

  it('keeps Cantonese as the provider spells it, comma and all', () => {
    // `Chinese,Yue` is one value. Anything that splits this list on commas
    // produces two languages that do not exist.
    expect(LANGUAGE_BOOSTS).toContain('Chinese,Yue');
  });
});

describe('the setting, before it can be saved', () => {
  const withLanguage = (languageBoost: string): unknown => parseConfig({ agent: { languageBoost } });

  it('accepts a language the provider knows', () => {
    expect(() => withLanguage('Catalan')).not.toThrow();
  });

  it('accepts empty, meaning the deployment default', () => {
    expect(() => withLanguage('')).not.toThrow();
  });

  it('refuses a typo', () => {
    // Without this the save succeeds, and the first anyone hears of it is a
    // voice note arriving as text.
    expect(() => withLanguage('Spanglish')).toThrow();
    expect(() => withLanguage('spanish')).toThrow(); // the list is case-sensitive
  });

  it('defaults to empty when the section says nothing', () => {
    const parsed = parseConfig({}) as { agent: { languageBoost: string } };
    expect(parsed.agent.languageBoost).toBe('');
  });
});
