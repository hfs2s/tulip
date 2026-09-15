/**
 * What the outbox does on a transport that lacks a capability.
 *
 * The interface marks voice, files, reactions and corrections optional, and
 * the rule for a missing one is: degrade in the open. A voice note goes out as
 * its own script; a file becomes its caption and one honest line; a reaction
 * is logged and skipped. The property worth pinning is the same one the
 * voiceless-language test pins — **nothing was synthesised or billed, and the
 * words still arrived** — because the failure this must never become is one
 * where nothing arrives at all.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CHAT = 'a:1personal-conversation';

let roots: string[] = [];
let sent: Array<{ method: string; jid: string; text?: string }> = [];
let synthesised = 0;

vi.mock('../src/minimax.js', () => ({
  synthesise: vi.fn(async () => {
    synthesised += 1;
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
  synthesised = 0;
});

/** An outbox over a transport shaped like Teams: text and pictures, nothing else. */
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'tulip-degrade-'));
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
  const { feed } = await import('../src/feed.js');
  const { outPaths } = await import('@2lp/shared');
  resetForTests();

  const config = parseConfig({ agent: { voice: true, images: true } });
  const chats = new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
  const turns = new TurnRegistry(config.limits.turnTimeoutMs, config.limits.outboundPerTurn, config.limits.toolsPerTurn);
  const limiter = new Limiter({
    messagesPerHour: 1000, burst: 50, turnsPerDay: 1000, newSendersPerHour: 1000,
    outboundPerChatPerHour: config.limits.outboundPerChatPerHour,
  });
  const record = (method: string) => async (jid: string, payload?: unknown) => {
    sent.push({ method, jid, text: typeof payload === 'string' ? payload : undefined });
    return `${method}-id`;
  };
  // No sendVoice, no sendFile, no react, no editText, no unsend: the shape
  // `Teams` actually has. `kind` is what the degradation lines name.
  const wa = { kind: 'teams', connected: true, sendText: record('text'), sendImage: record('image'), typing: record('typing') };

  const outbox = new Outbox({
    wa: wa as never, config, chats, turns, limiter,
    lastMessageIn: () => ({ id: 'm-1' }), setPagePasswords: () => undefined,
  });

  const key = chats.keyFor(CHAT, false, Date.now());
  const turn = turns.open(CHAT, key, Date.now());

  return {
    outbox,
    spentToday,
    feed,
    filesDir: join(root, 'out', 'files'),
    ask: (action: Record<string, unknown>): string => {
      const id = randomUUID();
      writeFileSync(outPaths.action(id), JSON.stringify({ id, turnId: turn.turnId, ...action }));
      return id;
    },
  };
}

describe('a transport without voice notes', () => {
  it('sends the script as a message, synthesises nothing and bills nothing', async () => {
    const h = await harness();
    h.ask({ kind: 'voice', chatKey: null, text: 'Good morning.', language: '' });
    await h.outbox.drain();
    expect(synthesised).toBe(0);
    expect(h.spentToday('voice')).toBe(0);
    expect(sent).toEqual([{ method: 'text', jid: CHAT, text: 'Good morning.' }]);
  });
});

describe('a transport without files', () => {
  it('says so in the chat, keeps the caption, and clears the staged file', async () => {
    const h = await harness();
    writeFileSync(join(h.filesDir, 'notes.txt'), 'hello');
    h.ask({ kind: 'file', chatKey: null, file: 'notes.txt', caption: 'the notes' });
    await h.outbox.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('the notes\n\n(I had a file to send — notes.txt — but I cannot deliver files on Teams yet.)');
    expect(existsSync(join(h.filesDir, 'notes.txt'))).toBe(false);
    expect(h.feed.recent(10).some((e) => e.kind === 'event' && e.event === 'outbox.fileUnsupported')).toBe(true);
  });
});

describe('a transport without reactions', () => {
  it('skips the reaction and says nothing in the chat', async () => {
    const h = await harness();
    h.ask({ kind: 'react', emoji: '👍' });
    await h.outbox.drain();
    expect(sent).toEqual([]);
    expect(h.feed.recent(10).some((e) => e.kind === 'out')).toBe(false);
  });
});

describe('a transport without corrections', () => {
  it('tells the agent an edit is not possible here, rather than claiming it landed', async () => {
    const h = await harness();
    const { readFileSync } = await import('node:fs');
    const { inPaths } = await import('@2lp/shared');
    h.ask({ kind: 'text', text: 'first draft' });
    await h.outbox.drain();
    const id = h.ask({ kind: 'edit', nth: 1, text: 'second draft' });
    await h.outbox.drain();
    const answer = JSON.parse(readFileSync(inPaths.result(id), 'utf8')) as { ok: boolean; error?: string };
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/^Teams does not let me edit/);
    expect(sent.map((s) => s.text)).toEqual(['first draft']);
  });
});

describe('a transport that still has what it has', () => {
  it('delivers text and pictures exactly as before', async () => {
    const h = await harness();
    h.ask({ kind: 'text', text: 'plain words' });
    await h.outbox.drain();
    h.ask({ kind: 'image', chatKey: null, prompt: 'a cat', caption: 'cat' });
    await h.outbox.drain();
    expect(sent.map((s) => s.method)).toEqual(['text', 'image']);
  });
});
