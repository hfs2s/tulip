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
 * including messages that were refused. Those are *excluded* here: a message
 * the gate turned away was never part of the conversation, and handing it to
 * the agent would let recall surface exactly the traffic the gate exists to
 * keep out.
 */
import { feed } from './feed.js';

export interface RecalledMessage {
  /** A display name, never a number: this text reaches a person. */
  readonly from: string;
  readonly at: string;
  readonly text: string;
}

/** How far back the feed is scanned. Bounded so one call cannot walk the log. */
const SCAN = 4000;

export function recentMessages(chatKey: string, limit: number): RecalledMessage[] {
  return feed
    .recent(SCAN)
    .filter((e) => e.chatKey === chatKey)
    // Accepted inbound and our own outbound. A refused message never reached
    // the conversation, so it is not part of its history.
    .filter((e) => (e.kind === 'in' && e.accepted === true) || e.kind === 'out')
    .filter((e) => typeof e.text === 'string' && e.text.trim().length > 0)
    .slice(-limit)
    .map((e) => ({
      from: e.kind === 'out' ? 'you' : (e.from ?? 'someone'),
      at: new Date(e.ts).toISOString(),
      text: (e.text ?? '').trim(),
    }));
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
  };
}
