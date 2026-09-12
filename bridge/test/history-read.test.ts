/**
 * What a recalled conversation contains, and what it must not.
 *
 * `recentMessages` is the only path by which one person's words reach a session
 * answering somebody else, so the filtering is the point rather than a detail.
 *
 * Refused messages split by *reason*, and the split is the delicate part:
 *
 *   - **Refused for not addressing us** — groups off, no trigger word, no
 *     mention, a reaction — is carried, marked, because an operator asking to
 *     read a room should see what the room said. Hiding these made a busy room
 *     read back as empty, which the agent reported as a fault that did not
 *     exist.
 *   - **Refused because the sender is not welcome** — blocked, off the allow
 *     list, rate-limited — is never carried. This is the original rule, doing
 *     the job it was actually written for.
 *   - **Another chat's messages.** The filter is by key, and a mistake there is
 *     the whole conversation delivered to the wrong person.
 *
 * The allowlist matters more than either case: a refusal reason invented later
 * must stay hidden until somebody chooses otherwise, so these tests pin an
 * unknown reason as excluded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tulip-history-'));
process.env['TULIP_STATE_DIR'] = dir;

const { feed } = await import('../src/feed.js');
const { recentMessages } = await import('../src/history.js');
const { REFUSAL } = await import('../src/gate.js');

const MINE = '0123456789abcdef';
const THEIRS = '44242d5135c8fa5b';

const inbound = (chatKey: string, from: string, text: string, accepted = true): void => {
  feed.inbound({ chatKey, chatName: from, isGroup: false, from, text, media: [], accepted, reason: accepted ? null : 'blocked' });
};

/** Refused for a named reason, which is what decides whether recall carries it. */
const refusedFor = (chatKey: string, from: string, text: string, reason: string): void => {
  feed.inbound({ chatKey, chatName: from, isGroup: true, from, text, media: [], accepted: false, reason });
};

beforeEach(() => {
  rmSync(join(dir, 'feed.jsonl'), { force: true });
});
afterEach(() => {
  rmSync(join(dir, 'feed.jsonl'), { force: true });
});

describe('recentMessages', () => {
  it('returns what was said, oldest first', () => {
    inbound(MINE, 'Les', 'are you there');
    feed.outbound(MINE, 'text', 'always');
    const messages = recentMessages(MINE, 20);
    expect(messages.map((m) => m.text)).toEqual(['are you there', 'always']);
  });

  it('marks the agent’s own messages as its own', () => {
    feed.outbound(MINE, 'text', 'I sent this');
    expect(recentMessages(MINE, 20)[0]?.from).toBe('you');
  });

  it('names the sender by display name, never a number', () => {
    inbound(MINE, 'Les', 'hello');
    const from = recentMessages(MINE, 20)[0]?.from ?? '';
    expect(from).toBe('Les');
    expect(from).not.toMatch(/[0-9]{7,}/);
  });
});

describe('recentMessages — what it refuses to carry', () => {
  it('omits a message the gate refused', () => {
    // The important one. A blocked sender's text is in the feed by design; it
    // was never part of the conversation and must not become readable here.
    inbound(MINE, 'Les', 'this arrived');
    inbound(MINE, 'a stranger', 'this was refused', false);
    const texts = recentMessages(MINE, 20).map((m) => m.text);
    expect(texts).toContain('this arrived');
    expect(texts).not.toContain('this was refused');
  });

  it('carries a message refused only for not addressing us, and marks it', () => {
    // The regression this file exists for. The room spoke; the gate declined to
    // wake the agent. An operator reading the room back must see both the words
    // and the fact that nobody answered them.
    refusedFor(THEIRS, 'Mira', 'Im okay if juan is here', REFUSAL.noTrigger);
    const [message] = recentMessages(THEIRS, 20);
    expect(message?.text).toBe('Im okay if juan is here');
    expect(message?.refused).toBe(REFUSAL.noTrigger);
  });

  it('carries group traffic refused because groups were switched off', () => {
    refusedFor(THEIRS, 'Theresa', 'what about an off switch', REFUSAL.groupsDisabled);
    expect(recentMessages(THEIRS, 20).map((m) => m.text)).toEqual(['what about an off switch']);
  });

  it('leaves refused null on a message that was actually delivered', () => {
    inbound(MINE, 'Les', 'this arrived');
    expect(recentMessages(MINE, 20)[0]?.refused).toBeNull();
  });

  it('still omits a sender who is not on the allow list', () => {
    refusedFor(MINE, 'a stranger', 'let me in', REFUSAL.notOnList);
    expect(recentMessages(MINE, 20)).toEqual([]);
  });

  it('omits a refusal reason it does not recognise, rather than guessing', () => {
    // Fail closed. A reason added later must not become readable because
    // nobody remembered this allowlist.
    refusedFor(MINE, 'someone', 'invented refusal', 'some reason added next year');
    expect(recentMessages(MINE, 20)).toEqual([]);
  });

  it('omits another conversation entirely', () => {
    inbound(MINE, 'Les', 'mine');
    inbound(THEIRS, 'Patricia', 'theirs');
    expect(recentMessages(MINE, 20).map((m) => m.text)).toEqual(['mine']);
    expect(recentMessages(THEIRS, 20).map((m) => m.text)).toEqual(['theirs']);
  });

  it('omits events, which are about the deployment rather than the chat', () => {
    inbound(MINE, 'Les', 'a real message');
    feed.event('whatsapp.connected');
    expect(recentMessages(MINE, 20)).toHaveLength(1);
  });

  it('omits an empty message rather than returning a blank line', () => {
    inbound(MINE, 'Les', 'said something');
    feed.inbound({ chatKey: MINE, chatName: 'Les', isGroup: false, from: 'Les', text: '   ', media: [], accepted: true, reason: null });
    expect(recentMessages(MINE, 20)).toHaveLength(1);
  });

  it('returns nothing for a chat with no history', () => {
    expect(recentMessages('0000000000000000', 20)).toEqual([]);
  });
});

describe('recentMessages — how much', () => {
  it('honours the limit, keeping the most recent', () => {
    for (let i = 0; i < 10; i += 1) inbound(MINE, 'Les', `message ${i}`);
    const messages = recentMessages(MINE, 3);
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.text)).toEqual(['message 7', 'message 8', 'message 9']);
  });
});
