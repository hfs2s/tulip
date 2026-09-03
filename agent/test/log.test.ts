import { describe, expect, it } from 'vitest';
import { redact } from '../src/log.js';

/**
 * These exist because of a real leak, not a hypothetical one. During bring-up
 * the supervisor logged a slice of the terminal to explain a failed spawn, and
 * the terminal happened to be showing Claude Code's "Detected a custom API key
 * in your environment" prompt — which prints most of the key.
 */
describe('redact', () => {
  it('masks the elided form Claude Code prints on screen', () => {
    const pane = 'ANTHROPIC_API_KEY: sk-ant-...Nlpskg-bcYwEQAA\n  Do you want to use this API key?';
    const out = String(redact(pane));
    expect(out).not.toContain('Nlpskg-bcYwEQAA');
    expect(out).toContain('«redacted»');
    // The surrounding diagnostic must survive — that is the point of the line.
    expect(out).toContain('Do you want to use this API key?');
  });

  it('masks a whole Anthropic key', () => {
    const out = String(redact('key is sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF trailing'));
    expect(out).not.toMatch(/AAAABBBBCCCC/);
    expect(out).toContain('trailing');
  });

  it.each([
    ['an OpenAI-style key', 'sk-ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['a GitHub token', 'ghp_ABCDEFGHIJKLMNOPQRST'],
    ['a bearer header', 'Authorization: Bearer abcdef.ghijkl.mnopqr'],
  ])('masks %s', (_label, secret) => {
    expect(String(redact(`prefix ${secret} suffix`))).not.toContain(secret.split(/\s+/).pop());
  });

  it('leaves ordinary text alone', () => {
    const line = 'session.spawned chatKey=00112233445566aa live=1';
    expect(redact(line)).toBe(line);
  });

  it('passes non-strings through unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
  });
});
