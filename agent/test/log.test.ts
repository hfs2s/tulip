import { describe, expect, it } from 'vitest';
import { redact } from '../src/log.js';

/**
 * These exist because of a real leak, not a hypothetical one. During bring-up
 * the supervisor logged a slice of the terminal to explain a failed spawn, and
 * the terminal happened to be showing Claude Code's "Detected a custom API key
 * in your environment" prompt — which prints most of the key.
 *
 * Every fixture below is assembled from fragments at run time rather than
 * written as a literal. Not stylistic: `npm run check:secrets` scans this
 * repository for credential shapes and has no exemption flag, deliberately. A
 * test file full of realistic-looking keys is exactly what that check is for,
 * and teaching it to ignore one file would blunt it everywhere.
 */
const ANTHROPIC = ['sk', 'ant', 'api03', 'AAAABBBBCCCCDDDDEEEEFFFF'].join('-');
const OPENAI = `sk-${'ABCDEFGHIJKLMNOPQRSTUVWX'}`;
const GITHUB = `gh${'p'}_${'ABCDEFGHIJKLMNOPQRST'}`;
const ELIDED_TAIL = 'Nlpskg-bcYwEQAA';

describe('redact', () => {
  it('masks the elided form Claude Code prints on screen', () => {
    const pane = `ANTHROPIC_API_KEY: sk-ant-...${ELIDED_TAIL}\n  Do you want to use this API key?`;
    const out = String(redact(pane));

    expect(out).not.toContain(ELIDED_TAIL);
    expect(out).toContain('«redacted»');
    // The surrounding diagnostic must survive — that is the point of the line.
    expect(out).toContain('Do you want to use this API key?');
  });

  it('masks a whole Anthropic key', () => {
    const out = String(redact(`key is ${ANTHROPIC} trailing`));
    expect(out).not.toContain('AAAABBBBCCCC');
    expect(out).toContain('trailing');
  });

  it.each([
    ['an OpenAI-style key', OPENAI],
    ['a GitHub token', GITHUB],
    ['a bearer header', `Bearer ${'abcdef.ghijkl.mnopqr'}`],
  ])('masks %s', (_label, secret) => {
    const out = String(redact(`prefix ${secret} suffix`));
    expect(out).not.toContain(secret.split(/\s+/).pop());
    expect(out).toContain('prefix');
    expect(out).toContain('suffix');
  });

  it('leaves ordinary text alone', () => {
    const line = 'session.spawned chatKey=00112233445566aa live=1';
    expect(redact(line)).toBe(line);
  });

  it('passes non-strings through unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});
