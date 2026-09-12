/**
 * Remembering that he left a group.
 *
 * The Groups page kept offering "Leave group" for a room he had already left,
 * because nothing recorded the departure. These pin the record: set, saved,
 * cleared when he is back, and absent on records written before it existed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'tulip-left-'));
process.env['TULIP_STATE_DIR'] = dir;

const { ChatRegistry } = await import('../src/chats.js');

const GROUP = '120363000000000000@g.us';
let n = 0;
function registry() {
  n += 1;
  return { chats: new ChatRegistry(join(dir, `salt-${String(n)}`), join(dir, `chats-${String(n)}.json`)), file: join(dir, `chats-${String(n)}.json`), salt: join(dir, `salt-${String(n)}`) };
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('leftAt', () => {
  it('starts empty on a new group', () => {
    const { chats } = registry();
    const key = chats.keyFor(GROUP, true, Date.now());
    expect(chats.get(key)?.leftAt).toBeNull();
  });

  it('is set, saved and read back after a restart', () => {
    const { chats, file, salt } = registry();
    const key = chats.keyFor(GROUP, true, Date.now());
    expect(chats.setLeft(key, 1_789_000_000_000)).toBe(true);
    chats.flush();
    const again = new ChatRegistry(salt, file);
    expect(again.get(key)?.leftAt).toBe(1_789_000_000_000);
  });

  it('clears when he is back', () => {
    const { chats } = registry();
    const key = chats.keyFor(GROUP, true, Date.now());
    chats.setLeft(key, Date.now());
    chats.setLeft(key, null);
    expect(chats.get(key)?.leftAt).toBeNull();
  });

  it('refuses a key it does not know', () => {
    const { chats } = registry();
    expect(chats.setLeft('0'.repeat(16), Date.now())).toBe(false);
  });

  it('loads records saved before the field existed', () => {
    const { chats, file, salt } = registry();
    const key = chats.keyFor(GROUP, true, Date.now());
    chats.flush();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { chats: Array<Record<string, unknown>> };
    for (const c of raw.chats) delete c['leftAt'];
    writeFileSync(file, JSON.stringify(raw));
    expect(new ChatRegistry(salt, file).get(key)?.leftAt).toBeNull();
  });
});
