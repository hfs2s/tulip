/**
 * How readily the agent speaks up in a group, in Judgement mode.
 *
 * Judgement hands every group message to the agent and lets it decide whether
 * to answer. That decision was carried entirely by the persona — "stay silent
 * for everything else, which is most things" — which is a single fixed opinion
 * about a thing that is not fixed at all: the right amount for a working group
 * of three is not the right amount for a family chat of thirty.
 *
 * So it becomes a dial, and the dial has to be explainable. Each level carries
 * the sentence an operator reads in the panel AND the sentence the agent is
 * given at the top of a group turn. They are deliberately the same text: if the
 * two ever say different things, the operator is tuning something other than
 * what they were shown.
 *
 * The levels are behaviour, not probability. "Answer one message in four" is
 * not something a model can honour and not something an operator can picture;
 * "only when you know something nobody else in the room does" is both.
 */

export interface ReactivityLevel {
  readonly value: number;
  /** One or two words, for the slider's own label. */
  readonly name: string;
  /** What an operator is told this number means. */
  readonly description: string;
  /** What the agent is told, at the top of a group turn. Second person. */
  readonly instruction: string;
}

export const REACTIVITY: readonly ReactivityLevel[] = [
  {
    value: 0,
    name: 'Silent',
    description:
      'Never speaks first. Answers only a real @-mention or a reply to one of its own messages, exactly as Mentions mode would — but it still reads everything, and still costs a turn per message.',
    instruction:
      'Say nothing in this group unless this message is a direct @-mention of you or a reply to something you said. For anything else, run `tulip-wa quiet`.',
  },
  {
    value: 1,
    name: 'Rare',
    description:
      'Speaks only when it knows something nobody else in the room does — an answer to a question that has gone unanswered, a correction to something factually wrong. Otherwise silent, including when the conversation is about it.',
    instruction:
      'Speak only if you know something nobody else here does: an unanswered question you can actually answer, or a plain factual error worth correcting. If in doubt, run `tulip-wa quiet`.',
  },
  {
    value: 2,
    name: 'Considered',
    description:
      'The default, and the one the persona was written for. Joins when it can be useful and stays out of ordinary conversation between other people. Silent most of the time.',
    instruction:
      'Join in when you can be useful, and stay out of ordinary conversation between other people. Silence is the normal answer — run `tulip-wa quiet` when you have nothing worth adding.',
  },
  {
    value: 3,
    name: 'Engaged',
    description:
      'Behaves like a member of the group rather than a service. Picks up threads, adds to what people are saying, reacts to things. Noticeably more present, and sends noticeably more messages.',
    instruction:
      'Behave like a member of this group rather than a service: pick things up, add to what people are saying, react when something deserves it. Still skip messages you would add nothing to.',
  },
  {
    value: 4,
    name: 'Chatty',
    description:
      'Answers nearly everything, small talk included. Expect it to be part of most exchanges. Worth choosing only for a small, willing group — in a busy room it will dominate, and it spends the outbound allowance quickly.',
    instruction:
      'Take part in nearly everything here, small talk included. Only stay quiet when a message plainly is not for you.',
  },
];

export const DEFAULT_REACTIVITY = 2;

export function reactivityLevel(value: number): ReactivityLevel {
  return REACTIVITY.find((l) => l.value === value) ?? (REACTIVITY[DEFAULT_REACTIVITY] as ReactivityLevel);
}

/**
 * The line handed to the agent at the top of a group turn.
 *
 * Prefixed with what it is, because the agent reads it beside a batch of
 * messages written by strangers and must not mistake one for the other.
 */
export function reactivityInstruction(value: number): string {
  return `Group tone, set by the operator (${reactivityLevel(value).name}): ${reactivityLevel(value).instruction}`;
}
