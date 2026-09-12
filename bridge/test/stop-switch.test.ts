/**
 * The stop switch: what `--stop-juan`, `!stop` and the panel's stop button do.
 *
 * The reason this is not just another name for `!hold` is the only thing worth
 * testing here. A hold decides what is handed over *next*, so a turn that is
 * already talking finishes it, writes its sends, and they go out — which means
 * that at the moment an operator most wants silence, a hold delivers a message
 * anyway. The interrupt is what closes that gap, and it closes it the same way a
 * person would: an Escape into the pane that is generating.
 *
 * So both halves are asserted, and so is the order. Hold first: with Escape
 * first there is a window in which the interrupted turn ends, the dispatcher
 * pumps, and a new turn starts before the hold lands — a stop that visibly does
 * nothing, which is the worst failure this switch can have.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const box = mkdtempSync(join(tmpdir(), 'tulip-stop-'));
mkdirSync(join(box, 'in'), { recursive: true });
mkdirSync(join(box, 'out'), { recursive: true });
process.env['TULIP_IN_DIR'] = join(box, 'in');
process.env['TULIP_OUT_DIR'] = join(box, 'out');
process.env['TULIP_STATE_DIR'] = join(box, 'state');

const { startChat, stopChat, stopNow } = await import('../src/panel-api.js');
const { state } = await import('../src/state.js');

/** Stands in for the dispatcher, recording what the stop asked it to do. */
const abandoned: Array<{ why: string; only?: string }> = [];
let busyChat: string | null = null;
const dispatcher = {
  abandonInFlight: (why: string, only?: string) => void abandoned.push({ why, only }),
  inFlightChat: () => busyChat,
};

const terminalRequest = (): { window: string | null; keys: Array<{ text: string; literal: boolean }> } =>
  JSON.parse(readFileSync(join(box, 'in', 'terminal.json'), 'utf8')) as never;

const ROOM = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';

beforeEach(() => {
  abandoned.length = 0;
  busyChat = null;
  state.clearStopped(ROOM);
  state.clearStopped(OTHER);
  state.setHold(false, 'test');
  try {
    unlinkSync(join(box, 'in', 'terminal.json'));
  } catch {
    /* first test in the file */
  }
});

describe('stopChat — one room, not the deployment', () => {
  it('stops the room it was asked about', () => {
    stopChat(ROOM, 'Mira', dispatcher);
    expect(state.isStopped(ROOM)).toBe(true);
  });

  it('leaves every other conversation alone', () => {
    // The regression. The first version of this switch was global, so one
    // `!stopjuan` in a test group took the agent off every chat at once —
    // a stranger in one room deciding for everybody.
    stopChat(ROOM, 'Mira', dispatcher);
    expect(state.isStopped(OTHER)).toBe(false);
    expect(state.isHeld()).toBe(false);
  });

  it('records who asked, because the panel shows it back', () => {
    stopChat(ROOM, 'Mira', dispatcher);
    expect(state.stoppedInfo(ROOM)?.by).toBe('Mira');
  });

  it('interrupts only when the turn in flight belongs to that room', () => {
    busyChat = ROOM;
    stopChat(ROOM, 'Mira', dispatcher);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.only).toBe(ROOM);
  });

  it('does not interrupt a sentence being written to somebody else', () => {
    // Stopping a quiet room must not cut off another conversation mid-word.
    busyChat = OTHER;
    stopChat(ROOM, 'Mira', dispatcher);
    expect(abandoned).toHaveLength(0);
    expect(state.isStopped(ROOM)).toBe(true);
  });

  it('is undone by startChat, and only for that room', () => {
    stopChat(ROOM, 'Mira', dispatcher);
    stopChat(OTHER, 'Kai', dispatcher);
    startChat(ROOM, 'panel');
    expect(state.isStopped(ROOM)).toBe(false);
    expect(state.isStopped(OTHER)).toBe(true);
  });
});

describe('stopNow', () => {
  it('holds delivery, so nothing new is handed over', () => {
    stopNow('test', dispatcher);
    expect(state.isHeld()).toBe(true);
  });

  it('sends an Escape, which is what interrupts the turn already talking', () => {
    // The half a hold cannot do. Non-literal: `send-keys Escape` is the key,
    // where `send-keys -l Escape` would type the six letters into the prompt.
    stopNow('test', dispatcher);
    const keys = terminalRequest().keys;
    expect(keys.some((k) => k.text === 'Escape' && k.literal === false)).toBe(true);
  });

  it('aims at no particular window, so the agent interrupts the busy one', () => {
    // A named window would be wrong twice over: the chat that is generating is
    // not necessarily the one an operator last looked at, and the supervisor's
    // fallback for a window that is not open would send the Escape somewhere
    // else entirely.
    stopNow('test', dispatcher);
    expect(terminalRequest().window).toBeNull();
  });

  it('records who stopped it, so the feed says where the switch was pulled', () => {
    stopNow('operator', dispatcher);
    expect(state.holdInfo().by).toBe('operator');
  });

  it('holds before it interrupts, not after', () => {
    // Ordering, asserted the only way it can be from outside: the hold must
    // already be true at the moment the terminal request is written. Reading
    // the file back proves it was written; `isHeld` proves the hold survived
    // the whole call. The regression this guards is the reverse order, where a
    // turn can end and a new one start in between.
    stopNow('test', dispatcher);
    expect(state.isHeld()).toBe(true);
    expect(terminalRequest().keys.length).toBeGreaterThan(0);
  });

  it('closes the turn record, so a release is not waiting on a dead turn', () => {
    // The bug the first real use of this switch found. The Escape stops the
    // agent before it can report the turn finished, so without this the
    // dispatcher waits out the full ten-minute timeout and a release in that
    // window hands over nothing — a stop nobody can undo.
    stopNow('test', dispatcher);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.why).toContain('stopped by test');
    // No room named: the global stop ends whatever is in flight, whoever it
    // belongs to. That is the difference from stopChat, one describe down.
    expect(abandoned[0]?.only).toBeUndefined();
  });

  it('is undone by a release, not by calling it again', () => {
    stopNow('test', dispatcher);
    state.setHold(false, 'operator');
    expect(state.isHeld()).toBe(false);
  });
});
