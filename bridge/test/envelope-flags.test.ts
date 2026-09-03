import { describe, expect, it } from 'vitest';
import { gate, type GateInput } from '../src/gate.js';
import { parseConfig } from '../src/config.js';

/**
 * Baileys decodes a protobuf message with *every* field present, setting the
 * unset ones to `null`. So a field test written as `!== undefined` is true for
 * an ordinary text message, and `isReaction` was computed that way.
 *
 * The effect in production was total and silent: every message a real person
 * sent was classified as a reaction, and the gate refuses those by design —
 * "recorded, not answered". Nobody was ever answered, nothing looked broken,
 * and the feed dutifully recorded the reason. Caught by the first real message.
 *
 * These assert the shape of the decoded content rather than the parser's
 * internals, so they keep holding if the parser is rewritten.
 */
const message = (over: Partial<GateInput> = {}): GateInput => ({
  senderIds: ['15551234567'],
  text: 'How you doing?',
  isGroup: false,
  mentionsMe: false,
  isReaction: false,
  isPollVote: false,
  ...over,
});

const open = parseConfig({ audience: { everyone: true } });

describe('null-versus-undefined in decoded messages', () => {
  it('answers an ordinary text message', () => {
    expect(gate(message(), open)).toEqual({ accept: true });
  });

  it('still refuses a genuine reaction', () => {
    expect(gate(message({ isReaction: true }), open)).toEqual({
      accept: false,
      reason: 'reaction — recorded, not answered',
    });
  });

  // The distinction the bug turned on, asserted directly so the reasoning is
  // visible to whoever writes the next field test against a decoded message.
  it('treats a null field as absent, not as present', () => {
    const decoded: Record<string, unknown> = { conversation: 'hi', reactionMessage: null };
    expect(decoded['reactionMessage'] !== undefined).toBe(true); // the bug
    expect(decoded['reactionMessage'] != null).toBe(false); // the fix
  });
});
