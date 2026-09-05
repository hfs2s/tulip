import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where an action actually goes.
 *
 * **This is the only home for destination tests.** There were briefly two files
 * one character apart — `outbox-destination` and `outbox-destinations` — which
 * is a trap rather than coverage: a case added to one silently does not run
 * beside the other. Everything either of them proved is here.
 *
 * Several properties are under test and they pull in opposite directions, which
 * is why they are tested together. Media may now be addressed to another chat —
 * the same reach `sendTo` has always had, in every medium instead of only text.
 * And the address space is still *issued*: a key the bridge never minted, a
 * blocked chat, or an operator switch that is off all resolve to nothing.
 *
 * The question worth asking of every verb is the same one: **which jid did the
 * WhatsApp client receive?** A test that only checked "it did not throw" would
 * have passed throughout the bug this file exists to prevent — the agent asking
 * for chat B and the bridge quietly writing into chat A.
 *
 * The paths worth naming, because they are the ones a refactor breaks:
 *
 *   - the **fallbacks**. Synthesis fails, or a daily allowance is spent, so the
 *     words go out as text instead. Each is its own `sendText` call, written
 *     after the destination was resolved, with its own chance to reach for
 *     `turn.chatJid` out of habit.
 *   - **rate limiting**, which is charged to the chat being written into. It
 *     used to be charged to the turn's chat, so a cross-chat send spent the
 *     sender's allowance and the recipient had no ceiling of their own.
 *   - **`contact`**, the one action that widens the address space rather than
 *     the medium, gated on provenance — the turn being an operator's — rather
 *     than on a config flag the agent could be talked into asking about. If
 *     that check ever stops working, whoever can put text in front of the agent
 *     chooses who it messages.
 *   - **a superseded chat key**, which must resolve to the survivor's block
 *     state. The agent's workspace persists per chat across turns, so it can
 *     still be holding a key from before two identities were merged.
 */

let roots: string[] = [];
let sent: Array<{ method: string; jid: string; detail?: string }> = [];

/**
 * What the two billed providers and Giphy return, as module state.
 *
 * Not `vi.mocked(...).mockResolvedValue(...)` on a top-level import, because the
 * harness resets the module registry per test: the mock factory runs again and
 * the instance a test configured is not the instance the bridge imported. A
 * variable the factory closes over survives that.
 */
let voiceOutcome: unknown = { ok: true, data: Buffer.from('ogg') };
let imageOutcome: unknown = { ok: true, data: Buffer.from('png') };
let gifOutcome: unknown = { ok: true, video: Buffer.from('mp4'), title: 'a cat' };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});

// Both of these leave the deployment and cost money per call. What is under
// test is where their output is sent, never that it was produced.
vi.mock('../src/minimax.js', () => ({
  synthesise: vi.fn(async () => voiceOutcome),
  generateImage: vi.fn(async () => imageOutcome),
}));

vi.mock('../src/giphy.js', () => ({
  findGif: vi.fn(async () => gifOutcome),
}));

vi.mock('../src/mediaStore.js', () => ({ retainOutbound: vi.fn() }));

/** The chat whose turn it is. Every "did it stay put" assertion names this. */
const PHONE = '15551234567@s.whatsapp.net';
/** Somewhere else the bridge has issued a key for. */
const OTHER = '15559876543@s.whatsapp.net';
/**
 * A linked id — the same human as `OTHER`, as WhatsApp sometimes delivers them.
 * A repeated-digit dummy: real ones are opaque and belong to real people, and
 * this repository is public.
 */
const LID = '1111111111111@lid';
/** Well-formed, and never minted. `jidFor` is a lookup, so this resolves to nothing. */
const NEVER_ISSUED = 'deadbeefdeadbeef';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

interface Harness {
  outbox: { drain: () => Promise<void> };
  chats: {
    keyFor: (jid: string, isGroup: boolean, now: number, altJid?: string | null) => string;
    setBlocked: (k: string, b: boolean) => boolean;
    jidFor: (k: string) => string | null;
  };
  turns: { open: (jid: string, key: string, now: number, fromOperator?: boolean) => { turnId: string } };
  /** Queue one action the way the agent does. Returns its id, for `answer`. */
  queue: (action: Record<string, unknown>) => string;
  /** Stage a file on the outbound volume, where `file` actions resolve names. */
  stage: (name: string, bytes: Buffer) => void;
  /** The tool answer written back onto the agent's read-only volume, if any. */
  answer: (id: string) => { ok: boolean; error: string | null; items: Array<{ url: string }> } | null;
  emitted: Array<{ chatKey: string; kind: string }>;
  configFile: string;
}

