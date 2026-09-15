/**
 * The gate: which inbound messages are answered.
 *
 * Written as a pure function over a narrow input so it can be tested
 * exhaustively without a WhatsApp socket. It is the first of the two things
 * standing between a stranger's text and an agent holding a shell — the second
 * being the container the agent runs in, which is what actually carries the
 * weight (see docs/THREAT-MODEL.md §T1).
 *
 * Two rules that look like details and are not:
 *
 *   - **A denied sender is never answered, not even to say no.** A refusal
 *     confirms the number is live and reachable, which is the one bit of
 *     information an enumerating attacker wants. Denials are recorded, never
 *     replied to.
 *   - **Every message is recorded regardless of the verdict.** A silently
 *     dropped message is indistinguishable from one that never arrived, which
 *     makes "I texted it and nothing happened" impossible to diagnose. The
 *     caller writes to the feed either way; this function only decides.
 */
import type { Config } from './config.js';
import { matchesList } from './jid.js';

/** The part of an envelope the gate looks at. */
export interface GateInput {
  /** Which conversation this arrived in, so a room's own setting can be found. */
  readonly chatKey: string;
  readonly senderIds: readonly string[];
  readonly text: string;
  readonly isGroup: boolean;
  readonly mentionsMe: boolean;
  readonly isReaction: boolean;
  readonly isPollVote: boolean;
  /** Whether any attachment actually arrived and can be looked at. */
  readonly hasMedia: boolean;
}

export type GateVerdict = { accept: true } | { accept: false; reason: string };

const ACCEPT: GateVerdict = { accept: true };
const deny = (reason: string): GateVerdict => ({ accept: false, reason });

/**
 * Every reason this gate refuses a message, named.
 *
 * These strings are written to the feed on each refusal and read back by
 * `history.ts`, which decides from the reason alone whether an operator asking
 * to read a room may see the message. That is two copies of one vocabulary, and
 * the failure mode of letting them drift is invisible: reword a literal here and
 * recall silently stops surfacing that class of message, with nothing to say
 * why. Naming them once makes the drift a type error instead of a silence.
 */
export const REFUSAL = {
  reaction: 'reaction — recorded, not answered',
  pollVote: 'poll vote — recorded, not answered',
  nothingToAnswer: 'nothing to answer',
  groupsDisabled: 'groups are disabled',
  notMentioned: 'not mentioned in group',
  noTrigger: 'no trigger word in group',
  notOnList: 'sender is not on the allow list',
} as const;

/**
 * How the agent behaves in one room: its own setting, or the global one.
 *
 * Exported because three places need the same answer — the gate, the reactivity
 * the dispatcher hands the agent, and the panel drawing the row — and a second
 * copy of `?? config.groups.replyTo` is how they come to disagree.
 */
export function groupModeFor(config: Config, chatKey: string): 'mention' | 'trigger' | 'observe' {
  return config.groups.perChat[chatKey]?.replyTo ?? config.groups.replyTo;
}

/** Is this sender an operator? Never widened by `audience.everyone`. */
export function isOperator(config: Config, senderIds: readonly string[]): boolean {
  return matchesList(config.operators, senderIds);
}

/**
 * Decide whether to answer.
 *
 * Order matters. The blocklist is checked by the caller before this is reached;
 * within it, the cheap content checks come first so a reaction from a blocked
 * group never reaches the audience logic at all.
 */
export function gate(input: GateInput, config: Config): GateVerdict {
  // Recorded, not answered. Replying to every thumbs-up would be obnoxious, and
  // a vote is information rather than a question.
  if (input.isReaction) return deny(REFUSAL.reaction);
  if (input.isPollVote) return deny(REFUSAL.pollVote);

  // Nothing to answer: no words *and* nothing to look at. Reached when a
  // message carries only media that failed to download, or a type the parser
  // does not understand.
  //
  // This used to test the text alone, which quietly refused every photo and
  // every voice note sent without a caption — in every chat and every group
  // mode, since it runs before all of them. `hasContent` in envelope.ts had
  // always counted media as content and the dispatcher kept those messages on
  // that basis; the gate then discarded them two lines later. Somebody sending
  // a picture got silence, which is indistinguishable from being ignored.
  if (input.text.trim().length === 0 && !input.hasMedia) return deny(REFUSAL.nothingToAnswer);

  if (input.isGroup) {
    if (!config.groups.enabled) return deny(REFUSAL.groupsDisabled);

    // This room's own setting if it has one, the global one otherwise. Read
    // here rather than passed in, so every caller of the gate gets the override
    // without having to remember it exists.
    const mode = groupModeFor(config, input.chatKey);

    // Everything reaches the agent, which then decides whether to speak. See
    // the note on `replyTo` in config.ts for what this costs.
    //
    // On Teams "everything" is only what the platform delivers. A bot in a
    // channel or group chat receives nothing but the posts that @-mention it,
    // unless the app's manifest carries the resource-specific consent
    // permission `ChannelMessage.Read.Group` (and `ChatMessage.Read.Chat` for
    // group chats) and an administrator has granted it — see docs/TEAMS.md.
    // Without that grant this mode behaves exactly like `mention`, and there
    // is nothing the bridge can do about it from here: the gate decides what
    // to answer, not what arrives. `mentionsMe` is right either way, since the
    // Teams parser reads it from the mention entities rather than assuming.
    if (mode === 'observe') return ACCEPT;

    // A real @mention or a reply to us is unambiguous consent to be addressed,
    // and satisfies either remaining mode.
    if (input.mentionsMe) return ACCEPT;
    if (mode === 'mention') return deny(REFUSAL.notMentioned);

    const haystack = input.text.toLowerCase();
    const triggered = config.groups.triggers.some((t) => haystack.includes(t.toLowerCase()));
    return triggered ? ACCEPT : deny(REFUSAL.noTrigger);
  }

  // A direct message. This is the branch that is open to the world.
  if (config.audience.everyone) return ACCEPT;
  if (matchesList(config.audience, input.senderIds)) return ACCEPT;
  return deny(REFUSAL.notOnList);
}
