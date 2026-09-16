/**
 * How much the agent says when it does speak.
 *
 * The sibling of reactivity.ts, and the distinction is worth keeping sharp:
 * that dial decides *whether* to speak, this one decides *how much*. They fail
 * in opposite directions — a quiet agent that writes five paragraphs when it
 * finally does is not the same problem as one that answers everything in four
 * words — and an operator tuning one should not be moving the other.
 *
 * Same discipline as the levels there. Each carries the sentence the operator
 * reads in the panel and the sentence the agent is given at the top of the
 * turn, and they are the same text: if the two ever diverge, the operator is
 * tuning something other than what they were shown.
 *
 * And the levels are behaviour, not word counts. "Two sentences" is a rule a
 * model will break the moment the answer needs three and then feel it has
 * failed; "answer, then stop — no preamble, no summary of what you just did"
 * is a shape it can actually hold.
 */

export interface VerbosityLevel {
  readonly value: number;
  /** One or two words, for the control's own label. */
  readonly name: string;
  /** What an operator is told this number means. */
  readonly description: string;
  /** What the agent is told, at the top of a turn. Second person. */
  readonly instruction: string;
}

export const VERBOSITY: readonly VerbosityLevel[] = [
  {
    value: 0,
    name: 'Terse',
    description:
      'The shortest true answer and nothing else. A number, a yes, a name. Worth choosing for a working group that wants facts fast — and expect it to read as curt with anyone who does not.',
    instruction:
      'Answer in the fewest words that are still true — a number, a yes, a name. No preamble, no sign-off, no offer of further help. Stop as soon as the answer is given.',
  },
  {
    value: 1,
    name: 'Brief',
    description:
      'A sentence or two. Answers the question asked without expanding on it, and leaves out the reasoning unless somebody asks for it.',
    instruction:
      'Keep it to a sentence or two: the answer, without the reasoning behind it and without expanding on what was not asked. If the reasoning matters, offer it in a clause rather than a paragraph.',
  },
  {
    value: 2,
    name: 'Natural',
    description:
      'The default, and what the persona was written for. As long as the answer needs and no longer — a line for a simple question, a short paragraph for a real one.',
    instruction:
      'Say as much as the answer needs and no more: a line for a simple question, a short paragraph for a real one. Length should follow the question, not the other way round.',
  },
  {
    value: 3,
    name: 'Full',
    description:
      'Explains as it goes — what it did, what it found, what it would do next. Useful when you are working alongside it and want its reasoning visible; heavy in a room where people just want the answer.',
    instruction:
      'Show your working: what you did, what you found and what you would do next, in the order it happened. Still stop when it is said — thoroughness is not the same as repeating yourself.',
  },
];

export const DEFAULT_VERBOSITY = 2;

export function verbosityLevel(value: number): VerbosityLevel {
  return VERBOSITY.find((l) => l.value === value) ?? (VERBOSITY[DEFAULT_VERBOSITY] as VerbosityLevel);
}

/** What the agent is told, at the top of a turn. */
export function verbosityInstruction(value: number): string {
  return verbosityLevel(value).instruction;
}
