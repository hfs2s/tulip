import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { automaticFallbackTurn } from '../src/fallback.js';

const roots: string[] = [];

function markers(): string {
  const root = mkdtempSync(join(tmpdir(), 'tulip-fallback-'));
  roots.push(root);
  const dir = join(root, '.markers');
  mkdirSync(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('automatic fallback routing', () => {
  it('allows the direct-message turn explicitly marked by the supervisor', () => {
    const dir = markers();
    writeFileSync(join(dir, 'answering'), 'direct-turn');
    writeFileSync(join(dir, 'fallback'), 'direct-turn');
    expect(automaticFallbackTurn(dir)).toBe('direct-turn');
  });

  it('never relays terminal prose into a group turn', () => {
    const dir = markers();
    writeFileSync(join(dir, 'answering'), 'group-turn');
    expect(automaticFallbackTurn(dir)).toBeNull();
  });

  it('fails closed when a late hook and the current conversation disagree', () => {
    const dir = markers();
    writeFileSync(join(dir, 'answering'), 'old-turn');
    writeFileSync(join(dir, 'fallback'), 'new-turn');
    expect(automaticFallbackTurn(dir)).toBeNull();
  });
});
