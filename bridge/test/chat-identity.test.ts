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
    // The superseded key still resolves, so anything holding one keeps working
    // — but it resolves to the *survivor*, not to the dead record's own jid.
    // Resolving to `LID` would mean two keys addressing one person while only
    // one of them carried their block.
    expect(chats.jidFor(strayKey)).toBe(PHONE);
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

/**
 * A superseded key resolves to the survivor in *every* lookup, not only in
 * `keyFor`.
 *
 * `keyFor` has always followed `mergedInto`, which made inbound safe: the
 * dispatcher checks the key it was handed, and that is the survivor. Nothing
 * else followed it. So `jidFor` returned the dead record's jid and `isBlocked`
 * returned the dead record's flag — and the one caller that supplies its own
 * key rather than receiving one is `crossChatTarget`, whose key comes from the
 * agent. The agent's workspace persists per chat across turns, so it can be
 * holding a pre-merge key long after the merge: block the surviving record, and
 * a send addressed to the superseded one went through.
 *
 * These are the registry-level properties. The end-to-end refusal is in
 * `outbox-destinations.test.ts`, under "a superseded chat key".
 */
describe('a superseded key resolves to the survivor', () => {
  /** Two records for one person, merged. Returns both keys. */
  function merged(chats: ChatRegistry, now: number): { stale: string; survivor: string } {
    const stale = chats.keyFor(LID, false, now);
    chats.syncContacts([{ label: 'KD', number: '15551234567' }], now);
    const survivor = chats.keyFor(LID, false, now, PHONE);
    expect(survivor).not.toBe(stale);
    return { stale, survivor };
  }

  it('answers with the survivor’s record, not the record that was superseded', () => {
    const chats = registry();
    const now = Date.now();
    const { stale, survivor } = merged(chats, now);

    expect(chats.get(stale)?.chatKey).toBe(survivor);
    // The operator's label, which only ever existed on the survivor.
    expect(chats.get(stale)?.name).toBe('KD');
  });

  it('reports the survivor’s block state', () => {
    const chats = registry();
    const now = Date.now();
    const { stale, survivor } = merged(chats, now);

    expect(chats.isBlocked(stale)).toBe(false);
    chats.setBlocked(survivor, true);
    // The whole point. Before this resolved, an agent holding `stale` had a
    // key that answered "not blocked" for somebody who is.
    expect(chats.isBlocked(stale)).toBe(true);
    expect(chats.jidFor(stale)).toBe(PHONE);
  });

  it('accepts a block written against the stale key, and applies it to the survivor', () => {
    const chats = registry();
    const now = Date.now();
    const { stale, survivor } = merged(chats, now);

    // The key in front of an operator can easily be the superseded one — an old
    // feed line, a page open since before the merge. Writing the flag onto the
    // dead row would report success and do nothing.
    expect(chats.setBlocked(stale, true)).toBe(true);
    expect(chats.isBlocked(survivor)).toBe(true);

    expect(chats.setBlocked(stale, false)).toBe(true);
    expect(chats.isBlocked(survivor)).toBe(false);
  });

  it('applies a touch to the survivor, so history is not written where nobody reads it', () => {
    const chats = registry();
    const now = Date.now();
    const { stale, survivor } = merged(chats, now);

    chats.touch(stale, { messages: 7 }, now + 1000);

    expect(chats.get(survivor)?.messages).toBe(7);
    expect(chats.get(survivor)?.lastSeenAt).toBe(now + 1000);
    // `all()` hides the superseded row, so a count landing there would be
    // invisible — and it is what the destination list is sorted by.
    expect(chats.all()).toHaveLength(1);
    expect(chats.all()[0]!.messages).toBe(7);
  });

  it('hands out the survivor when a number is looked up', () => {
    const chats = registry();
    const now = Date.now();
    const { survivor } = merged(chats, now);

    // `addContact` returns this key to the agent as an addressable destination.
    expect(chats.keyForNumber('15551234567')).toBe(survivor);
    expect(chats.keyForNumber('15550000000')).toBeNull();
  });

  it('still refuses a key that was never issued at all', () => {
    const chats = registry();
    const now = Date.now();
    merged(chats, now);

    // Canonicalising must not turn an unknown key into a resolvable one: the
    // fallback is the key itself, and the key itself has no record.
    expect(chats.jidFor('ffffffffffffffff')).toBeNull();
    expect(chats.get('ffffffffffffffff')).toBeNull();
    expect(chats.isBlocked('ffffffffffffffff')).toBe(false);
    expect(chats.setBlocked('ffffffffffffffff', true)).toBe(false);
  });
});
