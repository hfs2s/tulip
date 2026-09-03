import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { gate, isOperator, type GateInput } from '../src/gate.js';

const message = (over: Partial<GateInput> = {}): GateInput => ({
  senderIds: ['15551234567', '15551234567@s.whatsapp.net'],
  text: 'hello',
  isGroup: false,
  mentionsMe: false,
  isReaction: false,
  isPollVote: false,
  ...over,
});

describe('gate — a public deployment', () => {
  const config = parseConfig({ audience: { everyone: true } });

  it('answers a stranger', () => {
    expect(gate(message(), config)).toEqual({ accept: true });
  });

  it('still refuses a reaction', () => {
    expect(gate(message({ isReaction: true }), config).accept).toBe(false);
  });

  it('still refuses a poll vote', () => {
    expect(gate(message({ isPollVote: true }), config).accept).toBe(false);
  });

  it('refuses a message with no text', () => {
    expect(gate(message({ text: '   ' }), config)).toEqual({
      accept: false,
      reason: 'no text content',
    });
  });

  it('refuses groups, which are off by default even when everyone is on', () => {
    expect(gate(message({ isGroup: true }), config)).toEqual({
      accept: false,
      reason: 'groups are disabled',
    });
  });
});

describe('gate — a closed deployment', () => {
  const config = parseConfig({ audience: { everyone: false, numbers: ['15551234567'] } });

  it('answers a listed number', () => {
    expect(gate(message(), config).accept).toBe(true);
  });

  it('refuses an unlisted number', () => {
    expect(gate(message({ senderIds: ['15559999999'] }), config)).toEqual({
      accept: false,
      reason: 'sender is not on the allow list',
    });
  });

  // WhatsApp increasingly delivers senders as a bare @lid with no phone number
  // attached. Listing the number then looks correct and silently does nothing.
  it('refuses a sender known only by linked id, and says why', () => {
    const verdict = gate(message({ senderIds: ['111111111111111@lid'] }), config);
    expect(verdict).toEqual({ accept: false, reason: 'sender is not on the allow list' });
  });

  // The other half of that: a linked id can be allowed explicitly, because it
  // is the only identifier some senders ever arrive under. Found the hard way —
  // the first real operator message was refused for exactly this reason.
  it('answers a linked id that is listed in jids', () => {
    const byLid = parseConfig({
      audience: { everyone: false, jids: ['111111111111111@lid'] },
    });
    expect(gate(message({ senderIds: ['111111111111111@lid', '111111111111111'] }), byLid).accept).toBe(true);
  });

  it('accepts a linked id written with or without the @lid suffix', () => {
    for (const entry of ['111111111111111@lid', '111111111111111']) {
      const cfg = parseConfig({ audience: { everyone: false, jids: [entry] } });
      expect(gate(message({ senderIds: ['111111111111111@lid'] }), cfg).accept).toBe(true);
    }
  });

  it('does not let a listed linked id match a different one', () => {
    const byLid = parseConfig({ audience: { everyone: false, jids: ['111111111111111@lid'] } });
    expect(gate(message({ senderIds: ['222222222222222@lid'] }), byLid).accept).toBe(false);
  });

  it('matches on any of the sender identities', () => {
    expect(gate(message({ senderIds: ['111111111111111@lid', '15551234567'] }), config).accept).toBe(true);
  });

  // Matching is exact, not substring: neither a prefix of an allowed number nor
  // a number that has one as its prefix may be admitted.
  it('does not match a number that merely overlaps an allowed one', () => {
    expect(gate(message({ senderIds: ['1555123456'] }), config).accept).toBe(false);
    expect(gate(message({ senderIds: ['155512345678'] }), config).accept).toBe(false);
  });
});

describe('gate — groups', () => {
  const mentionOnly = parseConfig({
    audience: { everyone: true },
    groups: { enabled: true, replyTo: 'mention' },
  });
  const triggered = parseConfig({
    audience: { everyone: true },
    groups: { enabled: true, replyTo: 'trigger', triggers: ['tulip'] },
  });

  it('answers a real mention', () => {
    expect(gate(message({ isGroup: true, mentionsMe: true }), mentionOnly).accept).toBe(true);
  });

  it('ignores an unaddressed group message', () => {
    expect(gate(message({ isGroup: true }), mentionOnly).accept).toBe(false);
  });

  it('answers on a trigger word, case-insensitively', () => {
    expect(gate(message({ isGroup: true, text: 'hey TULIP are you there' }), triggered).accept).toBe(true);
  });

  it('ignores a group message with no trigger', () => {
    expect(gate(message({ isGroup: true, text: 'unrelated chatter' }), triggered)).toEqual({
      accept: false,
      reason: 'no trigger word in group',
    });
  });

  it('treats a mention as consent even in trigger mode', () => {
    expect(gate(message({ isGroup: true, text: 'no keyword', mentionsMe: true }), triggered).accept).toBe(true);
  });
});

describe('isOperator', () => {
  const config = parseConfig({
    audience: { everyone: true },
    operators: { numbers: ['15551234567'] },
  });

  // An operator whose commands are silently ignored has no way in at all, and
  // modern clients deliver them as a @lid rather than a number.
  it('recognises an operator listed by linked id', () => {
    const byLid = parseConfig({ operators: { jids: ['111111111111111@lid'] } });
    expect(isOperator(byLid, ['111111111111111@lid'])).toBe(true);
    expect(isOperator(byLid, ['222222222222222@lid'])).toBe(false);
  });

  it('recognises a listed operator', () => {
    expect(isOperator(config, ['15551234567'])).toBe(true);
  });

  // The property that matters: opening the audience must not hand strangers
  // the ability to restart sessions or read state.
  it('is not widened by audience.everyone', () => {
    expect(config.audience.everyone).toBe(true);
    expect(isOperator(config, ['15559999999'])).toBe(false);
  });

  it('is empty by default', () => {
    expect(isOperator(parseConfig({}), ['15551234567'])).toBe(false);
  });
});

describe('config validation', () => {
  it('defaults to the closed, restrictive end of every setting', () => {
    const config = parseConfig({});
    expect(config.audience.everyone).toBe(false);
    expect(config.groups.enabled).toBe(false);
    // Inside a container, binding to loopback makes the panel unreachable
    // rather than safe: Docker forwards a published port to the container's
    // ethernet address. Exposure is limited by the publish address in
    // docker-compose.yml, which preflight.sh checks.
    expect(config.panel.host).toBe('0.0.0.0');
    expect(config.operators.numbers).toEqual([]);
  });

  it('ignores underscore-prefixed documentation keys', () => {
    // JSON has no comments, and this file needs them. The concession is narrow:
    // see the next test.
    const config = parseConfig({
      _comment: 'this file decides who may talk to a shell',
      audience: { _note: 'the public switch', everyone: true, numbers: [] },
    });
    expect(config.audience.everyone).toBe(true);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo in a security-relevant key would otherwise leave the default in
    // force while the operator believes they changed it.
    expect(() => parseConfig({ audience: { everyOne: true } })).toThrow(/audience/);
    expect(() => parseConfig({ audiance: {} })).toThrow();
  });

  it('rejects a phone number that is not bare international digits', () => {
    expect(() => parseConfig({ operators: { numbers: ['+1 555 123 4567'] } })).toThrow(/bare international digits/);
    expect(() => parseConfig({ operators: { numbers: ['0044123456789'] } })).toThrow();
  });

  it('rejects out-of-range limits', () => {
    expect(() => parseConfig({ limits: { turnsPerDay: 0 } })).toThrow();
    expect(() => parseConfig({ limits: { maxInboundChars: 10 } })).toThrow();
  });
});
