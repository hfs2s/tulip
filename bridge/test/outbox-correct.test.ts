/**
 * Correcting something already said, end to end through the outbox.
 *
 * The store's own arithmetic is tested in `sent.test.ts`. What matters here is
 * the wiring around it, where the interesting failures are:
 *
 *   - **A position must resolve to the message the agent counted to**, through
 *     the real send path rather than a hand-seeded store. If sends stop
 *     recording their key — a refactor away, since it happens at eight call
 *     sites — every position silently shifts or disappears.
 *   - **A refusal must be readable.** WhatsApp closes both windows quickly, and
 *     the agent's next move is usually to tell somebody it has fixed the
 *     message. If the failure does not come back as an answer it can read, it
 *     says so having done nothing.
 *   - **The feed must keep what was said before.** That is the condition the
 *     capability was granted under: the operator's record survives a
 *     correction, even though the recipient's does not.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let roots: string[] = [];
let calls: Array<{ method: string; jid: string; id?: string; text?: string }> = [];
/** Set by a test to make WhatsApp refuse, the way an expired window does. */
let refuse: string | null = null;

const PHONE = '15551234567@s.whatsapp.net';
const OTHER = '15559876543@s.whatsapp.net';

vi.mock('../src/minimax.js', () => ({
  synthesise: vi.fn(async () => ({ ok: true, data: Buffer.from('ogg') })),
  generateImage: vi.fn(async () => ({ ok: true, data: Buffer.from('png') })),
}));
vi.mock('../src/mediaStore.js', () => ({ retainOutbound: vi.fn() }));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  calls = [];
  refuse = null;
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'tulip-correct-'));
  roots.push(root);
  const out = join(root, 'out');
  mkdirSync(join(out, 'actions'), { recursive: true });
  mkdirSync(join(out, 'files'), { recursive: true });
  mkdirSync(join(root, 'in'), { recursive: true });
  vi.stubEnv('TULIP_OUT_DIR', out);
  vi.stubEnv('TULIP_IN_DIR', join(root, 'in'));
  vi.stubEnv('TULIP_STATE_DIR', root);
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ agent: { contacts: [] } }));
  vi.stubEnv('TULIP_CONFIG', configFile);

  vi.resetModules();
  const { Outbox } = await import('../src/outbox.js');
  const { ChatRegistry } = await import('../src/chats.js');
  const { TurnRegistry } = await import('../src/turns.js');
  const { Limiter } = await import('../src/ratelimit.js');
  const { parseConfig } = await import('../src/config.js');
  const { outPaths, inPaths } = await import('@2lp/shared');
  const { resetForTests } = await import('../src/spend.js');
  const { feed } = await import('../src/feed.js');
  resetForTests();

  const config = parseConfig({
    operators: { numbers: ['15551110000'] },
    agent: { crossChat: true, voice: true, images: true, contacts: [] },
  });
  const chats = new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
  const turns = new TurnRegistry(
    config.limits.turnTimeoutMs,
    config.limits.outboundPerTurn,
    config.limits.toolsPerTurn,
  );
  const limiter = new Limiter({
    messagesPerHour: 1000,
    burst: 50,
    turnsPerDay: 1000,
    newSendersPerHour: 1000,
    outboundPerChatPerHour: config.limits.outboundPerChatPerHour,
  });

  // Unlike the destination harness, this one hands back ids — that return value
  // is the whole subject of these tests.
  let seq = 0;
  const wa = {
    sendText: async (jid: string, text: string) => {
      seq += 1;
      const id = `wa-${String(seq)}`;
      calls.push({ method: 'text', jid, id, text });
      return id;
    },
    sendVoice: async (jid: string) => {
      seq += 1;
      const id = `wa-${String(seq)}`;
      calls.push({ method: 'voice', jid, id });
      return id;
    },
    sendImage: async (jid: string) => {
      seq += 1;
      const id = `wa-${String(seq)}`;
      calls.push({ method: 'image', jid, id });
      return id;
    },
    sendFile: async (jid: string) => {
      seq += 1;
      return `wa-${String(seq)}`;
    },
    editText: async (jid: string, id: string, text: string) => {
      if (refuse !== null) throw new Error(refuse);
      calls.push({ method: 'edit', jid, id, text });
    },
    unsend: async (jid: string, id: string) => {
      if (refuse !== null) throw new Error(refuse);
      calls.push({ method: 'unsend', jid, id });
    },
    react: async () => undefined,
    typing: async () => undefined,
  };

  const outbox = new Outbox({
    wa: wa as never,
    config,
    chats,
    turns,
    limiter,
    lastMessageIn: () => null,
  });

  return {
    outbox,
    chats: chats as never as { keyFor: (j: string, g: boolean, n: number) => string },
    turns: turns as never as {
      open: (j: string, k: string, n: number) => { turnId: string };
    },
    feed,
    queue: (action: Record<string, unknown>): string => {
      const id = randomUUID();
      writeFileSync(outPaths.action(id), JSON.stringify({ id, ...action }));
      return id;
    },
    answer: (id: string): { ok: boolean; error: string | null } | null => {
      try {
        return JSON.parse(readFileSync(inPaths.result(id), 'utf8')) as {
          ok: boolean;
          error: string | null;
        };
      } catch {
        return null;
      }
    },
  };
}

