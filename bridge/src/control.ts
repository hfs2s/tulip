import { AGENT_NAME } from './instance.js';
import { controlHelpText } from '@2lp/shared';
/**
 * Operator commands, sent over WhatsApp from a number in `operators.numbers`.
 *
 * Handled entirely inside the bridge, before the gate and before the agent sees
 * anything. That is the point: these are the controls you need *because*
 * something is wrong with the agent, so routing them through it would make them
 * useless exactly when they matter.
 *
 * The operator list is never widened by `audience.everyone`. A public bot whose
 * control commands are open to the public is not a bot, it is a shell.
 */
import type { ChatRegistry } from './chats.js';
import type { Dispatcher } from './dispatcher.js';
import type { Envelope } from './envelope.js';
import { feed } from './feed.js';
import { readStatus } from './handoff.js';
import { log } from './log.js';
import { startChat, stopChat } from './panel-api.js';
import type { Limiter } from './ratelimit.js';
import { state } from './state.js';
import type { Transport } from './transport.js';

// Rendered from the shared catalogue, which the panel's Verbs page also reads.
const HELP = controlHelpText();

export interface ControlDeps {
  readonly wa: Transport;
  readonly chats: ChatRegistry;
  readonly limiter: Limiter;
  readonly dispatcher: () => Dispatcher;
}

const ago = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
};

export function isControlCommand(text: string): boolean {
  return /^!\w[\w-]*/.test(text.trim());
}

/** The one-line answer to a control command sent into a room. */
export const WRONG_ROOM =
  'Control commands only work in a direct message. Send it to me privately and I will run it.';

export type ControlDisposition = 'run' | 'wrongRoom' | 'ignore';

/**
 * Whether to act on a message that looks like a control command.
 *
 * Split out from the dispatcher because it is three conditions with a real
 * consequence attached to each, and because the group rule is new: these
 * commands used to run wherever an operator typed them, so `!chats` in a room
 * printed every chat key and name into it. The commands answer in the chat they
 * were sent from — that is what makes them useful when the agent is broken, and
 * it is also what made a room the wrong place for them.
 *
 * `wrongRoom` rather than `ignore` for an operator in a group, deliberately.
 * Silence there is indistinguishable from the bridge being down, which is
 * exactly the moment somebody is typing `!status`. The reply says where to go
 * and nothing else: no command list, no state, no acknowledgement of what was
 * asked for.
 *
 * A non-operator is always `ignore`, in a room or out of it. Answering them at
 * all — even to refuse — confirms that the commands exist and that this number
 * has an operator, which is the one thing worth not handing out.
 */
/**
 * The command name, without its `!`. One parser, used by both readers below.
 *
 * Normalised for what a phone actually sends rather than what somebody meant to
 * type, because the one command that must never fail on a technicality is the
 * one an upset person types in a hurry:
 *
 *   - **Case.** iOS capitalises the first letter of a message, and `!` does not
 *     stop it, so `!stopjuan` arrives as `!Stopjuan`. `!STOPJUAN` is what
 *     somebody types when they mean it.
 *   - **No hyphen in the name, on purpose.** WhatsApp rewrites `--` to an em
 *     dash as you type and smart punctuation can send an en dash for a hyphen,
 *     so a hyphenated command is one a phone can silently break. `stopjuan` is
 *     one word for that reason, and `stop` exists beside it because autocorrect
 *     is just as happy to split an unfamiliar word into two.
 */
export function commandName(text: string): string {
  const [word] = text.trim().split(/\s+/);
  return (word ?? '').slice(1).toLowerCase();
}

/**
 * Commands anybody may run, anywhere — including a stranger, including a room.
 *
 * Exactly one, and it is worth being explicit about why it is not the security
 * hole it looks like.
 *
 * Every other control command *discloses*: `!chats` prints keys and names,
 * `!status` reports the deployment, `!help` confirms the surface exists at all.
 * Those are operator-only in a direct message for that reason. `!stop` discloses
 * nothing. Its entire effect is silence, and silence is the safe direction — the
 * worst a malicious stranger achieves is the outcome the command is *for*.
 *
 * The argument for opening it is that the moment somebody most needs this is
 * when the agent is saying something wrong **in a room**, in front of people,
 * and a rule that says "go and find the direct message" is a rule that fails
 * exactly then. A room that cannot stop it has only one other lever, and that
 * lever is removing the agent from the group — which has already happened once.
 * Better a switch anybody can pull than a bot nobody trusts.
 *
 * The asymmetry is the safeguard: stopping is open, **starting is not**.
 * `!release` stays operator-only, so anyone can push toward quiet and only an
 * operator can push back. A stop is global rather than per-room, deliberately:
 * somebody who has decided this thing needs to shut up should not have to know
 * which rooms it is in.
 */
