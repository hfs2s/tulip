/**
 * Who is allowed to hand the agent a phone number.
 *
 * `contact` is the one action that turns a number into a chat key — the single
 * point at which a number enters the agent's vocabulary — and its whole safety
 * argument is provenance: the number came from an operator, not from whoever
 * happens to be talking to Juan. This predicate is that argument, so it is
 * tested on its own rather than only through a dispatcher.
 *
 * The property is stronger than "an operator is in the batch". The agent reads
 * a batch as one prompt, so a number sitting in a stranger's message would be
 * picked up as though an operator had given it. Every message has to be theirs.
 */
import { describe, expect, it } from 'vitest';
import { carriesOperatorAuthority } from '../src/dispatcher.js';
import { parseConfig } from '../src/config.js';

const config = parseConfig({
  operators: { numbers: ['15551110000'], jids: ['999888777@lid'] },
  audience: { everyone: true },
});

/** Only the field the predicate reads; the rest of an envelope is irrelevant. */
const from = (ids: readonly string[], isGroup = false) =>
  ({ senderIds: ids, isGroup }) as unknown as Parameters<typeof carriesOperatorAuthority>[0][number];

const OPERATOR = ['15551110000@s.whatsapp.net', '15551110000'];
const OPERATOR_LID = ['999888777@lid', '999888777'];
const STRANGER = ['15559998888@s.whatsapp.net', '15559998888'];

describe('operator authority', () => {
  it('is carried by an operator writing directly', () => {
    expect(carriesOperatorAuthority([from(OPERATOR)], config)).toBe(true);
  });

  it('is carried by their linked id too, which is how modern clients arrive', () => {
    expect(carriesOperatorAuthority([from(OPERATOR_LID)], config)).toBe(true);
  });

  /**
   * The change this file was written for. Excluding groups was over-cautious
   * and broke the real use — an operator saying "message this number" in the
   * group they are already in, refused for being in a room. The control is the
   * sender's id, which WhatsApp assigns; the shape of the room is not evidence
   * about who spoke.
   */
  it('is carried in a group, because the sender is still identified', () => {
    expect(carriesOperatorAuthority([from(OPERATOR, true)], config)).toBe(true);
  });

  it('is not carried by a stranger, in a group or out of one', () => {
    expect(carriesOperatorAuthority([from(STRANGER)], config)).toBe(false);
    expect(carriesOperatorAuthority([from(STRANGER, true)], config)).toBe(false);
  });

  /**
   * The one that matters most. A batch is read as a single prompt, so a number
   * in the stranger's half would be indistinguishable from one the operator
   * gave — and the agent has no way to attribute a line to a sender.
   */
  it('is not carried by a batch that mixes an operator with anybody else', () => {
    expect(carriesOperatorAuthority([from(OPERATOR), from(STRANGER)], config)).toBe(false);
    expect(carriesOperatorAuthority([from(STRANGER), from(OPERATOR)], config)).toBe(false);
  });

  it('is not carried by an empty batch', () => {
    // `every` says true for nothing at all. A turn is never opened without
    // messages, but a security predicate should not rest on a caller's
    // invariant to be safe.
    expect(carriesOperatorAuthority([], config)).toBe(false);
  });

  it('is not widened by opening the audience', () => {
    // `audience.everyone` decides who may talk to Juan. It has never decided
    // who may direct him, and the two must not drift into one setting.
    const open = parseConfig({ operators: { numbers: ['15551110000'] }, audience: { everyone: true } });
    expect(carriesOperatorAuthority([from(STRANGER)], open)).toBe(false);
  });

  it('is carried by nobody when no operator is configured', () => {
    const none = parseConfig({ audience: { everyone: true } });
    expect(carriesOperatorAuthority([from(OPERATOR)], none)).toBe(false);
    expect(carriesOperatorAuthority([from(STRANGER)], none)).toBe(false);
  });
});
