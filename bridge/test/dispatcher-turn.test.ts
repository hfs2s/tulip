/**
 * The turn lifecycle, which had no tests and shipped a user-visible bug.
 *
 * `pump` used to loop `while (this.ready.length > 0)`, and `awaitTurnEnd` is
 * only reached at the top of that loop. So after the *last* batch was delivered
 * the loop exited with the turn still open — and the common case is exactly
 * that: one message, one reply, nothing else queued.
 *
 * Nothing then closed the turn, so `turnEnd` never fired (the typing indicator
 * stayed on), `retireBatch` never ran (the agent was re-prompted with a batch it
 * had already answered), and the turn sat open until its TTL. It all recovered
 * on the next inbound message, which is what made it look intermittent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];
const root = mkdtempSync(join(tmpdir(), 'tulip-dispatch-'));
roots.push(root);
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

/** What the agent is currently reporting. Driven per test. */
let busyTurn: string | null = null;
const retired: string[] = [];

vi.mock('../src/handoff.js', () => ({
  ensureHandoffDirs: () => {},
  publishTurn: () => {},
  readStatus: () => ({ busyTurn, reporting: true, fatal: null, sessions: [] }),
  retireBatch: (turnId: string) => { retired.push(turnId); },
}));

const { Dispatcher } = await import('../src/dispatcher.js');
const { TurnRegistry } = await import('../src/turns.js');
const { Limiter } = await import('../src/ratelimit.js');
const { ChatRegistry } = await import('../src/chats.js');
const { parseConfig } = await import('../src/config.js');

function envelope(id: string, chatJid = '15551234567@s.whatsapp.net') {
  return {
    id, ts: Date.now(), chatJid, isGroup: false, groupName: null,
    senderIds: ['15551234567'], pushName: 'Someone', text: 'hello',
    mentionsMe: false, quoted: null, media: [], isReaction: false, isPollVote: false,
  };
}

function build(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tulip-d-'));
  roots.push(dir);
  const config = parseConfig({
    audience: { everyone: true },
    // Short debounce so the test is not waiting on a three-second timer.
    delivery: { debounceMs: 0 },
    ...overrides,
  });
  const chats = new ChatRegistry(join(dir, 'salt'), join(dir, 'chats.json'));
  const dispatcher = new Dispatcher({
    wa: { sendText: async () => {}, typing: async () => {}, readReceipt: async () => {} } as never,
    chats,
    limiter: new Limiter(
      { messagesPerHour: 1000, burst: 100, turnsPerDay: 1000, newSendersPerHour: 1000, outboundPerChatPerHour: 1000 },
      join(dir, 'senders.json'),
    ),
    turns: new TurnRegistry(600_000, 20),
    config,
    onControl: async () => {},
  });
  return { dispatcher, chats };
}

beforeEach(() => {
  busyTurn = null;
  retired.length = 0;
  // The Dispatcher builds its own Queue against the shared state dir, and the
  // queue is durable on purpose. Cleared between tests so one test's backlog is
  // not another's starting condition.
  rmSync(join(root, 'queue'), { recursive: true, force: true });
});
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('a turn is closed even when nothing else is queued', () => {
  it('fires turnEnd, retires the batch and clears inFlight', async () => {
    const { dispatcher, chats } = build();
    const ended: string[] = [];
    dispatcher.on('turnEnd', (e: { turnId: string }) => ended.push(e.turnId));

    const chatKey = chats.keyFor('15551234567@s.whatsapp.net', false, Date.now());
    // The agent picks the turn up, then goes idle — the ordinary happy path.
    dispatcher.on('turnStart', (e: { turnId: string }) => {
      busyTurn = e.turnId;
      setTimeout(() => { busyTurn = null; }, 50);
    });

    (dispatcher as unknown as { pending: Map<string, unknown[]>; ready: string[] }).pending.set(
      chatKey, [{ chatKey, envelope: envelope('m1') }],
    );
    (dispatcher as unknown as { ready: string[] }).ready.push(chatKey);

    await dispatcher.pump();

    expect(dispatcher.snapshot().inFlight).toBeNull();
    expect(ended).toHaveLength(1);
    // The batch must be retired, or the agent is handed it again next turn.
    expect(retired).toEqual(ended);
  }, 20_000);

  it('leaves nothing in flight after the queue drains', async () => {
    const { dispatcher, chats } = build();
    const chatKey = chats.keyFor('15551234567@s.whatsapp.net', false, Date.now());
    dispatcher.on('turnStart', (e: { turnId: string }) => {
      busyTurn = e.turnId;
      setTimeout(() => { busyTurn = null; }, 30);
    });

    (dispatcher as unknown as { pending: Map<string, unknown[]> }).pending.set(
      chatKey, [{ chatKey, envelope: envelope('m1') }, { chatKey, envelope: envelope('m2') }],
    );
    (dispatcher as unknown as { ready: string[] }).ready.push(chatKey);

    await dispatcher.pump();

    const snap = dispatcher.snapshot();
    expect(snap.inFlight).toBeNull();
    expect(snap.ready).toBe(0);
  }, 20_000);
});

/**
 * Whether the typing indicator is honest.
 *
 * Judgement mode starts a turn for every group message and the agent stays quiet
 * for most of them. Showing "typing…" at turn start meant a room watched Juan
 * compose a reply to a conversation he was not part of, and then nothing came —
 * which reads as broken, and interrupts the room to announce a message that
 * never arrives. `addressed` is what the indicator hangs on.
 */