/** A bridge with real registries, a fake WhatsApp, and its own scratch volumes. */
async function harness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'tulip-dest-'));
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
  const { outPaths, inPaths } = await import('@tulip/shared');
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
    // From the config, not a constant: the destination-charging tests below
    // turn this down to observe it, and a hard-coded 1000 cannot see a cap at
    // all.
    outboundPerChatPerHour: config.limits.outboundPerChatPerHour,
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

  const emitted: Array<{ chatKey: string; kind: string }> = [];
  outbox.on('sent', (entry) => emitted.push(entry as { chatKey: string; kind: string }));

  return {
    outbox,
    chats: chats as never,
    turns: turns as never,
    configFile,
    emitted,
    queue: (action) => {
      const id = randomUUID();
      writeFileSync(outPaths.action(id), JSON.stringify({ id, ...action }));
      return id;
    },
    stage: (name, bytes) => {
      writeFileSync(outPaths.file(name), bytes);
    },
    answer: (id) => {
      try {
        return JSON.parse(readFileSync(inPaths.result(id), 'utf8')) as {
          ok: boolean;
          error: string | null;
          items: Array<{ url: string }>;
        };
      } catch {
        return null;
      }
    },
  };
}

beforeEach(() => {
  sent = [];
  voiceOutcome = { ok: true, data: Buffer.from('ogg') };
  imageOutcome = { ok: true, data: Buffer.from('png') };
  gifOutcome = { ok: true, video: Buffer.from('mp4'), title: 'a cat' };
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

  it('reports the destination, not the turn, to the panel and the log', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'Kumusta!' });
    await h.outbox.drain();

    expect(h.emitted).toEqual([{ chatKey: theirs, kind: 'voice' }]);
  });

  // One address space and one gate for all five: the medium is the only thing
  // that differs, which is the property the threat model rests on.
  it.each([
    ['image', { kind: 'image', prompt: 'a tulip', caption: null }, 'image'],
    ['gif', { kind: 'gif', query: 'cat', caption: null }, 'gif'],
    ['file', { kind: 'file', file: 'chart.png', caption: null }, 'file'],
    ['sendTo', { kind: 'sendTo', text: 'passing this on' }, 'text'],
  ])('routes %s to the named chat', async (_label, action, method) => {
    const h = await harness();
    h.stage('chart.png', PNG);
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, ...action, chatKey: theirs });
    await h.outbox.drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method, jid: OTHER });
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

  // `chatKey` defaults to null, so an action written by an older agent — or by
  // a verb that never learned about `--to` — still parses and still goes home.
  it('treats an explicit null the same way as an omitted key', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: null, text: 'Kumusta!' });
    await h.outbox.drain();

    expect(sent).toEqual([{ method: 'voice', jid: PHONE, detail: undefined }]);
  });

  it.each([
    ['image', { kind: 'image', prompt: 'a tulip', caption: null }],
    ['gif', { kind: 'gif', query: 'cat', caption: null }],
    ['file', { kind: 'file', file: 'chart.png', caption: null }],
  ])('sends %s home when no chat is named', async (_label, action) => {
    const h = await harness();
    h.stage('chart.png', PNG);
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, ...action, chatKey: null });
    await h.outbox.drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.jid).toBe(PHONE);
  });
});

/**
 * The three checks in `crossChatTarget`, and the rule they share: all three
 * refuse by sending *nothing*. Falling back to the turn's chat would deliver a
 * message meant for somebody else to the person who asked for it, which is
 * worse than silence and is exactly what the voice `--to` bug did.
 */
describe('a destination the bridge will not resolve', () => {
  it('refuses a key the bridge never issued, rather than inventing a destination', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: NEVER_ISSUED, text: 'hello' });
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
    const h = await harness({ agent: { crossChat: false, voice: true, images: true, gifs: true, contacts: [] } });
    h.stage('chart.png', PNG);
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    for (const action of [
      { kind: 'voice', text: 'hi' },
      { kind: 'image', prompt: 'a cat', caption: null },
      { kind: 'gif', query: 'cat', caption: null },
      { kind: 'file', file: 'chart.png', caption: null },
      { kind: 'sendTo', text: 'hi' },
    ]) {
      h.queue({ turnId: turn.turnId, chatKey: theirs, ...action });
    }
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });

  // The failure that matters most: a refused destination must not become the
  // turn's chat by default.
  it('never falls back to the turn’s own chat', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    h.chats.setBlocked(theirs, true);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: NEVER_ISSUED, text: 'a secret for somebody else' });
    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'a secret for somebody else' });
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });
});

