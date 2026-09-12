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
import { WRONG_ROOM, commandName, controlDisposition, isControlCommand } from '../src/control.js';

const ask = (text: string, isOperator: boolean, isGroup: boolean): string =>
  controlDisposition({ text, isOperator, isGroup });

describe('an operator', () => {
  it('is obeyed in a direct message', () => {
    expect(ask('!status', true, false)).toBe('run');
    expect(ask('!hold', true, false)).toBe('run');
    expect(ask('!stop', true, false)).toBe('run');
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

  it('can undo a stop from inside the room, in any capitalisation', () => {
    // The matching off switch. Without it a room could silence the agent and
    // only a browser could bring it back, which is a switch with one direction.
    for (const text of ['!releasejuan', '!RELEASEJUAN', '!ReleaseJuan']) {
      expect(ask(text, true, true), text).toBe('run');
      expect(ask(text, true, false), text).toBe('run');
    }
  });

  it('can stop from inside a room, without going to find the DM', () => {
    // The case the group rule used to break: the agent is saying something
    // wrong in front of people, and the operator is in that room.
    expect(ask('!stop', true, true)).toBe('run');
  });
});

describe('anybody else', () => {
  it('is ignored in a direct message', () => {
    expect(ask('!status', false, false)).toBe('ignore');
  });

  it('is ignored in a group', () => {
    expect(ask('!chats', false, true)).toBe('ignore');
  });

  it('can stop the agent however they capitalise it', () => {
    // What a phone actually sends. iOS capitalises the first letter of a
    // message and `!` does not stop it, so the shouted and the auto-corrected
    // spellings are the common ones, not the exception.
    for (const text of ['!stopjuan', '!STOPJUAN', '!StopJuan', '!Stopjuan', '!sToPjUaN']) {
      expect(ask(text, false, true), text).toBe('run');
      expect(ask(text, false, false), text).toBe('run');
    }
  });

  it('normalises the name to one spelling', () => {
    expect(commandName('!STOPJUAN')).toBe('stopjuan');
    expect(commandName('!StopJuan')).toBe('stopjuan');
    expect(commandName('!Stopjuan')).toBe('stopjuan');
  });

  it('answers to the bare !stop, for when autocorrect splits the word', () => {
    // `!stopjuan` is not in any dictionary, so a phone is entitled to make it
    // `!stop juan` — at which point only the first word is the command. That
    // is the case this alias exists for, not tidiness.
    expect(ask('!stop juan', false, true)).toBe('run');
    expect(ask('!stop', false, true)).toBe('run');
    expect(ask('!STOP', false, true)).toBe('run');
    expect(commandName('!stop juan')).toBe('stop');
  });

  it('can stop the agent, which is the one command open to them', () => {
    // Deliberately the reverse of every other command here. Silence is the safe
    // direction: the worst a stranger achieves is the thing the command is for,
    // and a room that cannot stop the agent has only one other lever — removing
    // it from the group, which has already happened once.
    expect(ask('!stop', false, false)).toBe('run');
    expect(ask('!stop', false, true)).toBe('run');
  });

  it('still cannot start it again, which is where the asymmetry lives', () => {
    // Anyone may push toward quiet; only an operator may push back. If any of
    // these ever returns 'run', a stranger can undo an operator's stop — or
    // undo their own, which makes the switch decorative.
    expect(ask('!release', false, false)).toBe('ignore');
    expect(ask('!release', false, true)).toBe('ignore');
    expect(ask('!releasejuan', false, true)).toBe('ignore');
    expect(ask('!releasejuan', false, false)).toBe('ignore');
    expect(ask('!RELEASEJUAN', false, true)).toBe('ignore');
    expect(ask('!hold', false, true)).toBe('ignore');
  });

  it('does not treat a word merely starting with stop as the switch', () => {
    // `!stopping` is not a stop. A prefix match here would make every unknown
    // command beginning with those four letters a kill switch anybody can pull.
    expect(ask('!stopping', false, true)).toBe('ignore');
    expect(ask('!stopjuanx', false, true)).toBe('ignore');
  });

  it('gets nothing else, in either place', () => {
    // The open command must not become an open door. Everything that discloses
    // stays shut to a stranger whether they ask in a room or in a DM.
    for (const command of ['!status', '!chats', '!help', '!reset abc', '!unblock abc']) {
      expect(ask(command, false, true), command).toBe('ignore');
      expect(ask(command, false, false), command).toBe('ignore');
    }
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