describe('editing', () => {
  it('rewords the message the position names, not the newest one', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'text', text: 'see you Tuesday' });
    h.queue({ turnId: turn.turnId, kind: 'text', text: 'bring the papers' });
    await h.outbox.drain();

    // -n 2 is "see you Tuesday": the older of the two.
    h.queue({ turnId: turn.turnId, kind: 'edit', nth: 2, text: 'see you Thursday' });
    await h.outbox.drain();

    const edit = calls.find((c) => c.method === 'edit');
    expect(edit?.id).toBe('wa-1');
    expect(edit?.text).toBe('see you Thursday');
  });

  it('keeps the original in the feed, which is why this was allowed at all', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'text', text: 'the deadline is Tuesday' });
    await h.outbox.drain();
    h.queue({ turnId: turn.turnId, kind: 'edit', nth: 1, text: 'the deadline is Thursday' });
    await h.outbox.drain();

    const row = h.feed.recent(50).find((e) => e.kind === 'edited');
    expect(row?.was).toBe('the deadline is Tuesday');
    expect(row?.text).toBe('the deadline is Thursday');
    expect(row?.by).toBe('agent');
    // Appended, not applied: the original `out` row is still there.
    expect(h.feed.recent(50).some((e) => e.kind === 'out' && e.text === 'the deadline is Tuesday')).toBe(true);
  });

  it('tells the agent when WhatsApp refuses, rather than reporting success', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'text', text: 'something old' });
    await h.outbox.drain();

    refuse = 'message is too old to edit';
    const id = h.queue({ turnId: turn.turnId, kind: 'edit', nth: 1, text: 'a fix that will not land' });
    await h.outbox.drain();

    const answered = h.answer(id);
    expect(answered?.ok).toBe(false);
    // The agent's next move is to tell somebody it fixed the message, so the
    // reason has to be readable and has to name the window.
    expect(answered?.error).toContain('fifteen minutes');
    // And nothing is recorded as corrected when nothing was.
    expect(h.feed.recent(50).some((e) => e.kind === 'edited')).toBe(false);
  });

  it('refuses a position nobody has said that many messages for', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'text', text: 'only one' });
    await h.outbox.drain();

    const id = h.queue({ turnId: turn.turnId, kind: 'edit', nth: 4, text: 'nope' });
    await h.outbox.drain();

    expect(h.answer(id)?.ok).toBe(false);
    expect(h.answer(id)?.error).toContain('tulip-wa sent');
    expect(calls.some((c) => c.method === 'edit')).toBe(false);
  });

  it('will not try to reword a voice note, which WhatsApp cannot do', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', text: 'hola', language: 'Spanish' });
    await h.outbox.drain();

    const id = h.queue({ turnId: turn.turnId, kind: 'edit', nth: 1, text: 'different words' });
    await h.outbox.drain();

    expect(h.answer(id)?.ok).toBe(false);
    expect(h.answer(id)?.error).toContain('unsend');
    expect(calls.some((c) => c.method === 'edit')).toBe(false);
  });
});

describe('retracting', () => {
  it('takes back the message and records what it said', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'text', text: 'that was not mine to share' });
    await h.outbox.drain();
    h.queue({ turnId: turn.turnId, kind: 'unsend', nth: 1 });
    await h.outbox.drain();

    expect(calls.find((c) => c.method === 'unsend')?.id).toBe('wa-1');
    const row = h.feed.recent(50).find((e) => e.kind === 'unsent');
    expect(row?.was).toBe('that was not mine to share');
    expect(row?.by).toBe('agent');
  });

  it('stops offering a retracted message, so the next position moves up', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'text', text: 'first' });
    h.queue({ turnId: turn.turnId, kind: 'text', text: 'second' });
    await h.outbox.drain();

    h.queue({ turnId: turn.turnId, kind: 'unsend', nth: 1 });
    await h.outbox.drain();

    // "first" is now position 1 — `edit 1` must not mean the deleted message.
    h.queue({ turnId: turn.turnId, kind: 'edit', nth: 1, text: 'first, corrected' });
    await h.outbox.drain();

    expect(calls.find((c) => c.method === 'edit')?.id).toBe('wa-1');
  });
});

describe('the bound on what a position can reach', () => {
  /**
   * The containment property, through the real path.
   *
   * The agent is answering one chat and has spoken in another. A position is
   * resolved against the chat whose turn it is, so nothing it can be asked to
   * type reaches the other conversation's messages. If this ever fails, a
   * stranger's message becomes a way to edit what Juan told somebody else.
   */
  it('never reaches a message sent in a different conversation', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    // One message into the other chat, and none into this one.
    h.queue({ turnId: turn.turnId, kind: 'sendTo', chatKey: theirs, text: 'said elsewhere' });
    await h.outbox.drain();
    expect(calls.find((c) => c.method === 'text')?.jid).toBe(OTHER);

    const id = h.queue({ turnId: turn.turnId, kind: 'unsend', nth: 1 });
    await h.outbox.drain();

    expect(h.answer(id)?.ok).toBe(false);
    expect(calls.some((c) => c.method === 'unsend')).toBe(false);
  });
});