const STOP_ALIASES = ['stopjuan', 'stop'] as const;
const OPEN_TO_EVERYONE: ReadonlySet<string> = new Set(STOP_ALIASES);

/**
 * Commands an operator may run in a room, rather than only in a direct message.
 *
 * The group rule exists because control commands answer where they were typed,
 * and `!chats` in a room printed every key and name into it. Undoing a stop
 * discloses nothing, and the room is exactly where somebody needs it: a room
 * that can silence the agent with `!stopjuan` and can only be un-silenced from
 * a browser is a switch with no matching off — which is what shipped, until the
 * question "so we use !releasejuan?" turned out to have the answer "there is no
 * such thing".
 *
 * Operator-only, which is the asymmetry the open stop depends on.
 */
const OPERATOR_ANYWHERE: ReadonlySet<string> = new Set(['releasejuan']);

export function controlDisposition(input: {
  text: string;
  isOperator: boolean;
  isGroup: boolean;
}): ControlDisposition {
  if (!isControlCommand(input.text)) return 'ignore';
  // Before the operator test and before the group test, because this one is
  // subject to neither.
  if (OPEN_TO_EVERYONE.has(commandName(input.text))) return 'run';
  if (!input.isOperator) return 'ignore';
  if (OPERATOR_ANYWHERE.has(commandName(input.text))) return 'run';
  return input.isGroup ? 'wrongRoom' : 'run';
}

