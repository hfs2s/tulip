/**
 * What a recalled conversation contains, and what it must not.
 *
 * `recentMessages` is the only path by which one person's words reach a session
 * answering somebody else, so the filtering is the point rather than a detail.
 * Two things it must never carry:
 *
 *   - **A refused message.** The feed records everything that arrived, gated or
 *     not — that is what makes "I texted it and nothing happened" diagnosable.
 *     A message the gate turned away was never part of the conversation, and
 *     surfacing it here would let recall read exactly the traffic the gate
 *     exists to keep out: blocked senders, strangers, rate-limited floods.
 *   - **Another chat's messages.** The filter is by key, and a mistake there is
 *     the whole conversation delivered to the wrong person.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tulip-history-'));
process.env['TULIP_STATE_DIR'] = dir;

const { feed } = await import('../src/feed.js');
const { recentMessages } = await import('../src/history.js');

const MINE = '17f1f7d2c1a600d2';
const THEIRS = '44242d5135c8fa5b';

const inbound = (chatKey: string, from: string, text: string, accepted = true): void => {
  feed.inbound({ chatKey, chatName: from, isGroup: false, from, text, media: [], accepted, reason: accepted ? null : 'blocked' });
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
