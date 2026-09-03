import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRegistry } from '../src/chats.js';
import { parseConfig } from '../src/config.js';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry(): ChatRegistry {
  const root = mkdtempSync(join(tmpdir(), 'tulip-chats-'));
  roots.push(root);
  return new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
}

/**
 * Contacts are what make `crossChat` more than decorative.
 *
 * A chat key only exists once somebody has messaged in, so without an
 * operator-curated list the agent could reply onward but never introduce itself
 * to anybody — which is what an operator means when they switch it on. The bot
 * reported, accurately, that its list of people it could message contained only
 * the person it was already talking to.
 */
describe('operator contacts', () => {
  it('creates a destination for somebody who has never messaged', () => {
    const chats = registry();
    expect(chats.size).toBe(0);

    chats.syncContacts([{ label: 'Noether', number: '15551234567' }], Date.now());

    const [record] = chats.all();
    expect(record).toMatchObject({ name: 'Noether', contact: true, messages: 0, isGroup: false });
    expect(chats.jidFor(record!.chatKey)).toBe('15551234567@s.whatsapp.net');
  });

  it('is stable across restarts, so a session is not silently reset', () => {
    const root = mkdtempSync(join(tmpdir(), 'tulip-chats-'));
    roots.push(root);
    const files = [join(root, 'salt'), join(root, 'chats.json')] as const;

    const first = new ChatRegistry(...files);
    first.syncContacts([{ label: 'Noether', number: '15551234567' }], Date.now());
    const key = first.all()[0]!.chatKey;
    first.flush();

    const second = new ChatRegistry(...files);
    second.syncContacts([{ label: 'Noether', number: '15551234567' }], Date.now());
    expect(second.all()[0]!.chatKey).toBe(key);
  });

  it('prefers the operator label over the WhatsApp display name', () => {
    const chats = registry();
    const now = Date.now();
    const key = chats.keyFor('15551234567@s.whatsapp.net', false, now);
    chats.touch(key, { name: 'Free Bitcoin!!' }, now);

    chats.syncContacts([{ label: 'Noether', number: '15551234567' }], now);
    expect(chats.get(key)).toMatchObject({ name: 'Noether', contact: true });
  });

  it('removing a contact clears the flag but keeps the chat and its key', () => {
    const chats = registry();
    const now = Date.now();
    chats.syncContacts([{ label: 'Noether', number: '15551234567' }], now);
    const key = chats.all()[0]!.chatKey;
    chats.setBlocked(key, true);

    chats.syncContacts([], now);

    // The record survives: dropping it would orphan the session and reissue a
    // different key for the same person if they were ever added back.
    expect(chats.get(key)).toMatchObject({ contact: false, blocked: true });
    expect(chats.jidFor(key)).toBe('15551234567@s.whatsapp.net');
  });

  it('does not grant inbound access', () => {
    // Contacts are destinations. Who may *message Tulip* stays with `audience`,
    // so adding somewhere to send can never widen the attack surface.
    const config = parseConfig({
      audience: { everyone: false, numbers: [], jids: [] },
      agent: { crossChat: true, contacts: [{ label: 'Noether', number: '15551234567' }] },
    });
    expect(config.audience.numbers).toEqual([]);
    expect(config.agent.contacts).toEqual([{ label: 'Noether', number: '15551234567' }]);
  });

  it('rejects a number that is not bare international digits', () => {
    expect(() => parseConfig({ agent: { contacts: [{ label: 'x', number: '+34 600 00' }] } })).toThrow();
  });

  it('defaults to nobody', () => {
    expect(parseConfig({}).agent.contacts).toEqual([]);
    expect(parseConfig({}).agent.crossChat).toBe(false);
  });
});
