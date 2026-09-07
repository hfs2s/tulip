/**
 * Auditioning a voice from the panel.
 *
 * The feature is one press on a row of the voice matrix, and its entire value
 * is an equivalence: what the operator hears must be what somebody on WhatsApp
 * would hear. So the assertions worth making are not "audio came back" — they
 * are **which voice and which boost the request carried**, because a bench that
 * resolves the voice differently from the outbound path is confidently wrong
 * rather than merely broken, and nothing about its output would look off.
 *
 * The other half is that it spends real money per press. A control that bills
 * on click and is presented as a row of eighteen buttons needs a ceiling that
 * is tested rather than assumed, and it needs its refusals to be *sentences* —
 * the operator is holding the setting that caused the failure, so "voice id not
 * exist" is the whole answer they came for and must not be flattened into
 * "the preview failed".
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What the provider returns, as module state — see outbox-destinations.test.ts. */
let voiceOutcome: unknown = { ok: true, data: Buffer.from('OggS-pretend') };
/** Every call the provider received, so the resolution can be asserted on. */
let spoken: Array<{ text: string; voiceId: string; language: string }> = [];

vi.mock('../src/minimax.js', () => ({
  synthesise: vi.fn(async (text: string, voiceId: string, language: string) => {
    spoken.push({ text, voiceId, language });
    return voiceOutcome;
  }),
  generateImage: vi.fn(async () => ({ ok: false, error: 'not under test' })),
}));

let roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  voiceOutcome = { ok: true, data: Buffer.from('OggS-pretend') };
  spoken = [];
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function harness(agent: Record<string, unknown> = {}, limits: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tulip-preview-'));
  roots.push(root);
  vi.stubEnv('TULIP_STATE_DIR', root);
  vi.stubEnv('MINIMAX_API_KEY', 'test-key-not-a-real-one');
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, '{}');
  vi.stubEnv('TULIP_CONFIG', configFile);

  vi.resetModules();
  const { parseConfig } = await import('../src/config.js');
  const api = await import('../src/panel-api.js');
  api.resetPreviewsForTests();
  const spend = await import('../src/spend.js');
  spend.resetForTests();

  const config = parseConfig({
    agent: { voice: true, ...agent },
    limits: { voicePerDay: 200, ...limits },
  });
  const deps = {
    config,
    wa: {} as never,
    chats: {} as never,
    limiter: {} as never,
    dispatcher: () => ({}) as never,
  };
  return { deps, preview: api.voicePreview };
}

describe('what the audition actually asks for', () => {
  it('speaks the language its own sample line, with that language boost', async () => {
    const { deps, preview } = await harness({ voiceId: 'Default_Voice' });
    const { LANGUAGE_SAMPLES } = await import('@tulip/shared');

    const result = await preview(deps, { language: 'German' });

    expect(result.ok).toBe(true);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.text).toBe(LANGUAGE_SAMPLES.German);
    expect(spoken[0]?.language).toBe('German');
  });

  it('uses the voice set for that row, not the deployment default', async () => {
    // The whole point. If this resolves to `voiceId` the operator hears the
    // wrong mouth and has no way to tell.
    const { deps, preview } = await harness({
      voiceId: 'Default_Voice',
      voices: { German: 'German_FriendlyMan' },
    });

    await preview(deps, { language: 'German' });

    expect(spoken[0]?.voiceId).toBe('German_FriendlyMan');
  });

  it('auditions the deployment default when the row is blank', async () => {
    // Not a degraded case: a blank row genuinely is read by the default voice,
    // so this is what a real note in that language sounds like today.
    const { deps, preview } = await harness({ voiceId: 'Default_Voice', voices: { German: '' } });

    await preview(deps, { language: 'German' });

    expect(spoken[0]?.voiceId).toBe('Default_Voice');
  });

  it('sends Mandarin as the boost the provider spells, not as the row name', async () => {
    const { deps, preview } = await harness({ voices: { Mandarin: 'Chinese (Mandarin)_Reliable_Executive' } });

    const result = await preview(deps, { language: 'Mandarin' });

    expect(spoken[0]?.language).toBe('Chinese');
    expect(spoken[0]?.voiceId).toBe('Chinese (Mandarin)_Reliable_Executive');
    expect(result.ok && result.boost).toBe('Chinese');
  });

  it('reads Cebuano with its own voice while sending the Filipino boost', async () => {
    const { deps, preview } = await harness({
      voices: { Filipino: 'Filipino_male_1_v1', Cebuano: 'Someone_Else' },
    });

    await preview(deps, { language: 'Cebuano' });

    expect(spoken[0]?.voiceId).toBe('Someone_Else');
    expect(spoken[0]?.language).toBe('Filipino');
  });
});

describe('what it refuses', () => {
  it('refuses a language this deployment does not speak', async () => {
    // Free text here would be a way to spend money on an arbitrary sentence,
    // and the sentence is the one thing that is not the operator's to choose.
    const { deps, preview } = await harness();

    const result = await preview(deps, { language: 'Korean' });

    expect(result.ok).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it('refuses when voice notes are switched off', async () => {
    const { deps, preview } = await harness({ voice: false });

    const result = await preview(deps, { language: 'German' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('switched off');
    expect(spoken).toHaveLength(0);
  });

  it('passes the provider’s own complaint through, verbatim', async () => {
    // "voice id not exist" is the sentence that tells an operator their paste
    // was wrong. Replacing it with "the preview failed" throws away the answer.
    voiceOutcome = { ok: false, error: 'voice id not exist' };
    const { deps, preview } = await harness({ voices: { German: 'Not_A_Real_Voice' } });

    const result = await preview(deps, { language: 'German' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(502);
    expect(!result.ok && result.message).toBe('voice id not exist');
  });
});

describe('the ceiling on a button that bills', () => {
  it('stops after six presses in a minute, and says how long to wait', async () => {
    const { deps, preview } = await harness();
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);

    for (let i = 0; i < 6; i += 1) {
      expect((await preview(deps, { language: 'German' }, start + i * 1000)).ok, `press ${i}`).toBe(true);
    }
    const refused = await preview(deps, { language: 'German' }, start + 6000);

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.status).toBe(429);
    expect(!refused.ok && refused.message).toMatch(/Try again in \d+s/);
    // Refused before the provider was asked, so the refusal costs nothing.
    expect(spoken).toHaveLength(6);
  });

  it('lets the window roll', async () => {
    const { deps, preview } = await harness();
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);

    for (let i = 0; i < 6; i += 1) await preview(deps, { language: 'German' }, start + i * 1000);
    const later = await preview(deps, { language: 'German' }, start + 61_000);

    expect(later.ok).toBe(true);
  });

  it('spends the day’s speech allowance, and stops when it is gone', async () => {
    // The minute-long window bounds a stuck finger; this bounds the invoice.
    const { deps, preview } = await harness({}, { voicePerDay: 2 });
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);

    expect((await preview(deps, { language: 'German' }, start)).ok).toBe(true);
    expect((await preview(deps, { language: 'Dutch' }, start + 1000)).ok).toBe(true);
    const refused = await preview(deps, { language: 'Italian' }, start + 2000);

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.status).toBe(429);
    expect(!refused.ok && refused.message).toContain('midnight UTC');
  });
});
