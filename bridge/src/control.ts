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
import type { Limiter } from './ratelimit.js';
import { state } from './state.js';
import type { WhatsApp } from './whatsapp.js';

const HELP = `*Tulip — operator commands*

!status          bridge, agent and queue state
!hold            stop handing messages to the agent (they keep queueing)
!release         hand over everything held
!chats           chats seen recently
!block <key>     stop answering a chat (use the key from !chats)
!unblock <key>   answer it again
!reset <key>     abandon that chat's context; the next message starts fresh
!help            this list`;

export interface ControlDeps {
  readonly wa: WhatsApp;
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

export async function handleControl(deps: ControlDeps, envelope: Envelope, chatKey: string): Promise<void> {
  const say = (text: string): Promise<void> => deps.wa.sendText(envelope.chatJid, text);
  const [word, ...rest] = envelope.text.trim().split(/\s+/);
  const command = (word ?? '').slice(1).toLowerCase();
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
          `whatsapp ${deps.wa.connected ? 'connected' : '*disconnected*'}\n` +
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
        `\`${argument}\` will start a fresh context on its next message (generation ${generation}). ` +
          `The old transcript is still on disk.`,
      );
    }

    default:
      return say(`Unknown command \`!${command}\`. Try \`!help\`.`);
  }
}