/**
 * A block follows the person, not the identifier.
 *
 * WhatsApp delivers one human as `<number>@s.whatsapp.net` or as an opaque
 * `<id>@lid`, and the registry merges the two when it learns they are the same
 * person: the duplicate is superseded rather than deleted, so nothing holding
 * its key breaks. The agent is one of the things holding it — its workspace
 * persists per chat across turns — so a pre-merge key can outlive the merge in
 * the one place that is assumed hostile.
 *
 * Inbound was never at risk: the dispatcher checks the key `keyFor` returned,
 * which is already the survivor. Outbound checks the key the *agent* supplied,
 * so until `jidFor` and `isBlocked` resolved through `mergedInto`, blocking the
 * surviving record left the superseded key working perfectly.
 */
describe('a superseded chat key', () => {
  /** Register both identities and merge them. Returns the two keys. */
  function merge(h: Harness, now: number): { stale: string; survivor: string } {
    const survivor = h.chats.keyFor(OTHER, false, now);
    const stale = h.chats.keyFor(LID, false, now);
    // The same person writes again, this time carrying the phone-number form
    // alongside the linked id — which is what supersedes the duplicate.
    expect(h.chats.keyFor(LID, false, now, OTHER)).toBe(survivor);
    expect(stale).not.toBe(survivor);
    return { stale, survivor };
  }

  it('is refused once the surviving record is blocked', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const { stale, survivor } = merge(h, now);
    h.chats.setBlocked(survivor, true);
    const turn = h.turns.open(PHONE, mine, now);

    // The agent still holds the pre-merge key. It must not be a way around the
    // block an operator just applied.
    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: stale, text: 'you cannot stop me' });
    h.queue({ turnId: turn.turnId, kind: 'sendTo', chatKey: stale, text: 'you cannot stop me' });
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });

  it('is blocked by an operator holding the stale key, too', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const { stale, survivor } = merge(h, now);
    // The other direction: the key in front of the operator — in a feed line,
    // or a page open since before the merge — is the superseded one. A block
    // that lands on the dead record would be accepted and do nothing.
    expect(h.chats.setBlocked(stale, true)).toBe(true);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: survivor, text: 'hello' });
    await h.outbox.drain();

    expect(sent).toEqual([]);
  });

  it('still resolves, and reaches the survivor, when nobody is blocked', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const { stale } = merge(h, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: stale, text: 'kumusta' });
    await h.outbox.drain();

    // Not silence, and not the linked id: the survivor's own jid.
    expect(sent).toEqual([{ method: 'voice', jid: OTHER, detail: undefined }]);
  });
});

/**
 * Every way a send can turn into a different send still follows the
 * destination. Each is its own `sendText` call, written after the destination
 * was resolved, which is precisely how one of them ends up addressed to
 * `turn.chatJid` again.
 */
describe('the fallbacks follow the destination', () => {
  it('sends the words as text to the named chat when synthesis fails', async () => {
    voiceOutcome = { ok: false, error: 'voice id not exist' };
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'kumusta' });
    await h.outbox.drain();

    expect(sent).toEqual([{ method: 'text', jid: OTHER, detail: 'kumusta' }]);
  });

  it('still falls back to the turn’s chat when that is where it was going', async () => {
    voiceOutcome = { ok: false, error: 'voice id not exist' };
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', text: 'kumusta' });
    await h.outbox.drain();

    expect(sent).toEqual([{ method: 'text', jid: PHONE, detail: 'kumusta' }]);
  });

  it('sends the words as text to the named chat when the day’s voice allowance is spent', async () => {
    const h = await harness({
      agent: { crossChat: true, voice: true, images: true, gifs: true, contacts: [] },
      limits: { voicePerDay: 0 },
    });
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'kumusta' });
    await h.outbox.drain();

    expect(sent).toEqual([{ method: 'text', jid: OTHER, detail: 'kumusta' }]);
  });

  // Same shape, one verb along: the "allowance spent" apology is a send too.
  it('tells the named chat, not the turn’s, when the picture allowance is spent', async () => {
    const h = await harness({
      agent: { crossChat: true, voice: true, images: true, gifs: true, contacts: [] },
      limits: { imagesPerDay: 0 },
    });
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'image', chatKey: theirs, prompt: 'a tulip', caption: null });
    await h.outbox.drain();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.jid).toBe(OTHER);
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

/**
 * The outbound cap is per chat and per hour, and it is the recipient's ceiling.
 * Charging it to the turn's chat would mean one conversation could be used to
 * flood another: the sender pays, and the chat being written into has no bound
 * of its own.
 */
