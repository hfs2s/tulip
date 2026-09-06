/**
 * The catalogue and the dispatcher must agree.
 *
 * This is the whole point of the file it tests. `tulip-wa`'s usage text was
 * hand-written beside the dispatcher and had silently fallen two verbs behind
 * it — `read` and `history` were real, reachable commands that the CLI's own
 * help did not mention. An agent that asks what it can do and is told less than
 * the truth declines things it could have done, which is the failure this
 * project keeps rediscovering.
 *
 * So the test reads the dispatcher itself rather than a copy of it. Adding a
 * `case` without adding a catalogue entry fails here, in the suite, rather than
 * months later in a conversation where Juan says he cannot do something.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CROSS_CHAT_VERBS, VERB_GROUPS, VERBS, usageText } from '../src/verbs.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = readFileSync(join(here, '..', '..', 'agent', 'src', 'wa-cli.ts'), 'utf8');

/** Every `case '<verb>':` in the dispatcher's switch. */
function dispatchedVerbs(): string[] {
  return [...cli.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => m[1] as string).sort();
}

describe('the catalogue matches the dispatcher', () => {
  it('documents every verb that can actually be run', () => {
    const documented = VERBS.map((v) => v.name).sort();
    const undocumented = dispatchedVerbs().filter((v) => !documented.includes(v));
    expect(undocumented, `dispatched but absent from the catalogue: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('invents no verb that cannot be run', () => {
    const dispatched = dispatchedVerbs();
    const invented = VERBS.map((v) => v.name).filter((v) => !dispatched.includes(v));
    expect(invented, `in the catalogue but not dispatched: ${invented.join(', ')}`).toEqual([]);
  });

  it('names each verb once', () => {
    const names = VERBS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the catalogue is usable as a reference', () => {
  it('gives every verb a group that is actually listed', () => {
    const groups = VERB_GROUPS.map(([g]) => g);
    for (const v of VERBS) expect(groups, v.name).toContain(v.group);
  });

  it('gives every verb a summary and a detail', () => {
    for (const v of VERBS) {
      expect(v.summary.length, v.name).toBeGreaterThan(0);
      expect(v.detail.length, v.name).toBeGreaterThan(0);
      // A summary that runs on is a paragraph in a table cell.
      expect(v.summary.length, v.name).toBeLessThan(70);
    }
  });

  it('only claims cross-chat for verbs that exist', () => {
    const names = VERBS.map((v) => v.name);
    for (const v of CROSS_CHAT_VERBS) expect(names).toContain(v);
  });
});

describe('usageText', () => {
  it('mentions every verb, which is the bug it exists to prevent', () => {
    const text = usageText();
    for (const v of VERBS) expect(text, v.name).toContain(`tulip-wa ${v.name}`);
  });

  it('still says how a reply is addressed', () => {
    expect(usageText()).toContain('--to <key>');
  });
});
