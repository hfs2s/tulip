/**
 * Turning a voice note into words.
 *
 * The failures matter more than the happy path here, because this one spends
 * money per minute on a number that currently answers anyone. Every guard below
 * is either a cost bound or the difference between the agent answering honestly
 * and answering as though nothing was said.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canTranscribe, transcribe } from '../src/transcribe.js';

const dir = mkdtempSync(join(tmpdir(), 'tulip-stt-'));
const file = join(dir, 'note.ogg');
writeFileSync(file, Buffer.from('OggS fake audio'));
const empty = join(dir, 'empty.ogg');
writeFileSync(empty, Buffer.alloc(0));

const original = { ...process.env };
let calls: Array<{ url: string; model: string | null }> = [];

function stub(response: unknown, ok = true, status = 200): void {
  vi.stubGlobal('fetch', async (url: string, init: { body?: FormData }) => {
    const model = init?.body instanceof FormData ? String(init.body.get('model') ?? '') : null;
    calls.push({ url: String(url), model });
    return { ok, status, json: async () => response };
  });
}

beforeEach(() => {
  calls = [];
  process.env['OPENAI_API_KEY'] = 'test-key';
  stub({ text: 'Hey Juan, how are you doing?' });
});
afterEach(() => { process.env = { ...original }; vi.unstubAllGlobals(); });
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

describe('a voice note', () => {
  it('comes back as what was said', async () => {
    const result = await transcribe(file, 'audio/ogg', 4);
    expect(result).toEqual({ ok: true, text: 'Hey Juan, how are you doing?' });
  });

  it('goes to the transcription endpoint with the configured model', async () => {
    process.env['OPENAI_TRANSCRIBE_MODEL'] = 'gpt-4o-mini-transcribe';
    await transcribe(file, 'audio/ogg', 4);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(calls[0]?.model).toBe('gpt-4o-mini-transcribe');
  });

  it('defaults the model rather than sending an empty one', async () => {
    process.env['OPENAI_TRANSCRIBE_MODEL'] = '';
    await transcribe(file, 'audio/ogg', 4);
    expect(calls[0]?.model).toBe('whisper-1');
  });

  it('is trimmed and capped, because length is free for a sender', async () => {
    stub({ text: '  ' + 'x'.repeat(9000) + '  ' });
    const result = await transcribe(file, 'audio/ogg', 4);
    expect(result.ok && result.text.length).toBe(4000);
  });
});

describe('what must not cost anything', () => {
  it('is not attempted without a key', async () => {
    process.env['OPENAI_API_KEY'] = '';
    const result = await transcribe(file, 'audio/ogg', 4);
    expect(result).toEqual({ ok: false, error: 'no transcription is configured' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a recording longer than the cap before uploading it', async () => {
    // Billed by the minute on a number that answers anyone, so an hour-long
    // upload is a cost attack rather than a message.
    const result = await transcribe(file, 'audio/ogg', 3600);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty file without calling out', async () => {
    const result = await transcribe(empty, 'audio/ogg', 1);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('refuses a file that is not there', async () => {
    const result = await transcribe(join(dir, 'gone.ogg'), 'audio/ogg', 1);
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('when the service disappoints', () => {
  it('reports a non-200 rather than throwing', async () => {
    stub({}, false, 429);
    const result = await transcribe(file, 'audio/ogg', 4);
    expect(result).toEqual({ ok: false, error: 'the transcription service returned 429' });
  });

  it('reports an unusable body rather than inventing words', async () => {
    stub({ nothing: true });
    expect((await transcribe(file, 'audio/ogg', 4)).ok).toBe(false);
  });

  it('treats silence as a failure, not as an empty message', async () => {
    stub({ text: '   ' });
    expect((await transcribe(file, 'audio/ogg', 4)).ok).toBe(false);
  });

  it('survives a network error', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const result = await transcribe(file, 'audio/ogg', 4);
    expect(result).toEqual({ ok: false, error: 'transcription failed (TypeError)' });
  });
});

describe('canTranscribe', () => {
  it('is false when the key is absent or blank, so callers skip the work', () => {
    process.env['OPENAI_API_KEY'] = '';
    expect(canTranscribe()).toBe(false);
    process.env['OPENAI_API_KEY'] = '   ';
    expect(canTranscribe()).toBe(false);
    process.env['OPENAI_API_KEY'] = 'k';
    expect(canTranscribe()).toBe(true);
  });
});
