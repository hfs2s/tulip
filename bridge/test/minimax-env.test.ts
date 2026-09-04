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

  it('is happy unless somebody says otherwise', async () => {
    expect((await spoken())['emotion']).toBe('happy');
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

describe('what is spoken', () => {
  it('passes sound tags through untouched, because the persona is told to use them', async () => {
    await synthesise('[laughter] no, that is not what I meant');
    expect(sent[0]?.['text']).toBe('[laughter] no, that is not what I meant');
  });

  it('uses the model and voice this deployment is configured for', async () => {
    await synthesise('hola');
    expect(sent[0]?.['model']).toBe('speech-2.8-turbo');
    expect(sent[0]?.['language_boost']).toBe('English');
    expect((sent[0]?.['voice_setting'] as Record<string, unknown>)['voice_id']).toBe('English_Gentle-voiced_man');
  });
});
