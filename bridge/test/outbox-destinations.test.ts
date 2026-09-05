import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where an action actually goes.
 *
 * Two properties are under test here and they pull in opposite directions, which
 * is why they are tested together. Media may now be addressed to another chat —
 * the same reach `sendTo` has always had, in every medium instead of only text.
 * And the address space is still *issued*: a key the bridge never minted, a
 * blocked chat, or an operator switch that is off all resolve to nothing.
 *
 * The third property is the one that matters most and is easiest to lose in a
 * refactor: `contact` turns a phone number into a key, and it must be refused on
 * every turn that is not an operator writing directly. If that check ever stops
 * working, whoever can put text in front of the agent chooses who it messages.
 */

let roots: string[] = [];
let sent: Array<{ method: string; jid: string; detail?: string }> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});

vi.mock('../src/minimax.js', () => ({
  synthesise: vi.fn(async () => ({ ok: true, data: Buffer.from('ogg') })),
  generateImage: vi.fn(async () => ({ ok: true, data: Buffer.from('png') })),
}));

vi.mock('../src/mediaStore.js', () => ({ retainOutbound: vi.fn() }));

const PHONE = '15551234567@s.whatsapp.net';
const OTHER = '15559876543@s.whatsapp.net';

interface Harness {
  outbox: { drain: () => Promise<void> };
  chats: { keyFor: (jid: string, isGroup: boolean, now: number) => string; setBlocked: (k: string, b: boolean) => boolean };
  turns: { open: (jid: string, key: string, now: number, fromOperator?: boolean) => { turnId: string } };
  queue: (action: Record<string, unknown>) => void;
  configFile: string;
}

/** A bridge with real registries, a fake WhatsApp, and its own scratch volumes. */
async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'tulip-dest-'));
  roots.push(root);
  const out = join(root, 'out');
  mkdirSync(join(out, 'actions'), { recursive: true });
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
  const { outPaths } = await import('@tulip/shared');
  const { resetForTests } = await import('../src/spend.js');
  resetForTests();

  const config = parseConfig({
    operators: { numbers: ['15551110000'] },
    agent: { crossChat: true, voice: true, images: true, gifs: true, contacts: [] },
    ...overrides,
  });

  const chats = new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
  const turns = new TurnRegistry(600_000, 50);
  const limiter = new Limiter({
    messagesPerHour: 1000,
    burst: 50,
    turnsPerDay: 1000,
    newSendersPerHour: 1000,
    outboundPerChatPerHour: 1000,
  });

  const record = (method: string) => async (jid: string, detail?: unknown) => {
    sent.push({ method, jid, detail: typeof detail === 'string' ? detail : undefined });
  };
  const wa = {
    sendText: record('text'),
    sendVoice: record('voice'),
    sendImage: record('image'),
    sendFile: record('file'),
    sendGif: record('gif'),
    react: record('react'),
    typing: record('typing'),
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
    chats: chats as never,
    turns: turns as never,
    configFile,
    queue: (action) => {
      const id = randomUUID();
      writeFileSync(outPaths.action(id), JSON.stringify({ id, ...action }));
    },
  };
}

beforeEach(() => {
  sent = [];
});

describe('a named destination', () => {
  it('sends a voice note to another chat, which used to be impossible', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'Kumusta!' });
    await h.outbox.drain();

    expect(sent).toEqual([{ method: 'voice', jid: OTHER, detail: undefined }]);
  });

  it('still defaults to the turn’s own chat when none is named', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', text: 'Kumusta!' });
    await h.outbox.drain();

    expect(sent).toEqual([{ method: 'voice', jid: PHONE, detail: undefined }]);
  });

  it('refuses a key the bridge never issued, rather than inventing a destination', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: 'deadbeefdeadbeef', text: 'hello' });
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });

  it('refuses a blocked chat', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    h.chats.setBlocked(theirs, true);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'image', chatKey: theirs, prompt: 'a cat', caption: null });
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });

  it('refuses every medium when the operator’s switch is off', async () => {
    const h = await harness({ agent: { crossChat: false, voice: true, images: true, contacts: [] } });
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    for (const action of [
      { kind: 'voice', text: 'hi' },
      { kind: 'image', prompt: 'a cat', caption: null },
      { kind: 'sendTo', text: 'hi' },
    ]) {
      h.queue({ turnId: turn.turnId, chatKey: theirs, ...action });
    }
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });
});

/**
 * The gate that makes issuing a key safe. A stranger who takes the agent over
 * completely still cannot reach this, because the check is on the *turn*, and
 * the dispatcher decided that from the envelope before the agent saw anything.
 */
describe('contact — provenance, not permission', () => {
  it('refuses a number offered from an ordinary chat', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now, false);

    h.queue({ turnId: turn.turnId, kind: 'contact', number: '15550001111', label: 'Somebody' });
    await h.outbox.drain();

    const written = JSON.parse(readFileSync(h.configFile, 'utf8')) as { agent: { contacts: unknown[] } };
    expect(written.agent.contacts).toEqual([]);
  });

  it('issues a key when the operator asks, and writes it where an operator can see it', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now, true);

    h.queue({ turnId: turn.turnId, kind: 'contact', number: '+15550001111', label: 'Marta' });
    await h.outbox.drain();

    const written = JSON.parse(readFileSync(h.configFile, 'utf8')) as {
      agent: { contacts: Array<{ label: string; number: string }> };
    };
    // The `+` is stripped: config and WhatsApp both store bare digits.
    expect(written.agent.contacts).toEqual([{ label: 'Marta', number: '15550001111' }]);
  });

  it('does not send anything by itself', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now, true);

    h.queue({ turnId: turn.turnId, kind: 'contact', number: '15550001111', label: 'Marta' });
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });
});

describe('voice is metered', () => {
  it('says it in text rather than silently dropping it once the day is spent', async () => {
    const h = await harness({
      agent: { crossChat: true, voice: true, contacts: [] },
      limits: { voicePerDay: 1 },
    });
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', text: 'first' });
    await h.outbox.drain();
    h.queue({ turnId: turn.turnId, kind: 'voice', text: 'second' });
    await h.outbox.drain();

    expect(sent.map((s) => s.method)).toEqual(['voice', 'text']);
  });
});

describe('the ledger', () => {
  it('leaves no action file behind, so nothing is performed twice', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);
    h.queue({ turnId: turn.turnId, kind: 'voice', text: 'once' });

    await h.outbox.drain();
    await h.outbox.drain();

    expect(sent).toHaveLength(1);
    expect(existsSync(join(process.env['TULIP_OUT_DIR'] ?? '', 'actions'))).toBe(true);
  });
});
