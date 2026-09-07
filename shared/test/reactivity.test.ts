/**
 * The dial, and the sentences that explain it.
 *
 * The operator is shown a number and a description; the agent is given an
 * instruction. If those two ever describe different behaviour, the operator is
 * tuning something other than what they were shown — which is worse than having
 * no dial, because it looks like it worked.
 */
import { describe, expect, it } from 'vitest';
import { ALWAYS_ANSWER, DEFAULT_REACTIVITY, REACTIVITY, reactivityInstruction, reactivityLevel } from '../src/reactivity.js';

describe('the levels', () => {
  it('runs 0 to 4 with no gaps, because the slider indexes straight into it', () => {
    expect(REACTIVITY.map((l) => l.value)).toEqual([0, 1, 2, 3, 4]);
  });

  it('gives every level a name, a description and an instruction', () => {
    for (const level of REACTIVITY) {
      expect(level.name.length, String(level.value)).toBeGreaterThan(0);
      expect(level.description.length, String(level.value)).toBeGreaterThan(40);
      expect(level.instruction.length, String(level.value)).toBeGreaterThan(40);
    }
  });

  it('says something different at every level', () => {
    // A dial whose ends read the same is a dial that does nothing.
    expect(new Set(REACTIVITY.map((l) => l.instruction)).size).toBe(REACTIVITY.length);
    expect(new Set(REACTIVITY.map((l) => l.description)).size).toBe(REACTIVITY.length);
  });

  it('tells the agent how to be silent everywhere it should be', () => {
    // Silence has to be an action it knows how to take, not an absence.
    for (const level of REACTIVITY.slice(0, 3)) {
      expect(level.instruction, String(level.value)).toContain('quiet');
    }
  });

  it('defaults to the level the persona was written for', () => {
    expect(DEFAULT_REACTIVITY).toBe(2);
    expect(reactivityLevel(DEFAULT_REACTIVITY).name).toBe('Considered');
  });
});

describe('reactivityLevel', () => {
  it('falls back to the default rather than throwing on a value out of range', () => {
    // The number arrives from a config file a human may have edited.
    for (const bad of [-1, 5, 99, 1.5, Number.NaN]) {
      expect(reactivityLevel(bad).value, String(bad)).toBe(DEFAULT_REACTIVITY);
    }
  });
});

describe('reactivityInstruction', () => {
  it('says who set it, so the agent does not read it as a message', () => {
    // It arrives at the top of a turn, beside a batch written by strangers.
    const line = reactivityInstruction(4);
    expect(line).toContain('set by the operator');
    expect(line).toContain('Chatty');
  });

  it('carries each level’s own instruction unchanged', () => {
    for (const level of REACTIVITY) {
      expect(reactivityInstruction(level.value)).toContain(level.instruction);
    }
  });
});

/**
 * Being addressed is not a judgement call.
 *
 * The dial governs whether to speak when nobody asked. It shipped governing
 * both, and the agent went quiet on direct @-mentions in two groups within the
 * hour — because "silence is the normal answer" was the first thing it read on
 * every group turn, with no carve-out.
 */
describe('a direct mention is answered at every level', () => {
  it('carries the rule on every level, including the quietest', () => {
    for (const level of REACTIVITY) {
      const line = reactivityInstruction(level.value);
      expect(line, `level ${String(level.value)}`).toContain('@-mention');
      expect(line, `level ${String(level.value)}`).toContain(ALWAYS_ANSWER);
    }
  });

  it('states it before the tone, so it is not read as an exception to it', () => {
    for (const level of REACTIVITY) {
      const line = reactivityInstruction(level.value);
      expect(line.indexOf(ALWAYS_ANSWER), `level ${String(level.value)}`)
        .toBeLessThan(line.indexOf('Group tone'));
    }
  });

  it('never tells the agent that silence is simply the normal answer', () => {
    // The exact phrasing that suppressed the mentions. A level may still ask
    // for restraint, but not as an unqualified default.
    for (const level of REACTIVITY) {
      expect(level.instruction.toLowerCase(), `level ${String(level.value)}`)
        .not.toContain('silence is the normal answer');
    }
  });
});
