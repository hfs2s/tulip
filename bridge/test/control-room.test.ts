/**
 * Where a control command may be typed.
 *
 * These commands answer in the chat they were sent from — that is what makes
 * them useful when the agent is broken, and it is also what made a room the
 * wrong place for them. `!chats` in a group printed every chat key and name
 * into it, and `!status` reported the deployment's state to whoever happened to
 * be standing there.
 *
 * Three outcomes, and the difference between two of them is the point:
 *
 *   - `run` — an operator, in a direct message.
 *   - `wrongRoom` — an operator, in a group. Answered with one line, because
 *     silence is indistinguishable from the bridge being down, which is exactly
 *     when somebody types `!status`.
 *   - `ignore` — anybody else, anywhere. Not refused, ignored: answering at all
 *     confirms the commands exist and that this number has an operator.
 */
import { describe, expect, it } from 'vitest';
import { WRONG_ROOM, controlDisposition, isControlCommand } from '../src/control.js';

const ask = (text: string, isOperator: boolean, isGroup: boolean): string =>
  controlDisposition({ text, isOperator, isGroup });

describe('an operator', () => {
  it('is obeyed in a direct message', () => {
    expect(ask('!status', true, false)).toBe('run');
    expect(ask('!hold', true, false)).toBe('run');
  });

  it('is redirected in a group, not obeyed', () => {
    // The change. Every one of these used to run in the room it was typed in.
    for (const command of ['!status', '!chats', '!hold', '!release', '!reset abc', '!help']) {
      expect(ask(command, true, true), command).toBe('wrongRoom');
    }
  });

  it('is redirected rather than ignored, so a broken bridge is distinguishable', () => {
    expect(ask('!status', true, true)).not.toBe('ignore');
  });
});

describe('anybody else', () => {
  it('is ignored in a direct message', () => {
    expect(ask('!status', false, false)).toBe('ignore');
  });

  it('is ignored in a group', () => {
    expect(ask('!chats', false, true)).toBe('ignore');
  });

  it('is never told the commands exist', () => {
    // A refusal is a confirmation. Both non-operator cases must be the same
    // outcome as an ordinary message, which is what `ignore` means here.
    expect(ask('!hold', false, true)).toBe('ignore');
    expect(ask('!hold', false, false)).toBe('ignore');
  });
});

describe('messages that are not commands', () => {
  it('falls through to the agent, whoever sent it', () => {
    for (const text of ['hello', 'what is !important is this', '', '  ', '!']) {
      expect(ask(text, true, false), text).toBe('ignore');
      expect(ask(text, false, false), text).toBe('ignore');
    }
  });

  it('does not treat a bare exclamation as a command', () => {
    expect(isControlCommand('!')).toBe(false);
    expect(ask('!!!', true, false)).toBe('ignore');
  });

  it('still recognises one with leading whitespace', () => {
    // People type into a phone keyboard.
    expect(ask('  !status', true, false)).toBe('run');
  });
});

describe('what the redirect says', () => {
  it('names where to go and nothing else', () => {
    expect(WRONG_ROOM).toContain('direct message');
  });

  it('does not list the commands or echo the one that was sent', () => {
    // It is spoken into a room of strangers, so it must carry no state, no
    // command list, and no acknowledgement of what was asked for.
    expect(WRONG_ROOM).not.toContain('!');
    expect(WRONG_ROOM.length).toBeLessThan(140);
  });
});
