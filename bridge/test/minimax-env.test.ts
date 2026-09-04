/**
 * Reading configuration that docker-compose passes through as `${VAR:-}`.
 *
 * That syntax sets a variable to the *empty string* rather than leaving it
 * unset, and `??` only falls back on `undefined`. So
 * `process.env['MINIMAX_BASE_URL'] ?? 'https://api.minimax.io'` evaluated to
 * `''`, every request went to the relative URL `/v1/image_generation`, and
 * `fetch` rejected it with a bare `TypeError`. Pictures and voice notes were
 * silently unavailable for weeks — the agent reported "I could not make a
 * picture", which is indistinguishable from a provider outage.
 *
 * The endpoint is stubbed: these assert which URL is *requested*, which is the
 * thing that was wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const original = { ...process.env };
let requested: string[] = [];
let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  requested = [];
  sent = [];
  process.env['MINIMAX_API_KEY'] = 'test-key';
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    requested.push(String(url));
    try {
      sent.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    } catch {
      sent.push({});
    }
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

describe('an empty environment variable', () => {
  it('falls back to the real host rather than producing a relative URL', async () => {
    process.env['MINIMAX_BASE_URL'] = '';
    await synthesise('hola');
    expect(requested[0]).toMatch(/^https:\/\/api\.minimax\.io\/v1\/t2a_v2/);
  });

  it('is treated the same as whitespace, which is equally not a host', async () => {
    process.env['MINIMAX_BASE_URL'] = '   ';
    await synthesise('hola');
    expect(requested[0]).toMatch(/^https:\/\/api\.minimax\.io\//);
  });

  it('does not append an empty GroupId', async () => {
    process.env['MINIMAX_GROUP_ID'] = '';
    await synthesise('hola');
    expect(requested[0]).not.toContain('GroupId');
  });
});

describe('a value that is actually set', () => {
  it('is used', async () => {
    process.env['MINIMAX_BASE_URL'] = 'https://api.minimaxi.chat';
    await synthesise('hola');
    expect(requested[0]).toMatch(/^https:\/\/api\.minimaxi\.chat\//);
  });

  it('is trimmed, so a stray newline in an .env file is not a broken host', async () => {
    process.env['MINIMAX_BASE_URL'] = ' https://api.minimaxi.chat\n';
    await synthesise('hola');
    expect(requested[0]).toMatch(/^https:\/\/api\.minimaxi\.chat\//);
  });
});

describe('a missing key', () => {
  it('is refused before any request is made', async () => {
    process.env['MINIMAX_API_KEY'] = '';
    const result = await synthesise('hola');
    expect(result.ok).toBe(false);
    expect(requested).toHaveLength(0);
  });
});

/**
 * The emotion sent with every voice note.
 *
 * The provider validates it and refuses an unknown value with a 400 — which
 * would take the entire voice note, not just its warmth. So the set is checked
 * here rather than discovered there.
 */
describe('the emotion', () => {
  const spoken = async (): Promise<Record<string, unknown>> => {
    await synthesise('hola');
    return (sent[0]?.voice_setting ?? {}) as Record<string, unknown>;
  };

  it('is absent unless somebody asks for one', async () => {
    // A blanket mood applies to every line including the ones that should not
    // have it; the sound tags carry colour per sentence instead.
    expect('emotion' in (await spoken())).toBe(false);
  });

  it('honours a valid override', async () => {
    process.env['MINIMAX_VOICE_EMOTION'] = 'surprised';
    expect((await spoken())['emotion']).toBe('surprised');
  });

  it('omits the field entirely for `none`, rather than sending an empty one', async () => {
    process.env['MINIMAX_VOICE_EMOTION'] = 'none';
    expect('emotion' in (await spoken())).toBe(false);
  });

  it('drops an unknown value rather than letting the provider refuse the whole note', async () => {
    process.env['MINIMAX_VOICE_EMOTION'] = 'ecstatic';
    expect('emotion' in (await spoken())).toBe(false);
  });
});

