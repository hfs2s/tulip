/**
 * Languages the provider will pronounce and cannot speak.
 *
 * MiniMax accepts a `language_boost` for far more languages than it has voices
 * for. Swedish is the live example: there is a boost and not one Swedish mouth,
 * so "speak this in Swedish" used to mean a Spanish or English voice sounding
 * out Swedish words with the vowels nudged. That is an impression rather than
 * an accent, and it is worse than not speaking — a text message loses only the
 * audio, while this loses the credibility of everything around it.
 *
 * So the rule is: a voiceless language is sent as text. The property worth
 * testing is not "it did not throw" but the pair — **nothing was synthesised,
 * and the words still arrived** — because the failure this replaces was one
 * where the words arrived and sounded wrong, and the failure it must not become
 * is one where nothing arrives at all.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PHONE = '15551234567@s.whatsapp.net';

let roots: string[] = [];
let sent: Array<{ method: string; jid: string; text?: string }> = [];
let synthesised: Array<{ text: string; voiceId: string; boost: string }> = [];

vi.mock('../src/minimax.js', () => ({
  synthesise: vi.fn(async (text: string, voiceId: string, boost: string) => {
    synthesised.push({ text, voiceId, boost });
    return { ok: true, data: Buffer.from('ogg') };
  }),
  generateImage: vi.fn(async () => ({ ok: true, data: Buffer.from('png') })),
}));
vi.mock('../src/mediaStore.js', () => ({ retainOutbound: vi.fn() }));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  sent = [];
  synthesised = [];
});

async function harness(agent: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tulip-voiceless-'));
  roots.push(root);
  mkdirSync(join(root, 'out', 'actions'), { recursive: true });
  mkdirSync(join(root, 'out', 'files'), { recursive: true });
  mkdirSync(join(root, 'in'), { recursive: true });
  vi.stubEnv('TULIP_STATE_DIR', root);
  vi.stubEnv('TULIP_IN_DIR', join(root, 'in'));
  vi.stubEnv('TULIP_OUT_DIR', join(root, 'out'));

  vi.resetModules();
  const { Outbox } = await import('../src/outbox.js');
  const { ChatRegistry } = await import('../src/chats.js');
  const { TurnRegistry } = await import('../src/turns.js');
  const { Limiter } = await import('../src/ratelimit.js');
  const { parseConfig } = await import('../src/config.js');
  const { resetForTests, spentToday } = await import('../src/spend.js');
  const { outPaths } = await import('@tulip/shared');
  resetForTests();

  const config = parseConfig({ agent: { voice: true, ...agent } });
  const chats = new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
  const turns = new TurnRegistry(config.limits.turnTimeoutMs, config.limits.outboundPerTurn, config.limits.toolsPerTurn);
  const limiter = new Limiter({
    messagesPerHour: 1000, burst: 50, turnsPerDay: 1000, newSendersPerHour: 1000,
    outboundPerChatPerHour: config.limits.outboundPerChatPerHour,
  });
  const record = (method: string) => async (jid: string, payload?: unknown) => {
    sent.push({ method, jid, text: typeof payload === 'string' ? payload : undefined });
  };
  const wa = {
    sendText: record('text'), sendVoice: record('voice'), sendImage: record('image'),
    sendFile: record('file'), react: record('react'), typing: record('typing'),
  };

  const outbox = new Outbox({
    wa: wa as never, config, chats, turns, limiter,
    lastMessageIn: () => null, setPagePasswords: () => undefined,
  });

  const key = chats.keyFor(PHONE, false, Date.now());
  const turn = turns.open(PHONE, key, Date.now());

  return {
    outbox,
    spentToday,
    say: (language: string, text: string): void => {
      const id = randomUUID();
      writeFileSync(outPaths.action(id), JSON.stringify({ id, turnId: turn.turnId, kind: 'voice', chatKey: null, text, language }));
    },
  };
}

describe('a language with no mouth', () => {
  it('arrives as a message, not as a voice note in somebody else’s accent', async () => {
    const h = await harness();
    h.say('Swedish', 'Hej, mötet är på måndag.');
    await h.outbox.drain();

    expect(synthesised).toHaveLength(0);
    expect(sent).toEqual([{ method: 'text', jid: PHONE, text: 'Hej, mötet är på måndag.' }]);
  });

  it('does not spend the day’s speech allowance on something never synthesised', async () => {
    // Checked before `claim`, deliberately. The allowance meters calls to a
    // billed provider, and no call was made.
    const h = await harness();
    h.say('Swedish', 'Hej.');
    await h.outbox.drain();
    expect(h.spentToday('voice')).toBe(0);
  });

  it('applies to every withdrawn language, not only the one with a row', async () => {
    // The regression this closes: the rule used to key off `SPOKEN_LANGUAGES`,
    // so a language with no row was always spoken. Vietnamese and Turkish had
    // been withdrawn from the panel months earlier and were still being read
    // aloud by whichever default voice was configured — the row was the visible
    // half of the decision and the delivery was the half that mattered.
    for (const language of ['Swedish', 'Vietnamese', 'Turkish']) {
      sent = [];
      synthesised = [];
      const h = await harness();
      h.say(language, 'one line');
      await h.outbox.drain();
      expect(synthesised, language).toHaveLength(0);
      expect(sent, language).toEqual([{ method: 'text', jid: PHONE, text: 'one line' }]);
    }
  });

  it('never reaches this rule with a miscased name, because the schema refuses one first', async () => {
    // Worth pinning rather than assuming. `LanguageBoost` matches the
    // provider's list exactly, so "swedish" fails validation and the action is
    // discarded before any of this runs — the CLI normalises case and aliases
    // through `resolveLanguage` before queueing. `isUnspoken` is still
    // case-insensitive as defence in depth, tested where it can actually be
    // reached, in shared/test/languages.test.ts.
    const h = await harness();
    h.say('swedish', 'Hej.');
    await h.outbox.drain();
    expect(synthesised).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe('every other language is unaffected', () => {
  it('still speaks one that has a voice', async () => {
    const h = await harness();
    h.say('Spanish', 'Hola, la reunión es el lunes.');
    await h.outbox.drain();

    expect(synthesised).toHaveLength(1);
    expect(synthesised[0]?.boost).toBe('Spanish');
    expect(sent[0]?.method).toBe('voice');
  });

  it('still speaks a boost this deployment has no row for', async () => {
    // The provider accepts far more boosts than there are rows here. Treating
    // an unknown one as unspeakable would silently demote most of the world to
    // text, which is the opposite of what this change is for.
    const h = await harness();
    h.say('Korean', '안녕하세요.');
    await h.outbox.drain();

    expect(synthesised).toHaveLength(1);
    expect(synthesised[0]?.boost).toBe('Korean');
    expect(sent[0]?.method).toBe('voice');
  });
});
