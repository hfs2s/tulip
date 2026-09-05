import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRegistry } from '../src/chats.js';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry(): ChatRegistry {
  const root = mkdtempSync(join(tmpdir(), 'tulip-identity-'));
  roots.push(root);
  return new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
}

const PHONE = '15551234567@s.whatsapp.net';
// A placeholder linked id. Real ones are opaque and belong to real people;
// this repository is public, so the fixture is a repeated-digit dummy.
const LID = '1111111111111@lid';

/**
 * One human, one record.
 *
 * The failure this guards against was live and quiet: a contact added by number
 * is registered under `<number>@s.whatsapp.net`, but WhatsApp delivered that
 * person's messages from a bare `@lid`. Two records, two keys — and because an
 * agent session is per key, two conversations that could not see each other.
 * The visible symptom was the agent introducing itself to the same person
 * twice, having no way to know they had already met.
 */
describe('one person, one chat record', () => {
  it('routes a linked-id message to the record the operator added by number', () => {
    const chats = registry();
    const now = Date.now();
    chats.syncContacts([{ label: 'KD', number: '15551234567' }], now);
    const contactKey = chats.all()[0]!.chatKey;

    // Their first message arrives under a linked id, with the phone-number form
    // alongside it — which is what WhatsApp supplies when it supplies anything.
    const seen = chats.keyFor(LID, false, now, PHONE);

    expect(seen).toBe(contactKey);
    expect(chats.all()).toHaveLength(1);
    expect(chats.all()[0]).toMatchObject({ name: 'KD', contact: true, altJid: LID });
  });

  it('supersedes a duplicate that was created before the link was known', () => {
    const chats = registry();
    const now = Date.now();

    // The old behaviour, reproduced: a message under the linked id alone, with
    // no phone-number form to tie it to anything.
    const strayKey = chats.keyFor(LID, false, now);
    chats.syncContacts([{ label: 'KD', number: '15551234567' }], now);
    expect(chats.all()).toHaveLength(2);

    // Now one message arrives carrying both identifiers.
    const settled = chats.keyFor(LID, false, now, PHONE);

    expect(settled).not.toBe(strayKey);
    expect(chats.all()).toHaveLength(1);
    expect(chats.all()[0]!.name).toBe('KD');
    // The superseded record still resolves, so history and anything holding its
    // key keeps working — it is merely no longer offered or written to.
    expect(chats.jidFor(strayKey)).toBe(LID);
    // And a later message under the stray key lands on the survivor.
    expect(chats.keyFor(LID, false, now)).toBe(settled);
  });

  it('registers an unknown sender under the phone-number form, so a later contact meets it', () => {
    const chats = registry();
    const now = Date.now();

    const key = chats.keyFor(LID, false, now, PHONE);
    // The operator adds them afterwards, by number, as they would from the panel.
    chats.syncContacts([{ label: 'KD', number: '15551234567' }], now);

    expect(chats.all()).toHaveLength(1);
    expect(chats.all()[0]).toMatchObject({ chatKey: key, contact: true, name: 'KD' });
  });

  it('keeps a conversation that only ever had a linked id where it is', () => {
    const chats = registry();
    const now = Date.now();
    // A real conversation exists under the linked id, and only later does a
    // phone-number form turn up. Moving it would reset the agent's session for
    // that chat, which is worse than leaving one record unmerged.
    const original = chats.keyFor(LID, false, now);
    const after = chats.keyFor(LID, false, now, PHONE);

    expect(after).toBe(original);
    expect(chats.all()).toHaveLength(1);
    expect(chats.all()[0]!.altJid).toBe(PHONE);
  });

  it('leaves groups alone', () => {
    const chats = registry();
    const now = Date.now();
    const key = chats.keyFor('12345-678@g.us', true, now, PHONE);
    expect(chats.jidFor(key)).toBe('12345-678@g.us');
    expect(chats.all()[0]!.altJid).toBeNull();
  });
});
