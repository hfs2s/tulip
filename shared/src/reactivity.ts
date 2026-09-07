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
      'Never speaks first. Answers a real @-mention or a reply to one of its own messages and nothing else, exactly as Mentions mode would — but it still reads everything, and still costs a turn per message.',
    instruction:
      'Beyond that, say nothing here. Run `tulip-wa quiet` for anything you were not directly addressed in.',
  },
  {
    value: 1,
    name: 'Rare',
    description:
      'Speaks only when it knows something nobody else in the room does — an answer to a question that has gone unanswered, a correction to something factually wrong. Otherwise silent, including when the conversation is about it.',
    instruction:
      'Otherwise speak only if you know something nobody else here does: an unanswered question you can actually answer, or a plain factual error worth correcting. If in doubt, run `tulip-wa quiet`.',
  },
  {
    value: 2,
    name: 'Considered',
    description:
      'The default, and the one the persona was written for. Joins when it can be useful and stays out of ordinary conversation between other people. Silent most of the time — but a direct @-mention is always answered, at every level.',
    instruction:
      'Otherwise join in when you can be useful, and stay out of ordinary conversation between other people. When nobody has addressed you and you have nothing worth adding, run `tulip-wa quiet`.',
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

/**
 * True at every level, and stated separately so no level can forget it.
 *
 * The dial governs whether to speak *unprompted*. Being @-mentioned is not
 * unprompted — somebody typed your name to get your attention — and neither is
 * a reply to something you said. Answering those is not a judgement call.
 *
 * This is not a hypothetical tidy-up. Levels 1 and 2 said "silence is the
 * normal answer" with no carve-out, and that line is the first thing the agent
 * reads on a group turn: it went quiet on direct mentions in two groups within
 * an hour of the dial shipping.
 */
export const ALWAYS_ANSWER =
  'Whatever the tone below says, always answer a direct @-mention of you and always answer a reply to '
  + 'something you said. Being addressed is not a judgement call — the tone is only about whether to '
  + 'speak when nobody asked you to.';

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
  const level = reactivityLevel(value);
  return `${ALWAYS_ANSWER} Group tone, set by the operator (${level.name}): ${level.instruction}`;
}