describe('outbound rate limiting is charged to the destination', () => {
  it('spends the destination’s allowance, not the turn’s', async () => {
    const h = await harness({ limits: { outboundPerChatPerHour: 1 } });
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'one' });
    await h.outbox.drain();
    expect(sent).toEqual([{ method: 'voice', jid: OTHER, detail: undefined }]);

    // The destination is now out of allowance.
    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'two' });
    await h.outbox.drain();
    expect(sent).toHaveLength(1);

    // The turn's own chat never paid for either, so it can still be answered.
    h.queue({ turnId: turn.turnId, kind: 'text', text: 'answering you' });
    await h.outbox.drain();
    expect(sent).toEqual([
      { method: 'voice', jid: OTHER, detail: undefined },
      { method: 'text', jid: PHONE, detail: 'answering you' },
    ]);
  });

  it('does not let the turn’s chat run out because of what it sent elsewhere', async () => {
    const h = await harness({ limits: { outboundPerChatPerHour: 2 } });
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const theirs = h.chats.keyFor(OTHER, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'one' });
    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey: theirs, text: 'two' });
    h.queue({ turnId: turn.turnId, kind: 'text', text: 'and here is your answer' });
    h.queue({ turnId: turn.turnId, kind: 'text', text: 'and one more' });
    await h.outbox.drain();

    expect(sent.filter((s) => s.jid === OTHER)).toHaveLength(2);
    expect(sent.filter((s) => s.jid === PHONE)).toHaveLength(2);
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

    const id = h.queue({ turnId: turn.turnId, kind: 'contact', number: '15550001111', label: 'Somebody' });
    await h.outbox.drain();

    const written = JSON.parse(readFileSync(h.configFile, 'utf8')) as { agent: { contacts: unknown[] } };
    expect(written.agent.contacts).toEqual([]);
    // And it is told so, rather than left to guess from an empty answer.
    expect(h.answer(id)).toMatchObject({ ok: false });
    expect(h.answer(id)?.error).toContain('operator');
  });

  it('is refused even with agent.crossChat switched on', async () => {
    // The two controls are independent: the flag governs whether an issued key
    // may be addressed, never whether a new one may be minted.
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now, false);

    const id = h.queue({ turnId: turn.turnId, kind: 'contact', number: '15550001111', label: 'Marta' });
    await h.outbox.drain();

    expect(h.answer(id)).toMatchObject({ ok: false });
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

  it('issues a key that is then addressable', async () => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now, true);

    const id = h.queue({ turnId: turn.turnId, kind: 'contact', number: '15550009999', label: 'Marta' });
    await h.outbox.drain();

    const chatKey = h.answer(id)?.items[0]?.url ?? '';
    expect(chatKey).toMatch(/^[0-9a-f]{16}$/);

    // Minting the key sent nothing — that is a separate action, subject to
    // every switch and limit that governs the rest.
    expect(sent).toEqual([]);

    h.queue({ turnId: turn.turnId, kind: 'voice', chatKey, text: 'hello, I am Tulip' });
    await h.outbox.drain();
    expect(sent).toEqual([{ method: 'voice', jid: '15550009999@s.whatsapp.net', detail: undefined }]);
  });
});

/**
 * The other half of the boundary. A destination that is not a key the bridge
 * issued cannot be expressed at all, because the schema is strict — an unknown
 * field is a parse error rather than something stripped and quietly ignored.
 */
describe('the schema still refuses what it always refused', () => {
  it.each([
    ['an unknown field', { kind: 'voice', chatKey: null, text: 'hi', tone: 'warm' }],
    ['a phone number as the destination', { kind: 'voice', chatKey: '15559876543', text: 'hi' }],
    ['a jid as the destination', { kind: 'voice', chatKey: OTHER, text: 'hi' }],
    ['an uppercase key', { kind: 'voice', chatKey: 'FFFFFFFFFFFFFFFF', text: 'hi' }],
    ['a second recipient beside the key', { kind: 'voice', chatKey: null, text: 'hi', to: '15559876543' }],
    ['a destination on a verb that has none', { kind: 'text', text: 'hi', chatKey: null }],
  ])('rejects %s, and sends nothing', async (_label, action) => {
    const h = await harness();
    const now = Date.now();
    const mine = h.chats.keyFor(PHONE, false, now);
    const turn = h.turns.open(PHONE, mine, now);

    h.queue({ turnId: turn.turnId, ...action });
    await h.outbox.drain();

    expect(sent).toEqual([]);
    // Rejected outright rather than retried: it can never become valid, and a
    // directory that grows forever is something a compromised agent can arrange.
    expect(readdirSync(join(process.env['TULIP_OUT_DIR'] ?? '', 'actions'))).toEqual([]);
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
