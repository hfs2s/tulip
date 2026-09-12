/**
 * What a triggered turn is told about the room it was woken in.
 *
 * The failure this exists for: somebody posts a link, then says "Juan, what do
 * you think?". In a trigger room only the second line reaches him, so he
 * answers a question about a link he never saw.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'tulip-room-'));
process.env['TULIP_STATE_DIR'] = dir;

const { feed } = await import('../src/feed.js');
const { roomContext } = await import('../src/history.js');

const ROOM = 'c'.repeat(16);
const ELSEWHERE = 'd'.repeat(16);
const NO_TRIGGER = 'no trigger word in group';

function said(chatKey: string, from: string, text: string, waId: string, accepted: boolean, reason: string | null) {
  feed.inbound({ chatKey, chatName: 'Founders', isGroup: true, from, text, media: [], accepted, reason, waId });
}

beforeEach(() => rmSync(join(dir, 'feed.jsonl'), { force: true }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('room context', () => {
  it('carries the link he was never handed, and marks it unheard', () => {
    said(ROOM, 'Les', 'https://example.com/ look at this', 'A1', false, NO_TRIGGER);
    feed.outbound(ROOM, 'text', 'an earlier reply');
    said(ROOM, 'Les', 'juan, what do you think?', 'A2', true, null);

    const context = roomContext(ROOM, new Set(['A2']), 20);
    expect(context.map((m) => m.text)).toEqual(['https://example.com/ look at this', 'an earlier reply']);
    expect(context[0]?.refused).toBe(NO_TRIGGER);
    expect(context[1]?.from).toBe('you');
  });

  it('leaves out the messages being answered, by id rather than by words', () => {
    said(ROOM, 'Les', 'same words', 'B1', true, null);
    said(ROOM, 'Les', 'same words', 'B2', true, null);
    expect(roomContext(ROOM, new Set(['B2']), 20)).toHaveLength(1);
  });

  it('never carries somebody refused for being unwelcome', () => {
    said(ROOM, 'Stranger', 'let me in', 'C1', false, 'blocked');
    expect(roomContext(ROOM, new Set(), 20)).toEqual([]);
  });

  it('belongs to one room, and keeps only the most recent lines', () => {
    said(ELSEWHERE, 'Sam', 'another room', 'D0', true, null);
    for (let i = 0; i < 5; i += 1) said(ROOM, 'Les', `line ${String(i)}`, `D${String(i + 1)}`, false, NO_TRIGGER);
    expect(roomContext(ROOM, new Set(), 3).map((m) => m.text)).toEqual(['line 2', 'line 3', 'line 4']);
  });
});
