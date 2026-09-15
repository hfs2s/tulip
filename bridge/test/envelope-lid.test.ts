/**
 * The phone number beside a linked id, in the key field each Baileys version
 * actually uses.
 *
 * A sender WhatsApp delivers as a bare `@lid` only matches an allowlist entry
 * written as a number if the bridge reads the phone-number jid WhatsApp sends
 * alongside — and which field carries it changed between Baileys 6 (`senderPn`)
 * and 7 (`remoteJidAlt` in a direct chat, `participantAlt` in a group). The
 * failure when the wrong one is read is silent: fourteen of Juan's twenty-four
 * direct chats were bare lids with no number, and a client Les had granted his
 * own app by number was refused on it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WAMessage, WASocket } from 'baileys';
import { senderPnOf, toEnvelope, type ParseContext } from '../src/envelope.js';

const LID = '102667284168849@lid';
const PHONE = '16504474829@s.whatsapp.net';
const ROOM = '120363000000000001@g.us';

const socket = {
  user: { id: '34600000000:7@s.whatsapp.net', lid: '999000000000000@lid' },
  groupMetadata: async () => ({ subject: 'A room' }),
} as unknown as WASocket;

const ctx: ParseContext = {
  chatKey: 'deadbeefcafef00d',
  mediaRoot: mkdtempSync(join(tmpdir(), 'tulip-envelope-lid-')),
  maxMediaBytes: 0,
  maxMediaPerMessage: 0,
  maxInboundChars: 4000,
};

function message(key: Record<string, unknown>): WAMessage {
  return { key: { fromMe: false, id: 'ABC123', ...key }, message: { conversation: 'hola' }, messageTimestamp: 1789487526 } as unknown as WAMessage;
}

describe('a direct chat delivered as a linked id', () => {
  it('reads the number from remoteJidAlt, as Baileys 7 sends it', async () => {
    const m = message({ remoteJid: LID, remoteJidAlt: '16504474829:3@s.whatsapp.net' });
    expect(senderPnOf(m)).toBe(PHONE);
    const envelope = await toEnvelope(m, socket, ctx);
    expect(envelope.senderPn).toBe(PHONE);
    expect(envelope.senderIds).toEqual(expect.arrayContaining(['16504474829', '102667284168849', LID, PHONE]));
  });

  it('still reads senderPn, as Baileys 6 sent it', async () => {
    const m = message({ remoteJid: LID, senderPn: PHONE });
    expect(senderPnOf(m)).toBe(PHONE);
    expect((await toEnvelope(m, socket, ctx)).senderPn).toBe(PHONE);
  });

  it('prefers the newer field when both are present', () => {
    expect(senderPnOf(message({ remoteJid: LID, remoteJidAlt: PHONE, senderPn: '15550000000@s.whatsapp.net' }))).toBe(PHONE);
  });

  it('is null, not a guess, when only the lid arrived', async () => {
    const m = message({ remoteJid: LID });
    expect(senderPnOf(m)).toBeNull();
    const envelope = await toEnvelope(m, socket, ctx);
    expect(envelope.senderPn).toBeNull();
    expect(envelope.senderIds).toEqual([LID, '102667284168849']);
  });

  it('ignores a field that is not a string', () => {
    expect(senderPnOf(message({ remoteJid: LID, remoteJidAlt: null, senderPn: 42 }))).toBeNull();
  });
});

describe('a group message from a linked id', () => {
  it('reads the number from participantAlt into senderIds, and keeps senderPn null for the room', async () => {
    const m = message({ remoteJid: ROOM, participant: LID, participantAlt: PHONE });
    expect(senderPnOf(m)).toBeNull();
    const envelope = await toEnvelope(m, socket, ctx);
    expect(envelope.isGroup).toBe(true);
    expect(envelope.senderPn).toBeNull();
    expect(envelope.senderIds).toEqual(expect.arrayContaining(['16504474829', '102667284168849']));
  });

  it('does not mistake a direct-chat field for a group one', async () => {
    const m = message({ remoteJid: ROOM, participant: LID, remoteJidAlt: PHONE });
    expect((await toEnvelope(m, socket, ctx)).senderIds).toEqual([LID, '102667284168849']);
  });
});
