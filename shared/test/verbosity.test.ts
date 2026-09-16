/**
 * The length dial.
 *
 * The property that matters is not the wording of any level — that will be
 * tuned — but that the panel and the agent are shown the *same* thing. An
 * operator who reads one sentence in the panel and whose agent is given a
 * different one is tuning something other than what they were shown, and would
 * have no way to discover it.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_VERBOSITY, VERBOSITY, verbosityInstruction, verbosityLevel } from '../src/verbosity.js';

describe('the levels', () => {
  it('runs 0 upwards with no gaps, so a slider maps straight onto it', () => {
    expect(VERBOSITY.map((l) => l.value)).toEqual([0, 1, 2, 3]);
  });

  it('gives every level a name, a description and an instruction', () => {
    for (const level of VERBOSITY) {
      expect(level.name.length, String(level.value)).toBeGreaterThan(0);
      expect(level.description.length, String(level.value)).toBeGreaterThan(40);
      expect(level.instruction.length, String(level.value)).toBeGreaterThan(40);
    }
  });

  it('says something different at every level', () => {
    expect(new Set(VERBOSITY.map((l) => l.instruction)).size).toBe(VERBOSITY.length);
    expect(new Set(VERBOSITY.map((l) => l.name)).size).toBe(VERBOSITY.length);
  });

  /** The agent is addressed, not described: "keep it short", never "it keeps it short". */
  it('addresses the agent in the second person', () => {
    for (const level of VERBOSITY) {
      expect(level.instruction, level.name).not.toMatch(/\b(it|the agent) (keeps|says|answers|explains)\b/i);
    }
  });

  it('defaults to the middle, which is what the persona was written for', () => {
    expect(DEFAULT_VERBOSITY).toBe(2);
    expect(verbosityLevel(DEFAULT_VERBOSITY).name).toBe('Natural');
  });

  it('falls back to the default rather than throwing on a value it does not know', () => {
    expect(verbosityLevel(99)).toBe(VERBOSITY[DEFAULT_VERBOSITY]);
    expect(verbosityLevel(-1)).toBe(VERBOSITY[DEFAULT_VERBOSITY]);
  });

  it('hands the agent the level’s own words, not a paraphrase', () => {
    for (const level of VERBOSITY) {
      expect(verbosityInstruction(level.value)).toBe(level.instruction);
    }
  });
});
