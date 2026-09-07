/**
 * Who may see which conversation.
 *
 * A display rule with a security purpose, which is the combination that goes
 * wrong quietly: it is easy to write, easy to believe, and easy to leave one
 * read path unfiltered — at which point the other six are decoration. So the
 * cases below are the ones that decide whether it means anything.
 */
import { describe, expect, it } from 'vitest';
import { canSee, isOwner, onlyVisible, type Privacy } from '../src/privacy.js';

const MINE = 'abcdef0123456789';
const THEIRS = 'fedcba9876543210';
const on: Privacy = { owner: 'les@example.com', chats: [MINE] };
const off: Privacy = { owner: null, chats: [MINE] };

const owner = { who: 'les@example.com' };
const other = { who: 'someone-else@example.com' };
const token = { who: null };

describe('the owner, and the token holder', () => {
  it('shows the owner their own chat', () => {
    expect(canSee(on, owner, MINE)).toBe(true);
    expect(isOwner(on, owner)).toBe(true);
  });

  it('ignores case and stray whitespace in the address', () => {
    // Access hands back whatever the identity provider has. A capital letter
    // must not lock an operator out of their own conversation.
    expect(isOwner(on, { who: '  LES@Example.COM ' })).toBe(true);
  });

  it('does NOT treat the bearer token as the owner', () => {
    // Reversed deliberately. The token says its holder knows a secret; it
    // cannot say which person that is, and this feature is about which person
    // it is. Treating it as the owner made it a bypass for everyone who has
    // ever been given it.
    //
    // The cost is accepted rather than hidden: reaching the panel over an SSH
    // tunnel with `?t=` shows the operator the unprivileged view of their own
    // deployment. Recovery is at the machine, in config.json.
    expect(isOwner(on, token)).toBe(false);
    expect(canSee(on, token, MINE)).toBe(false);
  });
});

describe('another moderator', () => {
  it('cannot see a private chat', () => {
    expect(canSee(on, other, MINE)).toBe(false);
  });

  it('sees every other chat normally', () => {
    expect(canSee(on, other, THEIRS)).toBe(true);
  });

  it('does not get the terminal, which cannot be filtered', () => {
    // One shared session carries every conversation, so the live pane shows the
    // owner's messages whatever the chat list does.
    expect(isOwner(on, other)).toBe(false);
  });
});

describe('failing open, on purpose', () => {
  it('still shows the token holder everything while the feature is off', () => {
    // Which is what keeps an unconfigured deployment behaving exactly as it did.
    expect(isOwner(off, token)).toBe(true);
    expect(canSee(off, token, MINE)).toBe(true);
  });

  it('shows everything when no owner is configured', () => {
    // The panel behaved this way before this existed, and an unconfigured
    // deployment must not change behaviour.
    expect(isOwner(off, other)).toBe(true);
    expect(canSee(off, other, MINE)).toBe(true);
  });

  it('shows everything when the owner is blank rather than absent', () => {
    const blank: Privacy = { owner: '   ', chats: [MINE] };
    expect(isOwner(blank, other)).toBe(true);
  });

  it('hides nothing when the private list is empty', () => {
    expect(canSee({ owner: 'les@example.com', chats: [] }, other, MINE)).toBe(true);
  });
});

describe('onlyVisible', () => {
  const rows = [{ chatKey: MINE }, { chatKey: THEIRS }, { chatKey: null }];
  const keyOf = (r: { chatKey: string | null }): string | null => r.chatKey;

  it('drops the private chat for a moderator and keeps the rest', () => {
    expect(onlyVisible(on, other, rows, keyOf)).toEqual([{ chatKey: THEIRS }, { chatKey: null }]);
  });

  it('keeps an item that names no chat, because it cannot be attributed', () => {
    expect(onlyVisible(on, other, [{ chatKey: null }], keyOf)).toHaveLength(1);
  });

  it('returns everything for the owner, and a copy rather than the original', () => {
    const out = onlyVisible(on, owner, rows, keyOf);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(rows);
  });
});