export async function handleControl(deps: ControlDeps, envelope: Envelope, chatKey: string): Promise<void> {
  // Control replies are fire-and-forget: nothing here is ever edited or
  // retracted, so the key `sendText` now returns is deliberately dropped.
  const say = async (text: string): Promise<void> => {
    await deps.wa.sendText(envelope.chatJid, text);
  };
  const [, ...rest] = envelope.text.trim().split(/\s+/);
  const command = commandName(envelope.text);
  const argument = rest[0] ?? '';

  log('control', { chatKey, command });

  switch (command) {
    case 'help':
      return say(HELP);

    case 'status': {
      const status = readStatus();
      const snapshot = deps.dispatcher().snapshot();
      const hold = state.isHeld() ? `\n*DELIVERY HELD* — !release to resume` : '';
      const sessions = status?.sessions.length ?? 0;
      return say(
        `*Tulip*${hold}\n` +
          `${deps.wa.kind} ${deps.wa.connected ? 'connected' : '*disconnected*'}\n` +
          `agent ${status === null ? '*not reporting*' : status.fatal ? `*${status.fatal}*` : 'ok'}\n` +
          `${sessions} chat session(s) live · ${deps.chats.size} chats known\n` +
          `queue: ${snapshot.queued} waiting, ${snapshot.ready} chat(s) ready` +
          (snapshot.inFlight ? `\nanswering ${snapshot.inFlight} now` : '\nidle'),
      );
    }

    case 'hold': {
      state.setHold(true, 'operator');
      feed.event('hold.on', 'delivery held by an operator');
      return say('Holding. Messages keep arriving and are recorded; the agent sees none until `!release`.');
    }

    case 'release': {
      state.setHold(false, 'operator');
      feed.event('hold.off', 'delivery released by an operator');
      void deps.dispatcher().pump();
      return say('Released — handing over anything that was waiting.');
    }

    case 'stopjuan':
    case 'stop': {
      // The one control that acts on the present rather than the future — see
      // `stopNow`, since !hold cannot reach a turn that is already talking —
      // and the one anybody may run, including here in a room. See
      // OPEN_TO_EVERYONE.
      const who = envelope.pushName ?? 'someone';
      stopChat(chatKey, who.slice(0, 80), deps.dispatcher());

      if (!envelope.isGroup) {
        return say('Stopped here. I will not answer in this conversation until an operator starts me again.');
      }

      // In a room, acknowledge with a reaction rather than a message. Somebody
      // has just asked for quiet; answering with a paragraph about control
      // commands would be the noise they were objecting to, and it would
      // advertise the surface to everybody standing there. A raised hand on
      // their own message is unambiguous and says nothing to anyone else.
      //
      // Falling back to one line if the reaction fails, because silence here is
      // indistinguishable from the command having done nothing — the same
      // reason `wrongRoom` answers at all.
      const participant = envelope.senderIds[0];
      // A platform with no reactions gets the one line instead — the same
      // fallback as a reaction that fails, for the same reason.
      if (deps.wa.react === undefined) {
        log('control.noReactions', { chatKey, transport: deps.wa.kind });
        return say('Stopped.');
      }
      try {
        await deps.wa.react(envelope.chatJid, envelope.id, '✋', participant);
      } catch (err) {
        log('control.reactFailed', { chatKey, why: String((err as Error).message).slice(0, 80) });
        await say('Stopped.');
      }
      return;
    }

    case 'releasejuan': {
      // The opposite of `!stopjuan`, and deliberately the same shape: it acts
      // on the chat it was typed in, not on the deployment.
      //
      // It does not also clear a global hold. One command, one meaning, is what
      // the rest of this switch does — but silence with no explanation is what
      // sent somebody looking for this command in the first place, so if a hold
      // is what is still keeping the agent quiet, the reply says so and names
      // the command that lifts it.
      startChat(chatKey, envelope.pushName ?? 'an operator');
      const held = state.isHeld()
        ? ' Delivery is still held everywhere, though — send `!release` to lift that too.'
        : '';

      if (!envelope.isGroup) return say('Answering here again.' + held);
      if (deps.wa.react === undefined) return say('Answering here again.' + held);
      try {
        await deps.wa.react(envelope.chatJid, envelope.id, '✅', envelope.senderIds[0]);
        if (held) await say('Answering here again.' + held);
      } catch {
        await say('Answering here again.' + held);
      }
      return;
    }

    case 'chats': {
      const chats = deps.chats
        .all()
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .slice(0, 20);
      if (chats.length === 0) return say('No chats yet.');
      const lines = chats.map((c) => {
        const stats = deps.limiter.stats(c.chatKey);
        return (
          `• \`${c.chatKey}\` ${c.name ?? '(unnamed)'}${c.isGroup ? ' (group)' : ''}` +
          `${c.blocked ? ' *blocked*' : ''} — ${c.messages} msgs, ` +
          `${stats?.turnsToday ?? 0} turns today, last ${ago(Date.now() - c.lastSeenAt)} ago`
        );
      });
      return say(`*Chats*\n${lines.join('\n')}`);
    }

    case 'block':
    case 'unblock': {
      const blocking = command === 'block';
      if (!/^[0-9a-f]{16}$/.test(argument)) {
        return say(`Usage: \`!${command} <key>\` — the 16-character key from \`!chats\`.`);
      }
      if (!deps.chats.setBlocked(argument, blocking)) return say(`No chat with key \`${argument}\`.`);
      deps.chats.flush();
      feed.event(blocking ? 'chat.blocked' : 'chat.unblocked', argument);
      return say(blocking ? `Blocked \`${argument}\`. It will be recorded but never answered.` : `Unblocked \`${argument}\`.`);
    }

    case 'reset': {
      if (!/^[0-9a-f]{16}$/.test(argument)) return say('Usage: `!reset <key>` — the key from `!chats`.');
      if (deps.chats.get(argument) === null) return say(`No chat with key \`${argument}\`.`);
      const generation = state.newGeneration(argument);
      feed.event('chat.reset', `${argument} → generation ${generation}`);
      return say(
        `${AGENT_NAME} will start a fresh context on the next message, in every chat — there is one session ` +
          `(generation ${generation}). The old transcript is still on disk.`,
      );
    }

    default:
      return say(`Unknown command \`!${command}\`. Try \`!help\`.`);
  }
}
