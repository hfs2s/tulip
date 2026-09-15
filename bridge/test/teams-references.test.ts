/**
 * Conversation references: where a Teams chat can be written to.
 *
 * The one field that could hurt is `serviceUrl`, so the tests are mostly about
 * that — it is refused on the way in, normalised when accepted, and re-checked
 * when the file is read back, so a hand edit cannot smuggle one past.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationReferences } from '../src/teams/references.js';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function file(): string {
  const root = mkdtempSync(join(tmpdir(), 'tulip-teams-refs-'));
  roots.push(root);
  return join(root, 'teams-references.json');
}

const ref = (serviceUrl: string) => ({
  serviceUrl,
  conversationId: '19:abc@thread.tacv2;messageid=1111111111111',
  tenantId: 't-1',
  botId: '28:app',
  lastActivityId: 'a-1',
});

describe('remembering where a conversation lives', () => {
  it('stores an https reference and hands it back', () => {
    const refs = new ConversationReferences(file());
    expect(refs.remember('chat-1', ref('https://smba.trafficmanager.net/emea/'))).toBe(true);
    expect(refs.get('chat-1')).toMatchObject(ref('https://smba.trafficmanager.net/emea/'));
    expect(refs.get('chat-2')).toBeNull();
  });

  it('adds the trailing slash the connector paths are appended to', () => {
    const refs = new ConversationReferences(file());
    refs.remember('chat-1', ref('https://smba.trafficmanager.net/emea'));
    expect(refs.get('chat-1')?.serviceUrl).toBe('https://smba.trafficmanager.net/emea/');
  });

  it.each([
    'http://smba.trafficmanager.net/emea/',
    'https://user:pw@smba.trafficmanager.net/',
    'https://smba.trafficmanager.net/emea/?next=1',
    'https://10.1.2.3/',
    'garbage',
  ])('refuses %s and stores nothing', (url) => {
    const refs = new ConversationReferences(file());
    expect(refs.remember('chat-1', ref(url))).toBe(false);
    expect(refs.get('chat-1')).toBeNull();
    expect(refs.size).toBe(0);
  });

  it('persists atomically and reloads', () => {
    const path = file();
    const first = new ConversationReferences(path);
    first.remember('chat-1', ref('https://smba.trafficmanager.net/emea/'));
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { references: Record<string, unknown> };
    expect(Object.keys(onDisk.references)).toEqual(['chat-1']);

    const second = new ConversationReferences(path);
    expect(second.get('chat-1')?.conversationId).toBe('19:abc@thread.tacv2;messageid=1111111111111');
  });

  it('does not rewrite the file when nothing changed', () => {
    const path = file();
    const refs = new ConversationReferences(path);
    refs.remember('chat-1', ref('https://smba.trafficmanager.net/emea/'));
    const before = readFileSync(path, 'utf8');
    writeFileSync(path, before.replace('"updatedAt"', '"updatedAt"')); // touch nothing
    refs.remember('chat-1', ref('https://smba.trafficmanager.net/emea/'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(before));
  });

  it('drops a stored reference that fails the rule on the way back in', () => {
    const path = file();
    writeFileSync(path, JSON.stringify({
      references: {
        'chat-bad': { ...ref('http://internal.host/'), updatedAt: 1 },
        'chat-ok': { ...ref('https://smba.trafficmanager.net/emea/'), updatedAt: 1 },
      },
    }));
    const refs = new ConversationReferences(path);
    expect(refs.get('chat-bad')).toBeNull();
    expect(refs.get('chat-ok')).not.toBeNull();
  });

  it('starts empty from a file it cannot read', () => {
    const path = file();
    writeFileSync(path, '{not json');
    expect(new ConversationReferences(path).size).toBe(0);
    writeFileSync(path, JSON.stringify({ references: { x: { serviceUrl: 5 } } }));
    expect(new ConversationReferences(path).size).toBe(0);
  });
});
