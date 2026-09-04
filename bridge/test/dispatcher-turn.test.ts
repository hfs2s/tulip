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

function build() {
  const dir = mkdtempSync(join(tmpdir(), 'tulip-d-'));
  roots.push(dir);
  const config = parseConfig({
    audience: { everyone: true },
    // Short debounce so the test is not waiting on a three-second timer.
    delivery: { debounceMs: 0 },
  });
  const chats = new ChatRegistry(join(dir, 'salt'), join(dir, 'chats.json'));
  const dispatcher = new Dispatcher({
    wa: { sendText: async () => {}, typing: async () => {} } as never,
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

beforeEach(() => { busyTurn = null; retired.length = 0; });
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
