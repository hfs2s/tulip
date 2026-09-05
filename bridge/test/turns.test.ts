import { describe, expect, it } from 'vitest';
import { TurnRegistry } from '../src/turns.js';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const TTL = 600_000; // ten minutes
const MAX_SENDS = 8;

const registry = (): TurnRegistry => new TurnRegistry(TTL, MAX_SENDS);

describe('TurnRegistry — resolving a turn to its chat', () => {
  it('resolves a turn it issued to the chat it was issued for', () => {
    const turns = registry();
    const turn = turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);

    const resolved = turns.resolve(turn.turnId, T0 + 1000);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.turn.chatJid).toBe('15551234567@s.whatsapp.net');
      expect(resolved.turn.chatKey).toBe('aaaaaaaaaaaaaaaa');
    }
  });

  it('issues unguessable, distinct ids', () => {
    const turns = registry();
    const ids = new Set(
      Array.from({ length: 100 }, (_, i) => turns.open(`${i}@s.whatsapp.net`, 'aaaaaaaaaaaaaaaa', T0).turnId),
    );
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

// The reason this class exists. A compromised agent may write anything into the
// outbox; none of it may cause a message to reach a chat it was not answering.
describe('TurnRegistry — cross-chat exfiltration', () => {
  it('refuses an id that was never issued', () => {
    const turns = registry();
    turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);

    expect(turns.resolve('11111111-2222-4333-8444-555555555555', T0)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { turnId: 'x' }],
    ['an array', []],
    ['an empty string', ''],
  ])('refuses %s as a turn id without throwing', (_label, value) => {
    const turns = registry();
    expect(turns.resolve(value, T0)).toEqual({ ok: false, reason: 'unknown' });
  });

  it("refuses another chat's turn id, because the agent cannot guess one", () => {
    const turns = registry();
    const mine = turns.open('15551111111@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);
    const theirs = turns.open('15552222222@s.whatsapp.net', 'bbbbbbbbbbbbbbbb', T0);

    // Both resolve — but each only ever to its own chat. There is no argument
    // by which an action stamped with `mine` reaches the other conversation.
    const a = turns.resolve(mine.turnId, T0);
    const b = turns.resolve(theirs.turnId, T0);
    expect(a.ok && a.turn.chatJid).toBe('15551111111@s.whatsapp.net');
    expect(b.ok && b.turn.chatJid).toBe('15552222222@s.whatsapp.net');
  });
});

describe('TurnRegistry — expiry', () => {
  it('refuses a turn past its time to live', () => {
    const turns = registry();
    const turn = turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);

    expect(turns.resolve(turn.turnId, T0 + TTL).ok).toBe(true);
    expect(turns.resolve(turn.turnId, T0 + TTL + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  // Without this, an agent could hold a turn id and push messages into a
  // conversation the person had long since moved on from.
  it('expires even a turn that was never closed', () => {
    const turns = registry();
    const turn = turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);
    expect(turn.closedAt).toBeNull();
    expect(turns.resolve(turn.turnId, T0 + TTL * 2).ok).toBe(false);
  });

  // The agent's final message is often queued microseconds after the Stop hook
  // fires; refusing it would drop the actual reply.
  it('still resolves a closed turn until it expires', () => {
    const turns = registry();
    const turn = turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);
    turns.close(turn.turnId, T0 + 5000);
    expect(turns.resolve(turn.turnId, T0 + 6000).ok).toBe(true);
  });

  it('drops expired turns from memory rather than growing without bound', () => {
    const turns = registry();
    for (let i = 0; i < 50; i++) turns.open(`${i}@s.whatsapp.net`, 'aaaaaaaaaaaaaaaa', T0);
    expect(turns.size).toBe(50);
    turns.open('fresh@s.whatsapp.net', 'bbbbbbbbbbbbbbbb', T0 + TTL + 1);
    expect(turns.size).toBe(1);
  });

  it('evicts oldest-first when over capacity', () => {
    // (ttl, maxSends, maxTools, capacity) — capacity moved along one when
    // tools got a budget of their own.
    const turns = new TurnRegistry(TTL, MAX_SENDS, 24, 10);
    const first = turns.open('first@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);
    for (let i = 0; i < 20; i++) turns.open(`${i}@s.whatsapp.net`, 'aaaaaaaaaaaaaaaa', T0);
    expect(turns.size).toBe(10);
    expect(turns.resolve(first.turnId, T0)).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('TurnRegistry — send allowance', () => {
  it('permits up to the limit and then refuses', () => {
    const turns = registry();
    const turn = turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);

    for (let i = 0; i < MAX_SENDS; i++) {
      expect(turns.resolve(turn.turnId, T0).ok).toBe(true);
      turns.countSend(turn.turnId);
    }
    expect(turns.resolve(turn.turnId, T0)).toEqual({ ok: false, reason: 'send limit reached' });
  });

  it('counts allowance per turn, not globally', () => {
    const turns = registry();
    const a = turns.open('a@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);
    const b = turns.open('b@s.whatsapp.net', 'bbbbbbbbbbbbbbbb', T0);

    for (let i = 0; i < MAX_SENDS; i++) turns.countSend(a.turnId);
    expect(turns.resolve(a.turnId, T0).ok).toBe(false);
    expect(turns.resolve(b.turnId, T0).ok).toBe(true);
  });

  it('ignores a countSend for an id it does not know', () => {
    const turns = registry();
    expect(() => turns.countSend('11111111-2222-4333-8444-555555555555')).not.toThrow();
  });
});

describe('TurnRegistry — openFor', () => {
  it('finds the open turn for a chat', () => {
    const turns = registry();
    const turn = turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);
    expect(turns.openFor('aaaaaaaaaaaaaaaa', T0)?.turnId).toBe(turn.turnId);
  });

  it('does not report a closed or expired turn as open', () => {
    const turns = registry();
    const turn = turns.open('15551234567@s.whatsapp.net', 'aaaaaaaaaaaaaaaa', T0);
    turns.close(turn.turnId, T0 + 100);
    expect(turns.openFor('aaaaaaaaaaaaaaaa', T0 + 200)).toBeNull();

    const other = registry();
    other.open('x@s.whatsapp.net', 'cccccccccccccccc', T0);
    expect(other.openFor('cccccccccccccccc', T0 + TTL + 1)).toBeNull();
  });

  it('returns null for a chat with nothing open', () => {
    expect(registry().openFor('dddddddddddddddd', T0)).toBeNull();
  });
});
