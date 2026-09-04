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
  if (input.isReaction) return deny('reaction — recorded, not answered');
  if (input.isPollVote) return deny('poll vote — recorded, not answered');

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
  if (input.text.trim().length === 0 && !input.hasMedia) return deny('nothing to answer');

  if (input.isGroup) {
    if (!config.groups.enabled) return deny('groups are disabled');

    // Everything reaches the agent, which then decides whether to speak. See
    // the note on `replyTo` in config.ts for what this costs.
    if (config.groups.replyTo === 'observe') return ACCEPT;

    // A real @mention or a reply to us is unambiguous consent to be addressed,
    // and satisfies either remaining mode.
    if (input.mentionsMe) return ACCEPT;
    if (config.groups.replyTo === 'mention') return deny('not mentioned in group');

    const haystack = input.text.toLowerCase();
    const triggered = config.groups.triggers.some((t) => haystack.includes(t.toLowerCase()));
    return triggered ? ACCEPT : deny('no trigger word in group');
  }

  // A direct message. This is the branch that is open to the world.
  if (config.audience.everyone) return ACCEPT;
  if (matchesList(config.audience, input.senderIds)) return ACCEPT;
  return deny('sender is not on the allow list');
}
