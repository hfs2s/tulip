/**
 * The one piece of state that crosses conversations.
 *
 * Everything else in Tulip is sealed per chat, so these tests are about the
 * exception behaving predictably: the agent cannot forge it, it stays finite,
 * every note keeps its source, and a corrupt file yields nothing rather than a
 * guess.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-memory-'));
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { remember, readMemory, forget, forgetAll } = await import('../src/memory.js');
const { inPaths } = await import('@tulip/shared');

const CHAT = 'a'.repeat(16);
const OTHER = 'b'.repeat(16);

beforeEach(() => rmSync(inPaths.memory, { force: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('remembering', () => {
  it('keeps the note and where it came from', () => {
    expect(remember('Les prefers voice notes', CHAT, 'Les')).toEqual({ ok: true, total: 1 });
    const [note] = readMemory();
    expect(note?.text).toBe('Les prefers voice notes');
    expect(note?.chatKey).toBe(CHAT);
    expect(note?.chatName).toBe('Les');
  });

  it('is shared, so a note from one chat is visible to every other', () => {
    remember('the deadline moved to Friday', CHAT, 'Les');
    // Nothing about reading is scoped to a chat — that is the entire point of
    // this feature and the entire risk of it.
    expect(readMemory().map((n) => n.text)).toContain('the deadline moved to Friday');
    expect(readMemory()[0]?.chatKey).not.toBe(OTHER);
  });

  it('does not store the same thing twice', () => {
    remember('the deadline moved', CHAT, 'Les');
    remember('The Deadline Moved', OTHER, 'Someone');
    expect(readMemory()).toHaveLength(1);
  });

  it('refuses an empty note', () => {
    expect(remember('   ', CHAT, null).ok).toBe(false);
    expect(readMemory()).toHaveLength(0);
  });

  it('truncates rather than storing an essay', () => {
    remember('x'.repeat(900), CHAT, null);
    expect(readMemory()[0]?.text.length).toBe(300);
  });

  it('stays finite, dropping the oldest', () => {
    for (let i = 0; i < 205; i += 1) remember(`note ${String(i)}`, CHAT, null);
    const notes = readMemory();
    expect(notes).toHaveLength(200);
    expect(notes[0]?.text).toBe('note 5');
    expect(notes[notes.length - 1]?.text).toBe('note 204');
  });
});

describe('forgetting', () => {
  it('removes one note by id', () => {
    remember('keep me', CHAT, null);
    remember('drop me', CHAT, null);
    const target = readMemory().find((n) => n.text === 'drop me');
    expect(forget(target?.id ?? '')).toBe(true);
    expect(readMemory().map((n) => n.text)).toEqual(['keep me']);
  });

  it('reports an id it does not have rather than silently succeeding', () => {
    remember('keep me', CHAT, null);
    expect(forget('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(readMemory()).toHaveLength(1);
  });

  it('clears everything and says how much', () => {
    remember('one', CHAT, null);
    remember('two', CHAT, null);
    expect(forgetAll()).toBe(2);
    expect(readMemory()).toHaveLength(0);
  });
});

describe('a file that cannot be trusted', () => {
  it('reads as empty when it is not JSON, rather than throwing into a turn', () => {
    writeFileSync(inPaths.memory, 'not json');
    expect(readMemory()).toEqual([]);
  });

  it('reads as empty when the shape is wrong', () => {
    // The agent's mount is read-only, but the file is still parsed defensively:
    // a store that fails open would put attacker text into every conversation.
    writeFileSync(inPaths.memory, JSON.stringify({ notes: [{ text: 'no id, no source' }] }));
    expect(readMemory()).toEqual([]);
  });

  it('writes somewhere the agent cannot reach', () => {
    remember('anything', CHAT, null);
    // Inbound volume: the agent mounts it read-only, so it asks rather than writes.
    expect(inPaths.memory).toContain(join(root, 'in'));
    expect(readFileSync(inPaths.memory, 'utf8')).toContain('anything');
  });
});
