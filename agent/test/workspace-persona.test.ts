/**
 * Which persona a brief is built from.
 *
 * The case worth the most care is the unhappy one. An operator's persona that
 * cannot be read must never be replaced by the generic starter, because that
 * puts the wrong character in front of people mid-conversation — and "I could
 * not read it" and "there is nothing" look the same unless kept apart.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-ws-persona-'));
const starter = join(root, 'starter');
process.env['TULIP_WORKSPACE'] = join(root, 'ws');
process.env['TULIP_PERSONA'] = starter;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { ensureWorkspace, publishedPersona, workspaceFor } = await import('../src/workspace.js');
const { composePersona, inPaths, personaVersion } = await import('@2lp/shared');

const CHAT = 'main';

function publish(identity: string): string {
  const parts = [
    { name: 'IDENTITY.md' as const, text: identity, source: 'saved' as const },
    { name: 'BOUNDARIES.md' as const, text: '# Boundaries', source: 'starter' as const },
  ];
  const version = personaVersion(composePersona(parts));
  writeFileSync(inPaths.persona, JSON.stringify({ version, at: new Date().toISOString(), parts }));
  return version;
}

const brief = (): string => readFileSync(workspaceFor(CHAT).claudeMd, 'utf8');

beforeEach(() => {
  rmSync(join(root, 'ws'), { recursive: true, force: true });
  rmSync(inPaths.persona, { force: true });
  mkdirSync(inPaths.root, { recursive: true });
  mkdirSync(starter, { recursive: true });
  writeFileSync(join(starter, 'IDENTITY.md'), '# The starter');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('building a brief', () => {
  it('uses the starter when nothing has ever been published', () => {
    expect(publishedPersona()).toBeNull();
    expect(ensureWorkspace(CHAT).personaVersion).toBeNull();
    expect(brief()).toContain('# The starter');
  });

  it('uses what the bridge published, and records its version', () => {
    const version = publish('# Juan');
    expect(ensureWorkspace(CHAT).personaVersion).toBe(version);
    expect(brief()).toContain('# Juan');
    expect(brief()).not.toContain('# The starter');
  });

  it('keeps the brief it has when the published persona is unreadable', () => {
    publish('# Juan');
    ensureWorkspace(CHAT);
    writeFileSync(inPaths.persona, '{"version": "not json');
    expect(publishedPersona()).toBeUndefined();
    expect(ensureWorkspace(CHAT).personaVersion).toBeNull();
    expect(brief()).toContain('# Juan');
  });

  it('treats a published file that fails the schema as unreadable, not as empty', () => {
    writeFileSync(inPaths.persona, JSON.stringify({ version: 'x', at: 'now', parts: [] }));
    expect(publishedPersona()).toBeUndefined();
  });

  it('says where the persona is edited', () => {
    ensureWorkspace(CHAT);
    expect(brief()).toContain("panel's Persona page");
  });
});