describe('whether a turn was addressed to us', () => {
  function firstTurnStart(dispatcher) {
    return new Promise((resolve) => dispatcher.once('turnStart', resolve));
  }

  async function turnStartFor(mutate, overrides = {}) {
    const { dispatcher } = build(overrides);
    dispatcher.on('turnStart', (e) => {
      busyTurn = e.turnId;
      setTimeout(() => { busyTurn = null; }, 20);
    });
    const started = firstTurnStart(dispatcher);
    const message = {
      key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Someone',
      message: { conversation: 'are you here, Maria?' },
    };
    mutate(message);
    await dispatcher.handle(message);
    void dispatcher.pump();
    return started;
  }

  it('is true for a direct message, which is addressed by definition', async () => {
    const event = await turnStartFor(() => {});
    expect(event.addressed).toBe(true);
  }, 20_000);

  it('is false for a group message that did not mention us', async () => {
    // Judgement mode: the gate lets every group message through and the agent
    // decides. This is the mode the false indicator showed up in.
    const event = await turnStartFor(
      (m) => {
        m.key.remoteJid = '120363000000000000@g.us';
        m.key.participant = '15551234567@s.whatsapp.net';
      },
      { groups: { enabled: true, replyTo: 'observe' } },
    );
    expect(event.addressed).toBe(false);
  }, 20_000);
});

/**
 * The operator's label for a contact, against the name the sender supplies.
 *
 * `syncContacts` promises the operator's label wins over the WhatsApp display
 * name, "which is supplied by the other end and is not trustworthy", and the
 * Settings page prints that promise. `touch` then did an unconditional
 * `Object.assign`, so the first accepted inbound message from that contact
 * overwrote it with their own push name. That label is not decoration: it is
 * the only thing the agent is shown for a contact, and the contact list is what
 * authorises the agent to open a conversation at all — so a sender could dress
 * as somebody the operator had vouched for.
 */
describe('a contact that an operator named by hand', () => {
  it('keeps that name when the contact messages in', async () => {
    const { dispatcher, chats } = build();
    chats.syncContacts([{ label: 'Mum', number: '15551234567' }], Date.now());
    const chatKey = chats.keyFor('15551234567@s.whatsapp.net', false, Date.now());
    expect(chats.get(chatKey)?.name).toBe('Mum');

    await dispatcher.handle({
      key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Definitely Not Mum',
      message: { conversation: 'hello' },
    } as never);

    expect(chats.get(chatKey)?.name).toBe('Mum');
    // Still counted: only the name is protected.
    expect(chats.get(chatKey)?.messages).toBe(1);
  });

  it('still takes the display name for an ordinary chat', async () => {
    const { dispatcher, chats } = build();
    const chatKey = chats.keyFor('15559998888@s.whatsapp.net', false, Date.now());

    await dispatcher.handle({
      key: { remoteJid: '15559998888@s.whatsapp.net', fromMe: false, id: 'm1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Someone New',
      message: { conversation: 'hello' },
    } as never);

    expect(chats.get(chatKey)?.name).toBe('Someone New');
  });
});

/**
 * The watchdog's stated signal, which was not implemented.
 *
 * `index.ts` opens by naming it — "delivered but unanswered, which is what a
 * person on the other end actually experiences, rather than queue depth" — and
 * recounts the Iris failure it exists for: every turn failing instantly, an
 * empty queue, a healthy process, nobody answered for two weeks. The watchdog
 * only ever checked the agent's self-reported status, so an agent that wedged
 * without declaring a fatal state told nobody. `delivery.stuckAfterMs` was the
 * knob for it and was read by no code at all.
 */
describe('how long anybody has been waiting', () => {
  it('starts the clock when a real message is accepted', async () => {
    const { dispatcher } = build();
    expect(dispatcher.snapshot().waitingSince).toBeNull();

    const before = Date.now();
    await dispatcher.handle({
      key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm1' },
      messageTimestamp: Math.floor(before / 1000),
      pushName: 'Someone',
      message: { conversation: 'hello' },
    } as never);

    const waiting = dispatcher.snapshot().waitingSince;
    expect(waiting).not.toBeNull();
    expect(waiting as number).toBeGreaterThanOrEqual(before);
  });

  it('starts it for a backlog restored from disk, which no arrival was seen for', async () => {
    const first = build();
    await first.dispatcher.handle({
      key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm1' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Someone',
      message: { conversation: 'hello' },
    } as never);

    // A restart: a fresh dispatcher over the same durable queue. Nothing told
    // it when that message arrived, and the alert this feeds is exactly the one
    // an operator wants for a backlog that survived a restart.
    const second = build();
    expect(second.dispatcher.snapshot().queued).toBeGreaterThan(0);
    expect(second.dispatcher.snapshot().waitingSince).not.toBeNull();
  });

  it('stops the clock only once nothing is outstanding', async () => {
    const { dispatcher, chats } = build();
    const chatKey = chats.keyFor('15551234567@s.whatsapp.net', false, Date.now());
    dispatcher.on('turnStart', (e: { turnId: string }) => {
      busyTurn = e.turnId;
      setTimeout(() => { busyTurn = null; }, 30);
    });

    (dispatcher as unknown as { pending: Map<string, unknown[]> }).pending.set(
      chatKey, [{ chatKey, envelope: envelope('m1') }],
    );
    (dispatcher as unknown as { ready: string[] }).ready.push(chatKey);
    (dispatcher as unknown as { waitingSince: number | null }).waitingSince = Date.now();

    await dispatcher.pump();

    // Answered and drained: the alert must re-arm, so this has to reach null.
    expect(dispatcher.snapshot().waitingSince).toBeNull();
  }, 20_000);
});
