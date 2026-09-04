/**
 * Typing into a conversation from the panel.
 *
 * `sendToChat` reuses the terminal's path — one place where a keystroke can
 * reach a live conversation — and puts three refusals in front of it. Two of
 * them are cosmetic and one is not:
 *
 * The supervisor's `resolveWindow` falls back to the busy window, then to the
 * most recent session, then to `windows[0]`, whenever the window it was asked
 * for is not open. That is right for a terminal following whatever is active,
 * and catastrophic for a message addressed to one person: a line meant for a
 * sleeping chat would be typed into whichever stranger happened to be talking.
 * So a chat with no live session is refused here, and that is what most of this
 * file is about.
 *
 * `typedLine` is tested beside it because its failure is the same shape. A
 * newline typed with `send-keys -l` is submit, so a pasted paragraph would send
 * its first line as a prompt and strand the rest at a stale one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const KEY = 'abcdef0123456789';
const ASLEEP = 'fedcba9876543210';
/** 2009, not now: a thirteen-digit millisecond stamp reads as a phone number. */
const T0 = 1234567890000;

/**
 * One scratch handoff pair for the whole file, pointed at before the module
 * graph loads.
 *
 * `inPaths` and `outPaths` are computed at import time, so the environment has
 * to be right before the first `import` and cannot usefully change afterwards —
 * a per-test directory would leave the module writing to the first one. Vitest
 * runs each file in its own process, so one directory per file is enough
 * isolation.
 */
const box = mkdtempSync(join(tmpdir(), 'tulip-send-'));
mkdirSync(join(box, 'in'), { recursive: true });
mkdirSync(join(box, 'out'), { recursive: true });
process.env['TULIP_IN_DIR'] = join(box, 'in');
process.env['TULIP_OUT_DIR'] = join(box, 'out');
process.env['TULIP_STATE_DIR'] = join(box, 'state');

const api = await import('../src/panel-api.js');

beforeEach(() => {
  // Every assertion about "nothing was written" needs a clean slate.
  try {
    unlinkSync(join(box, 'in', 'terminal.json'));
  } catch {
    /* not there, which is the state being asked for */
  }
});

afterAll(() => {
  rmSync(box, { recursive: true, force: true });
});

/** What the agent publishes about itself. Advisory everywhere but here. */
function agentReports(chatKeys: readonly string[]): void {
  writeFileSync(
    join(box, 'out', 'status.json'),
    JSON.stringify({
      at: new Date(T0).toISOString(),
      busyTurn: null,
      fatal: null,
      sessions: chatKeys.map((chatKey) => ({
        chatKey,
        startedAt: new Date(T0).toISOString(),
        lastUsedAt: new Date(T0).toISOString(),
        turns: 1,
      })),
    }),
  );
}

/** A registry that knows about the chats it was given and nothing else. */
function deps(known: readonly string[] = [KEY, ASLEEP]): Parameters<typeof api.sendToChat>[0] {
  return {
    chats: { get: (key: string) => (known.includes(key) ? { chatKey: key, name: 'Ana' } : null) },
  } as unknown as Parameters<typeof api.sendToChat>[0];
}

/** The request file the agent polls, or null if nothing was written. */
function request(): { window: string | null; keys: Array<{ text: string; literal: boolean }> } | null {
  try {
    return JSON.parse(readFileSync(join(box, 'in', 'terminal.json'), 'utf8')) as {
      window: string | null;
      keys: Array<{ text: string; literal: boolean }>;
    };
  } catch {
    return null;
  }
}