describe('which voice speaks', () => {
  const voiceOf = async (arg?: string): Promise<unknown> => {
    await synthesise('hola', arg);
    return (sent[0]?.['voice_setting'] as Record<string, unknown>)['voice_id'];
  };

  it('is the configured one when there is one', async () => {
    expect(await voiceOf('English_engaging_instructor_vv2')).toBe('English_engaging_instructor_vv2');
  });

  it('falls back to the environment when the setting is blank', async () => {
    process.env['MINIMAX_VOICE_ID'] = 'Spanish_ReliableMan';
    expect(await voiceOf('')).toBe('Spanish_ReliableMan');
  });

  it('ignores a setting that is only whitespace, rather than asking for a voice named " "', async () => {
    process.env['MINIMAX_VOICE_ID'] = 'Spanish_ReliableMan';
    expect(await voiceOf('   ')).toBe('Spanish_ReliableMan');
  });

  it('prefers the setting over the environment, because the panel is where it is changed now', async () => {
    process.env['MINIMAX_VOICE_ID'] = 'Spanish_ReliableMan';
    expect(await voiceOf('English_engaging_instructor_vv2')).toBe('English_engaging_instructor_vv2');
  });
});

describe('what is spoken', () => {
  it('passes sound tags through untouched, because the persona is told to use them', async () => {
    // Round brackets: the provider performs these. Square brackets are not a
    // tag syntax and get spoken as words, which is why the persona names the
    // form explicitly rather than leaving the agent to guess.
    await synthesise('(laughs) no, that is not what I meant');
    expect(sent[0]?.['text']).toBe('(laughs) no, that is not what I meant');
  });

  it('rewrites a known tag written in square brackets, which would be spoken', async () => {
    await synthesise('[laughs] no, that is not what I meant');
    expect(sent[0]?.['text']).toBe('(laughs) no, that is not what I meant');
  });

  it('leaves bracketed words that are not tags exactly as written', async () => {
    // Silently deleting speech is worse than speaking a stray word, so only a
    // token that is already a known tag is touched.
    await synthesise('[honestly] I have no idea');
    expect(sent[0]?.['text']).toBe('[honestly] I have no idea');
  });

  it('keeps the first two sound tags and drops the rest', async () => {
    await synthesise('(laughs) yes (sighs) well (chuckle) anyway (breath) so');
    expect(sent[0]?.['text']).toBe('(laughs) yes (sighs) well anyway so');
  });

  it('leaves a message alone when it is already within the ceiling', async () => {
    await synthesise('(laughs) yes (sighs) well');
    expect(sent[0]?.['text']).toBe('(laughs) yes (sighs) well');
  });

  it('does not count ordinary parentheses towards the ceiling', async () => {
    await synthesise('(mostly) fine (really) yes (laughs) good (sighs) done');
    expect(sent[0]?.['text']).toBe('(mostly) fine (really) yes (laughs) good (sighs) done');
  });

  it('removes hyphens, en dashes and semicolons, which are read badly', async () => {
    await synthesise('voice-for-voice; yes – always');
    expect(sent[0]?.['text']).toBe('voice for voice, yes always');
  });

  it('does not strip the hyphen inside a sound tag, which would unmake the tag', async () => {
    await synthesise('(clear-throat) right then');
    expect(sent[0]?.['text']).toBe('(clear-throat) right then');
  });

  it('leaves em dashes alone, which the model handles', async () => {
    await synthesise('yes — of course');
    expect(sent[0]?.['text']).toBe('yes — of course');
  });

  it('does not invent tags from ordinary parentheses', async () => {
    await synthesise('it was fine (mostly) in the end');
    expect(sent[0]?.['text']).toBe('it was fine (mostly) in the end');
  });

  it('uses the model and voice this deployment is configured for', async () => {
    await synthesise('hola');
    expect(sent[0]?.['model']).toBe('speech-2.8-turbo');
    expect(sent[0]?.['language_boost']).toBe('English');
    expect((sent[0]?.['voice_setting'] as Record<string, unknown>)['voice_id'])
      .toBe('English_engaging_instructor_vv2');
  });
});
