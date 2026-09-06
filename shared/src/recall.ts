/**
 * Whether one conversation may be read from inside another.
 *
 * This is the narrowest hole in the wall the rest of the design builds, and it
 * is worth being blunt about that. Everywhere else, chat isolation is
 * *structural*: one Claude Code session per chat, so another person's messages
 * are not in the context window that answers this one and there is nothing to
 * leak rather than a rule against leaking it. Three separate places in this
 * codebase argue for that — `workspace.ts`, the `sent` action, and
 * `agent.crossChat`, which says in as many words that it "can carry the current
 * one outward, not fetch someone else's inward".
 *
 * Recall fetches inward. So the question is not "is this safe" — it is not,
 * inherently — but "who can ask, and from where", and the answer has to be
 * narrow enough that the residual risk is one an operator has chosen.
 *
 * Three conditions, all required:
 *
 *   - **The operator has switched it on.** Off by default, like every other
 *     capability, and visible in the panel. Nobody gets this by upgrading.
 *   - **The turn carries operator authority.** `fromOperator` is established at
 *     the trusted boundary from WhatsApp's own sender ids, which a sender
 *     cannot change by picking a display name. A stranger asking Tulip to
 *     recall a chat is refused however they phrase it.
 *   - **The asking chat is not a group.** `fromOperator` is now false in a
 *     group anyway — `carriesOperatorAuthority` refuses a room outright — so
 *     this condition is redundant, and deliberately kept. It was written when
 *     that was not true, it is the condition this capability most depends on,
 *     and a check that costs nothing is worth more than an assumption about
 *     another module's current behaviour. If the room rule is ever relaxed
 *     again, recall does not quietly relax with it.
 *
 * The residual risk that remains, stated rather than engineered away: an
 * operator's own direct chat can still be prompt-injected — by a message
 * somebody forwarded them, by a page they asked Tulip to read — and a
 * successful injection there can ask for any chat by key. What bounds it is
 * that keys are opaque, every recall is written to the feed, and the capability
 * is off unless somebody turned it on.
 */

export interface RecallRequest {
  /** Has the operator switched recall on at all? */
  readonly enabled: boolean;
  /** Did this turn come from an operator, per WhatsApp's sender ids? */
  readonly fromOperator: boolean;
  /** Is the chat *asking* a group? Not the chat being read. */
  readonly askedInGroup: boolean;
}

export type RecallVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: RecallVerdict = { allowed: true };

/**
 * Order matters, and it is the reverse of how it reads.
 *
 * The capability check comes first so that a stranger who asks is told the same
 * thing whether or not the feature exists — "switched off" leaks nothing about
 * who they are, where "you are not an operator" confirms that recall is
 * available to somebody, which is a fact worth not handing out.
 */
export function canRecall(request: RecallRequest): RecallVerdict {
  if (!request.enabled) {
    return {
      allowed: false,
      reason:
        'Reading another conversation is switched off. An operator can turn it on in the panel; ' +
        'until then, say what you remember rather than what you were told.',
    };
  }
  if (!request.fromOperator) {
    return {
      allowed: false,
      reason:
        'Only an operator can ask you to read another conversation, and only by writing to you ' +
        'directly. Say that you do not discuss other chats.',
    };
  }
  if (request.askedInGroup) {
    return {
      allowed: false,
      reason:
        'Not in a group. The answer would be somebody else\'s private messages, read out to ' +
        'everybody in this room. Ask me in a direct message instead.',
    };
  }
  return ALLOWED;
}
