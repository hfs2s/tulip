/**
 * `!reset` — abandoning a chat's context.
 *
 * It reported success and did nothing for as long as it existed. The bridge
 * kept a per-chat generation and bumped it; the agent derived its session id
 * from `process.env.TULIP_GENERATION`, which the bridge never wrote. So the
 * command moved a number on one side of the wall and the session on the other
 * side carried on unchanged — including its `CLAUDE.md`, which is regenerated
 * only on a genuine spawn. Editing the persona and restarting the container
 * looked like it had done nothing, because it had.
 *
 * The generation travels on the turn pointer now, which is the file the agent
 * already reads before every turn.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const box = mkdtempSync(join(tmpdir(), 'tulip-gen-'));
mkdirSync(join(box, 'in', 'batches'), { recursive: true });
mkdirSync(join(box, 'out'), { recursive: true });
process.env['TULIP_IN_DIR'] = join(box, 'in');
process.env['TULIP_OUT_DIR'] = join(box, 'out');
process.env['TULIP_STATE_DIR'] = join(box, 'state');

const { publishTurn } = await import('../src/handoff.js');
const { state } = await import('../src/state.js');
const { CurrentTurn } = await import('@tulip/shared');

const KEY = 'abcdef0123456789';
const TURN = '11111111-2222-4333-8444-555555555555';

function publish(generation: number): Record<string, unknown> {
  publishTurn({
    turnId: TURN,
    chatKey: KEY,
    chatName: 'Chris',
    isGroup: false,
    receivedAt: new Date().toISOString(),
    messages: [{ from: 'Chris', at: new Date().toISOString(), text: 'oi', mentionsMe: false, quoted: null, media: [] }],
  }, undefined, generation);
  return JSON.parse(readFileSync(join(box, 'in', 'current.json'), 'utf8')) as Record<string, unknown>;
}

afterAll(() => rmSync(box, { recursive: true, force: true }));

describe('the generation reaches the agent', () => {
  it('is on the turn pointer, which is what the agent reads', () => {
    expect(publish(0)['generation']).toBe(0);
    expect(publish(3)['generation']).toBe(3);
  });

  it('defaults to zero for a pointer written before it existed', () => {
    // A deploy happens between a turn being written and read, so the schema has
    // to tolerate the previous build's file rather than refuse it.
    const parsed = CurrentTurn.parse({
      turnId: TURN, chatKey: KEY, chatName: 'Chris', isGroup: false,
      batch: `batches/${TURN}.json`, startedAt: new Date().toISOString(),
    });
    expect(parsed.generation).toBe(0);
  });
});

describe('!reset moves it', () => {
  it('raises the chat’s generation, and only that chat’s', () => {
    const other = 'fedcba9876543210';
    const before = state.generation(KEY);
    expect(state.newGeneration(KEY)).toBe(before + 1);
    expect(state.generation(KEY)).toBe(before + 1);
    expect(state.generation(other)).toBe(0);
  });

  it('shows up on the next turn published for that chat', () => {
    const now = state.generation(KEY);
    expect(publish(state.generation(KEY))['generation']).toBe(now);
  });
});
