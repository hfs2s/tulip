/**
 * Who may read whose conversation.
 *
 * This is the only capability that fetches inward, and every other part of the
 * design assumes it does not exist: chat isolation is structural, so there is
 * normally nothing to leak rather than a rule against leaking it. Opening a
 * hole in that means the gate is the whole of the protection, and a gate is
 * exactly the sort of thing that is subtly wrong in one of eight cases.
 *
 * The case that matters most is the group. `carriesOperatorAuthority`
 * deliberately allows one — an operator saying "message this number" in a room
 * they are in is reasonable, and minting a key tells the room nothing. Recall
 * inverts that: the answer is somebody else's private messages, spoken into
 * whatever room the question was asked in.
 */
import { describe, expect, it } from 'vitest';
import { canRecall } from '../src/recall.js';

const request = (over: Partial<Parameters<typeof canRecall>[0]> = {}): Parameters<typeof canRecall>[0] => ({
  enabled: true,
  fromOperator: true,
  askedInGroup: false,
  ...over,
});

describe('canRecall — the one case that is allowed', () => {
  it('allows an operator asking in a direct message, with the switch on', () => {
    expect(canRecall(request())).toEqual({ allowed: true });
  });
});

describe('canRecall — every case that is not', () => {
  it('refuses when the operator has not switched it on', () => {
    expect(canRecall(request({ enabled: false })).allowed).toBe(false);
  });

  it('refuses a stranger, however they ask', () => {
    expect(canRecall(request({ fromOperator: false })).allowed).toBe(false);
  });

  it('refuses in a group even when an operator is the one asking', () => {
    // The failure this gate exists for. `fromOperator` is true here — an
    // operator really did send the message — and it must still be refused,
    // because the room is full of people who did not ask.
    expect(canRecall(request({ askedInGroup: true })).allowed).toBe(false);
  });

  it('refuses a stranger in a group', () => {
    expect(canRecall(request({ fromOperator: false, askedInGroup: true })).allowed).toBe(false);
  });

  it('refuses everything when the switch is off, whoever is asking', () => {
    for (const fromOperator of [true, false]) {
      for (const askedInGroup of [true, false]) {
        expect(canRecall(request({ enabled: false, fromOperator, askedInGroup })).allowed).toBe(false);
      }
    }
  });
});

describe('canRecall — what the refusal says', () => {
  it('blames the switch first, so a stranger learns nothing about who they are', () => {
    // "You are not an operator" would confirm that recall exists and is
    // available to somebody. "Switched off" is true and tells them nothing.
    const off = canRecall(request({ enabled: false, fromOperator: false }));
    expect(!off.allowed && off.reason).toContain('switched off');
    expect(!off.allowed && off.reason).not.toContain('operator can ask');
  });

  it('tells an operator in a group where to ask instead', () => {
    const grouped = canRecall(request({ askedInGroup: true }));
    expect(!grouped.allowed && grouped.reason).toContain('direct message');
  });

  it('tells the agent what to say rather than only what it cannot do', () => {
    // A refusal the agent cannot act on becomes the agent explaining the
    // system's internals to whoever asked.
    const stranger = canRecall(request({ fromOperator: false }));
    expect(!stranger.allowed && stranger.reason).toContain('do not discuss other chats');
  });

  it('never leaks a chat key or a name in a refusal', () => {
    for (const over of [{ enabled: false }, { fromOperator: false }, { askedInGroup: true }]) {
      const verdict = canRecall(request(over));
      expect(!verdict.allowed && verdict.reason).not.toMatch(/[0-9a-f]{16}/);
    }
  });
});
