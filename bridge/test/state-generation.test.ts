/**
 * One session, one generation.
 *
 * The shared session's id is derived from a generation, and that generation
 * used to be the talking chat's own. A chat reset once and a chat never reset
 * then named two different sessions, and every turn that switched chats killed
 * one and resumed the other. These pin the single number that replaced it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-state-'));
process.env['TULIP_STATE_DIR'] = root;

const { state } = await import('../src/state.js');

const DM = 'a'.repeat(16);
const GROUP = 'b'.repeat(16);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the shared generation', () => {
  it('starts at zero', () => {
    expect(state.sharedGeneration()).toBe(0);
  });

  it('is the same for every chat once one has been reset', () => {
    state.newGeneration(DM);
    // The bug: the group used to read 0 here and name a different session.
    expect(state.sharedGeneration()).toBe(1);
    expect(state.generation(GROUP)).toBe(0);
  });

  it('moves past every chat, so a reset from anywhere is a fresh start for all', () => {
    expect(state.newGeneration(GROUP)).toBe(2);
    expect(state.newGeneration(DM)).toBe(3);
    expect(state.sharedGeneration()).toBe(3);
  });
});
