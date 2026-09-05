/**
 * A voice note choosing its own accent.
 *
 * The operator's setting decides how voice notes are pronounced deployment-wide,
 * which is the wrong granularity for a bot in a Barcelona group and a Filipino
 * one on the same evening: whichever way the setting points, it is wrong for one
 * of them. So the action carries its own language, and the message wins.
 *
 * Two shapes matter here. The precedence — a message that says nothing must
 * behave exactly as it did before this existed — and the validation, which has
 * to happen where the agent can read the error rather than at the provider,
 * where a bad value fails the whole request and the voice note quietly arrives
 * as text.
 */
import { describe, expect, it } from 'vitest';
import { LanguageBoost, OutboxAction } from '@tulip/shared';

const voice = (extra: Record<string, unknown> = {}): unknown =>
  OutboxAction.safeParse({
    id: '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8',
    turnId: 'a1b2c3d4-e5f6-4708-9a1b-c2d3e4f5a6b7',
    kind: 'voice',
    chatKey: null,
    text: 'hola',
    ...extra,
  });

/** What `outbox.ts` does with the two of them. */
const resolve = (messageLanguage: string, operatorSetting: string): string =>
  messageLanguage || operatorSetting;

describe('the voice action', () => {
  it('accepts a language the provider knows', () => {
    const parsed = voice({ language: 'Filipino' }) as { success: boolean; data?: { language: string } };
    expect(parsed.success).toBe(true);
    expect(parsed.data?.language).toBe('Filipino');
  });

  it('defaults to empty when the message says nothing about language', () => {
    // The ordinary case, and the one that must not change behaviour: empty
    // means "whatever the operator chose".
    const parsed = voice() as { success: boolean; data?: { language: string } };
    expect(parsed.success).toBe(true);
    expect(parsed.data?.language).toBe('');
  });

  it('refuses one the provider does not know', () => {
    expect((voice({ language: 'Spanglish' }) as { success: boolean }).success).toBe(false);
    // Capitalisation is part of the value, not decoration.
    expect((voice({ language: 'spanish' }) as { success: boolean }).success).toBe(false);
  });

  it('accepts the value with a comma in it', () => {
    expect((voice({ language: 'Chinese,Yue' }) as { success: boolean }).success).toBe(true);
  });

  it('still refuses a field nobody defined', () => {
    // The action schema is strict, and adding one optional field must not have
    // relaxed that — an agent inventing `--speed` should be told, not obeyed.
    expect((voice({ speed: 2 }) as { success: boolean }).success).toBe(false);
  });
});

describe('which language actually gets used', () => {
  it('lets the message override the operator', () => {
    expect(resolve('Filipino', 'Spanish')).toBe('Filipino');
  });

  it('falls back to the operator when the message says nothing', () => {
    expect(resolve('', 'Spanish')).toBe('Spanish');
  });

  it('falls through to the deployment default when neither is set', () => {
    // Both empty reaches `synthesise`, which resolves it against the
    // environment — so nothing here needs to know what that default is.
    expect(resolve('', '')).toBe('');
  });

  it('lets a message ask for auto even when the operator has fixed a language', () => {
    // The escape hatch for a sentence that genuinely mixes two languages.
    expect(resolve('auto', 'English')).toBe('auto');
  });
});

describe('the flag the agent types', () => {
  // `takeLanguage` in wa-cli.ts validates with exactly this before the value
  // ever reaches the action, so a typo dies at the keyboard with the list in
  // the error rather than an hour later as a voice note that came out as text.
  it('validates the same values the action does', () => {
    expect(LanguageBoost.safeParse('Catalan').success).toBe(true);
    expect(LanguageBoost.safeParse('Klingon').success).toBe(false);
  });

  it('treats empty as the operator setting rather than an error', () => {
    expect(LanguageBoost.safeParse('').success).toBe(true);
  });
});
