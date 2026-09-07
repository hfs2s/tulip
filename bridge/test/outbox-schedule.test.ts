/**
 * The seam between the agent's request and the bridge's store.
 *
 * `schedule.test.ts` proves the store and the ticker behave; this proves the
 * three things that can only go wrong in the wiring, and each of them is a
 * different way for a promise to be broken quietly:
 *
 *   - **the destination comes from the turn.** The action has no field for one,
 *     so the only way it could reach the wrong chat is if this case read the
 *     wrong variable — which is exactly the bug `outbox-destinations.test.ts`
 *     exists for on the immediate verbs.
 *   - **a refusal is answered, not swallowed.** An action file is deleted
 *     whether it was performed or discarded, and from inside the agent those
 *     are the same observation. A scheduling refusal that produced no answer
 *     file would read as success and be relayed as one.
 *   - **it is charged as a tool, not a send.** It delivers nothing at the time
 *     it is called. Charging it as a send would let three reminders eat a
 *     turn's whole reply allowance, and the message telling somebody the
 *     reminder is set would then be refused — which is the precise failure the
 *     two budgets were separated to prevent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MADRID = 'Europe/Madrid';
const PHONE = '15551234567@s.whatsapp.net';
const OTHER = '15559876543@s.whatsapp.net';
const NOW = Date.parse('2026-09-25T10:00:00.000Z');
const TOMORROW_9 = '2026-09-26T07:00:00.000Z';

let roots: string[] = [];
let sent: Array<{ jid: string; text: string }> = [];

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
  sent = [];
});

async function harness(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tulip-osched-'));
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
  const { readSchedule, Scheduler } = await import('../src/schedule.js');
  const { outPaths, inPaths } = await import('@tulip/shared');

  const config = parseConfig({ timezone: MADRID, ...overrides });
  const chats = new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
  const turns = new TurnRegistry(config.limits.turnTimeoutMs, config.limits.outboundPerTurn, config.limits.toolsPerTurn);
  const limiter = new Limiter({
    messagesPerHour: 1000,
    burst: 50,
    turnsPerDay: 1000,
    newSendersPerHour: 1000,
    outboundPerChatPerHour: config.limits.outboundPerChatPerHour,
  });
  const wa = {
    sendText: async (jid: string, text: string) => {
      sent.push({ jid, text });
    },
    sendVoice: async () => undefined,
    sendImage: async () => undefined,
    sendFile: async () => undefined,
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
    setPagePasswords: () => undefined,
  });

  return {
    outbox,
    config,
    readSchedule,
    scheduler: new Scheduler({ wa: wa as never, config, chats, limiter }),
    chats: chats as never as { keyFor: (jid: string, group: boolean, now: number) => string },
    turns: turns as never as { open: (jid: string, key: string, now: number) => { turnId: string; tools: number; sends: number } },
    queue: (action: Record<string, unknown>): string => {
      const id = randomUUID();
      writeFileSync(outPaths.action(id), JSON.stringify({ id, ...action }));
      return id;
    },
    answer: (id: string) => {
      try {
        return JSON.parse(readFileSync(inPaths.result(id), 'utf8')) as {
          ok: boolean;
          error: string | null;
          items: Array<{ title: string; url: string; published: string | null; text: string }>;
        };
      } catch {
        return null;
      }
    },
  };
}

describe('an agent asking for a reminder', () => {
  it('stamps it with the turn’s own chat, which is the only address it has', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    h.chats.keyFor(OTHER, false, NOW);
    const turn = h.turns.open(PHONE, mine, Date.now());

    h.queue({ turnId: turn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'the meetup is on the 28th' });
    await h.outbox.drain();

    const stored = h.readSchedule();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.chatKey).toBe(mine);
    expect(stored[0]?.createdBy).toBe('agent');
    // And it really does reach that chat and no other when it comes due.
    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent).toEqual([{ jid: PHONE, text: 'the meetup is on the 28th' }]);
  });

  it('answers with the resolved absolute time and the id, so it can be quoted', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const turn = h.turns.open(PHONE, mine, Date.now());

    const id = h.queue({ turnId: turn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'x' });
    await h.outbox.drain();

    const answer = h.answer(id);
    expect(answer?.ok).toBe(true);
    // 07:00Z is 09:00 in Madrid. The agent must quote *that*, not the UTC
    // instant its own shell would print, and not the words it was given.
    expect(answer?.items[0]?.url).toContain('09:00');
    expect(answer?.items[0]?.url).toContain('CEST');
    expect(answer?.items[0]?.title).toBe(h.readSchedule()[0]?.id);
  });

  it('spends the turn’s tool budget rather than its reply allowance', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const turn = h.turns.open(PHONE, mine, Date.now());

    h.queue({ turnId: turn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'x' });
    await h.outbox.drain();

    expect(turn.tools).toBe(1);
    // Zero. Otherwise setting three reminders would eat a turn's replies and
    // the message saying "that is set" would be refused.
    expect(turn.sends).toBe(0);
  });

  it('records it loudly in the feed, like a remembered note', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const turn = h.turns.open(PHONE, mine, Date.now());
    const { paths } = await import('../src/paths.js');

    h.queue({ turnId: turn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'water the plants' });
    await h.outbox.drain();

    const rows = readFileSync(paths.feed, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as { event?: string; detail?: string });
    const created = rows.find((r) => r.event === 'schedule.created');
    expect(created).toBeDefined();
    expect(created?.detail).toContain('water the plants');
    expect(created?.detail).toContain('09:00');
  });
});

describe('when the operator has switched reminders off', () => {
  it('refuses in words the agent can relay, rather than dropping the action', async () => {
    const h = await harness({ agent: { schedule: false } });
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const turn = h.turns.open(PHONE, mine, Date.now());

    const id = h.queue({ turnId: turn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'x' });
    await h.outbox.drain();

    const answer = h.answer(id);
    expect(answer?.ok).toBe(false);
    expect(answer?.error).toContain('switched off');
    // The instruction matters as much as the refusal: the failure being fixed
    // is a promise made in words that nothing could keep.
    expect(answer?.error).toContain('do not');
    expect(h.readSchedule()).toHaveLength(0);
  });
});

describe('listing and cancelling from a turn', () => {
  it('lists this chat’s reminders and nobody else’s', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const theirs = h.chats.keyFor(OTHER, false, NOW);
    const myTurn = h.turns.open(PHONE, mine, Date.now());
    const theirTurn = h.turns.open(OTHER, theirs, Date.now());

    h.queue({ turnId: myTurn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'mine' });
    h.queue({ turnId: theirTurn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'theirs' });
    await h.outbox.drain();

    const listing = h.queue({ turnId: myTurn.turnId, kind: 'scheduleList' });
    await h.outbox.drain();
    const answer = h.answer(listing);
    expect(answer?.ok).toBe(true);
    expect(answer?.items.map((i) => i.text)).toEqual(['mine']);
  });

  it('will not cancel another conversation’s, and says the same thing as for a bad id', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const theirs = h.chats.keyFor(OTHER, false, NOW);
    const myTurn = h.turns.open(PHONE, mine, Date.now());
    const theirTurn = h.turns.open(OTHER, theirs, Date.now());

    h.queue({ turnId: theirTurn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'theirs' });
    await h.outbox.drain();
    const target = h.readSchedule()[0]?.id as string;

    const crossed = h.queue({ turnId: myTurn.turnId, kind: 'scheduleCancel', scheduleId: target });
    const invented = h.queue({
      turnId: myTurn.turnId,
      kind: 'scheduleCancel',
      scheduleId: '11111111-2222-4333-8444-555555555555',
    });
    await h.outbox.drain();

    expect(h.answer(crossed)?.ok).toBe(false);
    expect(h.answer(crossed)?.error).toBe(h.answer(invented)?.error);
    expect(h.readSchedule()[0]?.state).toBe('active');
  });

  it('cancels its own', async () => {
    const h = await harness();
    const mine = h.chats.keyFor(PHONE, false, NOW);
    const turn = h.turns.open(PHONE, mine, Date.now());

    h.queue({ turnId: turn.turnId, kind: 'schedule', spec: { kind: 'once', at: TOMORROW_9 }, text: 'x' });
    await h.outbox.drain();
    const target = h.readSchedule()[0]?.id as string;

    h.queue({ turnId: turn.turnId, kind: 'scheduleCancel', scheduleId: target });
    await h.outbox.drain();
    expect(h.readSchedule()[0]?.state).toBe('cancelled');

    await h.scheduler.tick(Date.parse('2026-09-26T07:00:05.000Z'));
    expect(sent).toHaveLength(0);
  });
});