describe('sendToChat — what it refuses', () => {
  it('refuses a chat key that is not sixteen hex characters', () => {
    agentReports([KEY]);
    for (const bad of ['', 'ABCDEF0123456789', 'abcdef012345678', '../../etc', 'c-abcdef0123456789']) {
      const result = api.sendToChat(deps(), bad, 'hello');
      expect(result.ok).toBe(false);
      expect(result.message).toContain('16-character');
    }
    expect(request()).toBeNull();
  });

  it('refuses a well-formed key we never issued', () => {
    agentReports([KEY]);
    const result = api.sendToChat(deps([KEY]), '0000000000000000', 'hello');
    expect(result).toEqual({ ok: false, message: 'No such chat.' });
    expect(request()).toBeNull();
  });

  it('refuses an empty message, and one that is only whitespace', () => {
    agentReports([KEY]);
    for (const bad of ['', '   ', '\n\n', '\t \r\n']) {
      expect(api.sendToChat(deps(), KEY, bad)).toEqual({ ok: false, message: 'Nothing to send.' });
    }
    expect(request()).toBeNull();
  });

  it('refuses a message longer than one keystroke may carry', () => {
    agentReports([KEY]);
    const result = api.sendToChat(deps(), KEY, 'x'.repeat(2001));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('2000');
    expect(request()).toBeNull();
  });

  it('refuses when the agent is not reporting at all', () => {
    // No status file: the agent has never spoken, so nothing is known about
    // which windows exist and typing would be a guess.
    try {
      unlinkSync(join(box, 'out', 'status.json'));
    } catch {
      /* already absent */
    }
    const result = api.sendToChat(deps(), KEY, 'hello');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not reporting');
    expect(request()).toBeNull();
  });

  /**
   * The one that matters. Without it the supervisor's fallback would type this
   * into whichever conversation happened to be awake.
   */
  it('refuses a chat with no session open, rather than letting it land elsewhere', () => {
    agentReports([KEY]);
    const result = api.sendToChat(deps(), ASLEEP, 'are you there');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no session open');
    expect(request()).toBeNull();
  });
});

describe('sendToChat — what it does', () => {
  it('types the line into that chat’s own window, and submits it separately', () => {
    agentReports([KEY]);
    expect(api.sendToChat(deps(), KEY, 'be a bit warmer').ok).toBe(true);

    const written = request();
    expect(written?.window).toBe(`c-${KEY}`);
    // Literal text, then Enter as a *key*. A newline inside the text would be
    // typed as a character where the TUI is watching for the keypress.
    expect(written?.keys.slice(-2)).toEqual([
      { text: 'be a bit warmer', literal: true },
      { text: 'Enter', literal: false },
    ]);
  });

  it('holds the aim on that window while a watch renewal asks for another', () => {
    // The race this closes: the Chat page writes `{ window: c-<A> }`, and before
    // the agent's 250ms tick collects it the Terminal page renews its watch with
    // `window: null` and the same still-unapplied keys. The agent would resolve
    // null to whichever chat is busy and type A's message into B's conversation.
    agentReports([KEY]);
    expect(api.sendToChat(deps(), KEY, 'hold this').ok).toBe(true);
    api.terminalWatch(null, 90);
    expect(request()?.window).toBe(`c-${KEY}`);
  });

  it('lets the terminal follow the active chat again once the agent has typed it', () => {
    agentReports([KEY]);
    api.sendToChat(deps(), KEY, 'hold this');
    const seq = (api.terminalScreen() as { pendingSeq: number }).pendingSeq;

    // The agent publishes what it has applied; the aim is released on it.
    writeFileSync(
      join(box, 'out', 'screen.json'),
      JSON.stringify({
        at: new Date(T0).toISOString(),
        window: `c-${KEY}`,
        windows: [`c-${KEY}`],
        content: '',
        keySeq: seq,
      }),
    );
    api.terminalWatch(null, 90);
    expect(request()?.window).toBeNull();
  });
});

describe('typedLine', () => {
  it('collapses a pasted paragraph into the single line tmux will type', () => {
    expect(api.typedLine('one\ntwo\n\nthree')).toBe('one two three');
  });

  it('removes control characters rather than typing them at a prompt', () => {
    expect(api.typedLine('a\u001b[31mb\u0007c')).toBe('a [31mb c');
  });

  it('leaves an ordinary line alone', () => {
    expect(api.typedLine('  ask her about the venue  ')).toBe('ask her about the venue');
  });

  it('is empty for anything that was only whitespace', () => {
    expect(api.typedLine(' \n\t ')).toBe('');
  });
});
