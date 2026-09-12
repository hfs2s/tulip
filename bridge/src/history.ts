/**
 * Reading a conversation back, for the agent rather than for the panel.
 *
 * `panel-api.ts` already has `chatHistory`, and this is deliberately not it.
 * That one answers an operator looking at a screen: it carries the chat record,
 * refusal reasons, media descriptors, everything the panel draws. This one
 * answers a machine that is about to put the result in front of a person, so it
 * carries the least that can still be useful — who spoke, when, and what they
 * said, truncated.
 *
 * The feed is the source because it is the record of what actually happened,
 * including messages the gate refused. Which of those an operator may read back
 * is the whole question here, and the answer is not "none" — it was, and that
 * was wrong in a way worth recording, because the symptom did not look like a
 * filtering bug.
 *
 * Every refused message used to be excluded, on the argument that it was never
 * part of the conversation and that surfacing it would hand the agent exactly
 * the traffic the gate exists to keep out. Half of that is still right. The half
 * that was wrong: a message refused because it did not *address* the agent was
 * still something a room genuinely said, and hiding it from an operator's own
 * recall meant a room that had been busy all afternoon read back as empty. The
 * agent, reasonably, called it a quiet room and then a broken pipe, and said so
 * to the operator with confidence — because nothing in an empty result can
 * distinguish "nobody spoke" from "everything they said was filtered out here".
 *
 * So the split is by *reason*, and it is an allowlist rather than a denylist:
 *
 *   - **Refused for not addressing us** — groups switched off, no trigger word,
 *     no mention, a reaction, a poll vote. The room was talking; we were simply
 *     not being spoken to. An operator may read these.
 *   - **Everything else** — a blocked sender, somebody off the allow list, a
 *     rate-limited flood, and any reason added later. Still excluded, which is
 *     the original argument doing the job it was actually written for.
 *
 * An allowlist because the safe default is to hide: a refusal reason introduced
 * tomorrow stays invisible until somebody decides otherwise, rather than
 * appearing in an operator's recall because nobody remembered this file.
 *
 * Refused messages carry *why*, and that must not be dropped downstream. An
 * agent that cannot tell a delivered message from a refused one would quote
 * something nobody answered back into a room as though it had been part of the
 * conversation.
 */
import { feed, type FeedEntry } from './feed.js';
import { REFUSAL } from './gate.js';

/**
 * Refusals that mean "not addressed to us" rather than "not welcome here".
 *
 * Built from the gate's own constants so a reworded refusal is a type error
 * rather than a message that quietly stops being readable.
 */
const NOT_ADDRESSED: ReadonlySet<string> = new Set([
  REFUSAL.groupsDisabled,
  REFUSAL.notMentioned,
  REFUSAL.noTrigger,
  REFUSAL.reaction,
  REFUSAL.pollVote,
]);

export interface RecalledMessage {
  /** A display name, never a number: this text reaches a person. */
  readonly from: string;
  readonly at: string;
  readonly text: string;
  /**
   * Null when this message was delivered to the agent at the time. Otherwise
   * the gate's own reason, so the agent can say "nobody answered this" instead
   * of treating it as something it heard and chose to ignore.
   */
  readonly refused: string | null;
}

/** How far back the feed is scanned. Bounded so one call cannot walk the log. */
const SCAN = 4000;

/**
 * The rows of a chat worth reading back: our own outbound, plus inbound that
 * was either delivered or refused only for not addressing us. `delivered`,
 * `event`, `edited` and `unsent` rows are bookkeeping rather than anything a
 * person said. One selection for recall and for a triggered turn's context, so
 * the two cannot drift apart on what counts as the room talking.
 */
function spoken(chatKey: string): FeedEntry[] {
  return feed
    .recent(SCAN)
    .filter((e) => e.chatKey === chatKey)
    .filter((e) => {
      if (e.kind === 'out') return true;
      if (e.kind !== 'in') return false;
      if (e.accepted === true) return true;
      return NOT_ADDRESSED.has(e.reason ?? '');
    })
    .filter((e) => typeof e.text === 'string' && e.text.trim().length > 0);
}

function recalled(e: FeedEntry): RecalledMessage {
  return {
    from: e.kind === 'out' ? 'you' : (e.from ?? 'someone'),
    at: new Date(e.ts).toISOString(),
    text: (e.text ?? '').trim(),
    refused: e.kind === 'in' && e.accepted !== true ? (e.reason ?? 'refused at the gate') : null,
  };
}

export function recentMessages(chatKey: string, limit: number): RecalledMessage[] {
  return spoken(chatKey).slice(-limit).map(recalled);
}

/**
 * What a room said before the turn it just woke, for that turn's batch.
 *
 * In `mention` and `trigger` rooms the gate hands over only the line that
 * addressed Juan. Without this he answers "what do you think of this?" having
 * never seen "this" — the link was posted a minute earlier, refused for not
 * naming him, and so never reached him at all.
 *
 * The messages being answered are left out by WhatsApp id rather than by time
 * or text: a debounced batch spans several seconds, and a repeated sentence is
 * not the one being answered. Their ids stay here, on the trusted side; only
 * the words reach the agent.
 */
export function roomContext(chatKey: string, answering: ReadonlySet<string>, limit: number): RecalledMessage[] {
  return spoken(chatKey)
    .filter((e) => !(e.kind === 'in' && typeof e.waId === 'string' && answering.has(e.waId)))
    .slice(-limit)
    .map(recalled);
}

/**
 * The last thing a person actually said in this chat, as the bridge recorded it.
 *
 * Used to stamp a reminder with the request that caused it, and it reads the
 * bridge's own feed rather than taking the agent's word for it — deliberately.
 * The point of showing the original message is to prove a human asked; evidence
 * supplied by the party being checked proves nothing. A compromised agent can
 * ask for a reminder, but it cannot invent the sentence that appears beneath it
 * or the name attached to that sentence.
 *
 * Outbound is excluded: the agent's own reply is not a request. Null when the
 * chat has nothing inbound in the scanned window, and the card then says only
 * what it can stand behind.
 *
 * Refused messages are excluded here and must stay excluded, which is the one
 * place that rule did *not* loosen when recall's did. `recentMessages` may show
 * an operator what a room said without answering; this function is evidence
 * that a person asked for something. A message the gate refused is precisely
 * not that, and letting one stamp a reminder would make an unanswered line in a
 * group look like a request somebody made.
 */
export function lastInbound(chatKey: string): RecalledMessage | null {
  const said = feed
    .recent(SCAN)
    .filter((e) => e.chatKey === chatKey && e.kind === 'in' && e.accepted === true)
    .filter((e) => typeof e.text === 'string' && e.text.trim().length > 0);
  const latest = said[said.length - 1];
  if (latest === undefined) return null;
  return {
    from: latest.from ?? 'someone',
    at: new Date(latest.ts).toISOString(),
    text: (latest.text ?? '').trim(),
    // Always null: the filter above accepts nothing else.
    refused: null,
  };
}
