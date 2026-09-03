import { describe, expect, it } from 'vitest';
import { chatKeyFor, newSalt, sessionUuidFor, uuidV5 } from '../src/ids.js';

const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);
const JID = '15551234567@s.whatsapp.net';

describe('chatKeyFor', () => {
  it('is 16 lowercase hex characters', () => {
    expect(chatKeyFor(JID, SALT_A)).toMatch(/^[0-9a-f]{16}$/);
  });

  // Stability is the whole reason the agent can keep per-chat state at all.
  it('is stable for the same chat and salt', () => {
    expect(chatKeyFor(JID, SALT_A)).toBe(chatKeyFor(JID, SALT_A));
  });

  it('differs per chat', () => {
    expect(chatKeyFor(JID, SALT_A)).not.toBe(chatKeyFor('15559999999@s.whatsapp.net', SALT_A));
  });

  // The property that makes the key opaque. Phone numbers are a small enough
  // space to enumerate exhaustively, so an unkeyed hash of one would be
  // reversible in minutes by anyone reading this public repository.
  it('differs per salt, so the mapping is not global knowledge', () => {
    expect(chatKeyFor(JID, SALT_A)).not.toBe(chatKeyFor(JID, SALT_B));
  });

  it('refuses to derive a key without a salt rather than producing a weak one', () => {
    expect(() => chatKeyFor(JID, '')).toThrow(/without a salt/);
  });

  it('distinguishes a group from a direct chat with the same digits', () => {
    expect(chatKeyFor('15551234567@g.us', SALT_A)).not.toBe(chatKeyFor(JID, SALT_A));
  });
});

describe('newSalt', () => {
  it('is 32 bytes of hex', () => {
    expect(newSalt()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is different every time', () => {
    expect(new Set(Array.from({ length: 20 }, () => newSalt())).size).toBe(20);
  });
});

describe('uuidV5', () => {
  it('produces a well-formed version 5 UUID', () => {
    expect(uuidV5('anything')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is deterministic', () => {
    expect(uuidV5('tulip:abc')).toBe(uuidV5('tulip:abc'));
    expect(uuidV5('tulip:abc')).not.toBe(uuidV5('tulip:abd'));
  });
});

describe('sessionUuidFor', () => {
  const key = 'a1b2c3d4e5f60718';

  // This is the resumability story: nothing is stored, so deleting the
  // container or rebooting the host loses no context.
  it('is a pure function of the chat key', () => {
    expect(sessionUuidFor(key)).toBe(sessionUuidFor(key));
    expect(sessionUuidFor(key)).toBe(sessionUuidFor(key, 0));
  });

  it('changes with the generation, which is how a context is abandoned', () => {
    expect(sessionUuidFor(key, 1)).not.toBe(sessionUuidFor(key));
    expect(sessionUuidFor(key, 2)).not.toBe(sessionUuidFor(key, 1));
    // ...and the old one is still addressable, so the transcript is not lost.
    expect(sessionUuidFor(key, 0)).toBe(sessionUuidFor(key));
  });

  it('gives different chats different sessions', () => {
    expect(sessionUuidFor('1111111111111111')).not.toBe(sessionUuidFor('2222222222222222'));
  });
});
