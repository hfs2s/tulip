/**
 * The dial, and the sentences that explain it.
 *
 * The operator is shown a number and a description; the agent is given an
 * instruction. If those two ever describe different behaviour, the operator is
 * tuning something other than what they were shown — which is worse than having
 * no dial, because it looks like it worked.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_REACTIVITY, REACTIVITY, reactivityInstruction, reactivityLevel } from '../src/reactivity.js';

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
