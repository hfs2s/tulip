/**
 * Correcting Juan's own words from the panel.
 *
 * The same three things the agent can do to its own messages, reached from the
 * operator's side — and the reason they are written on the bridge rather than
 * routed through the agent is the reason the control room exists at all: they
 * are most wanted when the agent is the problem, and asking it to retract what
 * it just said is the one request it might decline.
 *
 * What these pin down is the addressing. The panel names a message by position
 * in Juan's own recent sends, never by id, so the set of things it can touch is
 * exactly "messages Juan sent in this chat". A test that only checked "it did
 * not throw" would pass while editing somebody else's message in another room.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const box = mkdtempSync(join(tmpdir(), 'tulip-fix-'));
mkdirSync(join(box, 'in'), { recursive: true });
mkdirSync(join(box, 'out'), { recursive: true });
process.env['TULIP_IN_DIR'] = join(box, 'in');
process.env['TULIP_OUT_DIR'] = join(box, 'out');
process.env['TULIP_STATE_DIR'] = join(box, 'state');

const { chatEdit, chatUnsend, chatReact } = await import('../src/panel-api.js');
const { sent } = await import('../src/sent.js');
const { feed } = await import('../src/feed.js');

const CHAT = 'aaaaaaaaaaaaaaaa';
const JID = '120363000000000000@g.us';

const editText = vi.fn(async () => undefined);
const unsend = vi.fn(async () => undefined);
const react = vi.fn(async () => undefined);

let lastIn: { id: string; participant?: string } | null = null;

const deps = {
  chats: { get: (k: string) => (k === CHAT ? { chatKey: CHAT, jid: JID } : null) },
  wa: { editText, unsend, react },
  dispatcher: () => ({ lastMessageIn: () => lastIn }),
} as never;

beforeEach(() => {
  sent.reset();
  editText.mockClear();
  unsend.mockClear();
  react.mockClear();
  lastIn = null;
});

describe('chatEdit', () => {
  it('edits the message at that position, and no other', async () => {
    sent.record(CHAT, 'ID-OLDER', 'text', 'the older one');
    sent.record(CHAT, 'ID-NEWEST', 'text', 'the newest one');

    // 1 is the most recent thing he said here, exactly as `edit 1` means to the
    // agent. If these two ever disagree the panel edits the wrong message.
    const result = await chatEdit(deps, CHAT, 1, 'corrected');
    expect(result.ok).toBe(true);
    expect(editText).toHaveBeenCalledWith(JID, 'ID-NEWEST', 'corrected');
  });

  it('refuses a position that is not there rather than guessing', async () => {
    const result = await chatEdit(deps, CHAT, 4, 'corrected');
    expect(result.ok).toBe(false);
    expect(editText).not.toHaveBeenCalled();
  });

  it('refuses to edit a picture, because WhatsApp only edits text', async () => {
    sent.record(CHAT, 'ID-IMG', 'image', null);
    const result = await chatEdit(deps, CHAT, 1, 'corrected');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Delete it instead');
    expect(editText).not.toHaveBeenCalled();
  });

  it('refuses an empty edit, since that is a deletion asked for wrongly', async () => {
    sent.record(CHAT, 'ID-1', 'text', 'something');
    expect((await chatEdit(deps, CHAT, 1, '   ')).ok).toBe(false);
    expect(editText).not.toHaveBeenCalled();
  });

  it('says the window has probably closed when WhatsApp refuses', async () => {
    sent.record(CHAT, 'ID-1', 'text', 'something');
    editText.mockRejectedValueOnce(new Error('not allowed'));
    const result = await chatEdit(deps, CHAT, 1, 'corrected');
    expect(result.ok).toBe(false);
    // The operator has just typed a correction. They must not be left thinking
    // it landed.
    expect(result.message).toContain('fifteen minutes');
  });

  it('refuses a chat it was never given a key for', async () => {
    expect((await chatEdit(deps, 'bbbbbbbbbbbbbbbb', 1, 'x')).ok).toBe(false);
    expect(editText).not.toHaveBeenCalled();
  });
});

describe('chatUnsend', () => {
  it('retracts the message at that position', async () => {
    sent.record(CHAT, 'ID-1', 'text', 'oops');
    const result = await chatUnsend(deps, CHAT, 1);
    expect(result.ok).toBe(true);
    expect(unsend).toHaveBeenCalledWith(JID, 'ID-1');
  });

  it('retracts a picture, which editing cannot touch', async () => {
    sent.record(CHAT, 'ID-IMG', 'image', null);
    expect((await chatUnsend(deps, CHAT, 1)).ok).toBe(true);
  });

  it('cannot be retracted or edited twice', async () => {
    // `recent` drops retracted rows, which is what makes the second attempt
    // fail rather than send a second retraction for a message that is gone.
    sent.record(CHAT, 'ID-1', 'text', 'oops');
    await chatUnsend(deps, CHAT, 1);
    expect(sent.nth(CHAT, 1)).toBeNull();
    expect((await chatUnsend(deps, CHAT, 1)).ok).toBe(false);
    expect((await chatEdit(deps, CHAT, 1, 'too late')).ok).toBe(false);
    expect(unsend).toHaveBeenCalledTimes(1);
  });

  it('keeps the words for the panel, which is the only surviving record', async () => {
    // The transcript renders these struck through. If this set is empty the
    // message renders as though it were still standing.
    sent.record(CHAT, 'ID-1', 'text', 'oops', 'feed-uid-1');
    await chatUnsend(deps, CHAT, 1);
    expect(sent.retractedUids(CHAT).has('feed-uid-1')).toBe(true);
  });
});

describe('chatReact', () => {
  it('reacts to the last message received, carrying the participant', async () => {
    lastIn = { id: 'IN-1', participant: '34600000000@s.whatsapp.net' };
    const result = await chatReact(deps, CHAT, '👍');
    expect(result.ok).toBe(true);
    expect(react).toHaveBeenCalledWith(JID, 'IN-1', '👍', '34600000000@s.whatsapp.net');
  });

  it('says so plainly when there is nothing to react to', async () => {
    const result = await chatReact(deps, CHAT, '👍');
    expect(result.ok).toBe(false);
    expect(react).not.toHaveBeenCalled();
  });

  it('refuses a sentence dressed up as a reaction', async () => {
    lastIn = { id: 'IN-1' };
    expect((await chatReact(deps, CHAT, 'nice work everyone')).ok).toBe(false);
    expect((await chatReact(deps, CHAT, 'ok')).ok).toBe(false);
    expect(react).not.toHaveBeenCalled();
  });

  it('accepts emoji that are more than one code point', async () => {
    // The bug the picker found. Counting code points and capping at three
    // rejected most of what an operator can paste: a variation selector, a skin
    // tone and a zero-width joiner are all extra code points in one glyph.
    lastIn = { id: 'IN-1' };
    for (const glyph of ['⚠️', '✌️', '👍🏽', '👨‍👩‍👧‍👦', '🏳️‍🌈']) {
      react.mockClear();
      const result = await chatReact(deps, CHAT, glyph);
      expect(result.ok, glyph).toBe(true);
      expect(react).toHaveBeenCalledWith(JID, 'IN-1', glyph, undefined);
    }
  });

  it('reacts to a named message further back, with that sender as participant', async () => {
    feed.inbound({
      chatKey: CHAT, chatName: 'Room', isGroup: true, from: 'Mira', text: 'earlier',
      media: [], accepted: true, reason: null, waId: 'IN-OLD', participant: '34600000001@s.whatsapp.net',
    });
    const result = await chatReact(deps, CHAT, '❤️', 'IN-OLD');
    expect(result.ok).toBe(true);
    expect(react).toHaveBeenCalledWith(JID, 'IN-OLD', '❤️', '34600000001@s.whatsapp.net');
  });

  it('refuses an id this bridge never recorded, rather than trusting the browser', async () => {
    // The id arrives from a page. Without the lookup, guessing a string would
    // place a reaction on an arbitrary message in an arbitrary conversation.
    const result = await chatReact(deps, CHAT, '👍', 'ID-INVENTED');
    expect(result.ok).toBe(false);
    expect(react).not.toHaveBeenCalled();
  });

  it('refuses an id recorded against a different chat', async () => {
    feed.inbound({
      chatKey: 'cccccccccccccccc', chatName: 'Elsewhere', isGroup: false, from: 'Someone',
      text: 'not here', media: [], accepted: true, reason: null, waId: 'IN-ELSEWHERE', participant: null,
    });
    const result = await chatReact(deps, CHAT, '👍', 'IN-ELSEWHERE');
    expect(result.ok).toBe(false);
    expect(react).not.toHaveBeenCalled();
  });
});
