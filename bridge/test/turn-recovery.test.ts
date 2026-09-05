/**
 * A turn that was open when the bridge restarted.
 *
 * The registry lives in memory, so a restart forgot every open turn — and the
 * agent's reply, written seconds later against an id this bridge had issued,
 * resolved to nothing and was discarded as unroutable. It cost a voice note and
 * a message an operator had asked for, twice in one day, and the agent reported
 * both as sent: from inside the container "the action file I wrote disappeared"
 * is exactly what success looks like too.
 *
 * `current.json` is written before injection and holds the missing piece, so
 * the turn can be adopted on boot. It is on the inbound volume, which the agent
 * mounts read-only — the id it names is one the bridge issued, not one an agent
 * chose for itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const box = mkdtempSync(join(tmpdir(), 'tulip-recover-'));
mkdirSync(join(box, 'in', 'batches'), { recursive: true });
mkdirSync(join(box, 'out'), { recursive: true });
process.env['TULIP_IN_DIR'] = join(box, 'in');
process.env['TULIP_OUT_DIR'] = join(box, 'out');
process.env['TULIP_STATE_DIR'] = join(box, 'state');

const { readCurrentTurn } = await import('../src/handoff.js');
const { TurnRegistry } = await import('../src/turns.js');

const TURN = '11111111-2222-4333-8444-555555555555';
const KEY = 'abcdef0123456789';
const TTL = 600_000;

function writeCurrent(startedAt: string, turnId = TURN): void {
  writeFileSync(join(box, 'in', 'current.json'), JSON.stringify({
    turnId, chatKey: KEY, chatName: 'Chris', isGroup: false,
    batch: `batches/${turnId}.json`, startedAt,
  }));
}

beforeEach(() => rmSync(join(box, 'in', 'current.json'), { force: true }));
afterAll(() => rmSync(box, { recursive: true, force: true }));

describe('reading the interrupted turn', () => {
  it('finds a turn that was open moments ago', () => {
    writeCurrent(new Date().toISOString());
    expect(readCurrentTurn(TTL)?.turnId).toBe(TURN);
  });

  it('ignores one older than a turn is allowed to live', () => {
    // A pointer from yesterday should not resurrect a turn everybody has
    // forgotten, and its reply would be answering a conversation that moved on.
    writeCurrent(new Date(Date.now() - TTL - 1000).toISOString());
    expect(readCurrentTurn(TTL)).toBeNull();
  });

  it('is null when there is no pointer at all', () => {
    expect(readCurrentTurn(TTL)).toBeNull();
  });

  it('is null rather than throwing on a corrupt or half-written file', () => {
    writeFileSync(join(box, 'in', 'current.json'), '{"turnId": "not-a-uuid"');
    expect(readCurrentTurn(TTL)).toBeNull();
    writeFileSync(join(box, 'in', 'current.json'), JSON.stringify({ turnId: TURN }));
    expect(readCurrentTurn(TTL)).toBeNull();
  });
});

describe('adopting it', () => {
  it('makes the reply routable again, which is the whole point', () => {
    const turns = new TurnRegistry(TTL, 8, 24);
    const now = Date.now();
    expect(turns.resolve(TURN, now).ok).toBe(false);

    turns.adopt(TURN, '15551234567@s.whatsapp.net', KEY, now - 5_000);

    const after = turns.resolve(TURN, now);
    expect(after.ok).toBe(true);
    expect(after.ok && after.turn.chatKey).toBe(KEY);
  });

  /**
   * Provenance was decided from the envelope and the envelope is gone. A
   * recovered turn may finish its reply — that is what it is for — but must not
   * be able to turn a phone number into a chat key on authority nobody can
   * still verify.
   */
  it('does not carry operator authority across the restart', () => {
    const turns = new TurnRegistry(TTL, 8, 24);
    const turn = turns.adopt(TURN, '15551234567@s.whatsapp.net', KEY, Date.now());
    expect(turn.fromOperator).toBe(false);
  });

  it('keeps the original clock, so it expires when it always would have', () => {
    const turns = new TurnRegistry(TTL, 8, 24);
    const now = Date.now();
    turns.adopt(TURN, '15551234567@s.whatsapp.net', KEY, now - TTL - 1);
    expect(turns.resolve(TURN, now).ok).toBe(false);
  });
});
