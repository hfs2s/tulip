/**
 * The persona as a setting.
 *
 * What these guard is the promise the panel makes: a save is what the agent
 * gets, a revert gets the starter back, nothing an operator saves is lost
 * without a copy, and the name of a part can never become a path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-persona-'));
const store = join(root, 'store');
const starter = join(root, 'starter');
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');
process.env['TULIP_PERSONA_STORE'] = store;
process.env['TULIP_PERSONA_DOCS'] = starter;

const { personaView, publishPersona, readPersona, revertPersonaPart, savePersonaPart } = await import('../src/persona.js');
const { PART_MAX_CHARS, PersonaFile, composePersona, inPaths, personaVersion } = await import('@2lp/shared');

const STARTER = {
  'IDENTITY.md': '# Starter identity',
  'VOICE.md': '# Starter voice',
  'OPERATING.md': '# Starter operating',
  'BOUNDARIES.md': '# Starter boundaries',
};

function published() {
  return PersonaFile.parse(JSON.parse(readFileSync(inPaths.persona, 'utf8')));
}

beforeEach(() => {
  rmSync(store, { recursive: true, force: true });
  rmSync(inPaths.persona, { force: true });
  mkdirSync(starter, { recursive: true });
  mkdirSync(inPaths.root, { recursive: true });
  for (const [name, text] of Object.entries(STARTER)) writeFileSync(join(starter, name), text);
});
afterEach(() => vi.useRealTimers());
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the starter', () => {
  it('is what every part says until something is saved', () => {
    expect(readPersona().map((p) => p.source)).toEqual(['starter', 'starter', 'starter', 'starter']);
  });

  it('is published in order, with a version the agent can compare', () => {
    const version = publishPersona();
    const file = published();
    expect(file.parts.map((p) => p.name)).toEqual(['IDENTITY.md', 'VOICE.md', 'OPERATING.md', 'BOUNDARIES.md']);
    expect(file.version).toBe(version);
    expect(version).toBe(personaVersion(composePersona(file.parts)));
  });
});

describe('saving', () => {
  it('reaches the published copy and changes the version', () => {
    const before = publishPersona();
    const saved = savePersonaPart('IDENTITY.md', '# Juan');
    expect(saved).toMatchObject({ ok: true });
    const file = published();
    expect(file.version).not.toBe(before);
    expect(file.parts[0]).toMatchObject({ name: 'IDENTITY.md', text: '# Juan', source: 'saved' });
    expect(file.parts[1]).toMatchObject({ source: 'starter' });
  });

  /** An unchanged persona must not restart a session that is mid-conversation. */
  it('changes nothing when the text is the same', () => {
    savePersonaPart('VOICE.md', 'plain');
    const first = published().version;
    savePersonaPart('VOICE.md', 'plain');
    expect(published().version).toBe(first);
    expect(existsSync(join(store, '.history'))).toBe(false);
  });

  it('lets a part be emptied, which leaves its section out', () => {
    savePersonaPart('VOICE.md', '');
    expect(composePersona(published().parts)).not.toContain('Starter voice');
  });

  it('keeps the previous text of every change, twenty per part', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 25; i += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 10, 12, 0, i)));
      savePersonaPart('IDENTITY.md', `version ${String(i)}`);
    }
    const kept = readdirSync(join(store, '.history')).filter((f) => f.startsWith('IDENTITY.'));
    expect(kept).toHaveLength(20);
    const newest = kept.sort().at(-1) as string;
    expect(readFileSync(join(store, '.history', newest), 'utf8')).toBe('version 23');
  });

  it.each(['../config.json', 'EVIL.md', 'identity.md', '.history/IDENTITY.md'])('refuses %s, which is not one of the four', (name) => {
    expect(savePersonaPart(name, 'x')).toMatchObject({ ok: false });
    expect(existsSync(store)).toBe(false);
  });

  it('refuses a runaway paste rather than keeping half of it', () => {
    const r = savePersonaPart('OPERATING.md', 'x'.repeat(PART_MAX_CHARS + 1));
    expect(r).toMatchObject({ ok: false });
    expect(readPersona()[2]?.source).toBe('starter');
  });

  /** Claude Code loads a long brief whole; what to cut is the operator's call, so this reports rather than refuses. */
  it('reports a brief over the limit without refusing it', () => {
    expect(savePersonaPart('IDENTITY.md', 'y'.repeat(41_000))).toMatchObject({ ok: true, overLimit: true });
    expect(personaView().briefChars).toBeGreaterThan(41_000);
  });
});

describe('reverting', () => {
  it('returns a part to the starter and keeps what it said', () => {
    savePersonaPart('BOUNDARIES.md', '# Ours');
    expect(revertPersonaPart('BOUNDARIES.md')).toMatchObject({ ok: true });
    expect(published().parts[3]).toMatchObject({ text: '# Starter boundaries', source: 'starter' });
    const history = readdirSync(join(store, '.history'));
    expect(history.some((f) => readFileSync(join(store, '.history', f), 'utf8') === '# Ours')).toBe(true);
  });

  it('takes a starter update for a part nobody saved', () => {
    writeFileSync(join(starter, 'OPERATING.md'), '# New tools');
    publishPersona();
    expect(published().parts[2]?.text).toBe('# New tools');
  });
});
