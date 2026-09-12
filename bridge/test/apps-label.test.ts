/**
 * Naming an app.
 *
 * The box names its own workspaces and mostly does not: twenty-two of the
 * thirty-two come back `(unnamed)`, and nothing the gate offers can rename one.
 * So the name is kept on this side — which makes two properties worth holding.
 *
 * It is **state, not config**. The agent can cause it to change, and config is
 * the channel that decides who may do what; a label decides nothing. A file
 * that failed to parse must therefore cost the names and nothing else.
 *
 * And it is **governed by the same grant as working on the app**, which is
 * tested where that is enforced, in apps-grant.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function store() {
  const root = mkdtempSync(join(tmpdir(), 'tulip-applabel-'));
  roots.push(root);
  vi.stubEnv('TULIP_STATE_DIR', root);
  vi.resetModules();
  const apps = await import('../src/apps.js');
  const { paths } = await import('../src/paths.js');
  return { ...apps, file: paths.appLabels };
}

describe('naming an app', () => {
  it('keeps the name, and who named it', async () => {
    const s = await store();
    expect(s.setLabel('28c21d3c', 'The shop', 'ffff0000ffff0000')).toEqual({ ok: true });
    expect(s.readLabels()['28c21d3c']).toMatchObject({ label: 'The shop', chatKey: 'ffff0000ffff0000' });
  });

  it('clears a name when given none', async () => {
    const s = await store();
    s.setLabel('28c21d3c', 'The shop', null);
    expect(s.setLabel('28c21d3c', '', null)).toEqual({ ok: true });
    expect(s.readLabels()['28c21d3c']).toBeUndefined();
  });

  it('tidies the whitespace a chat message arrives with', async () => {
    const s = await store();
    s.setLabel('28c21d3c', '  The   shop  ', null);
    expect(s.readLabels()['28c21d3c']?.label).toBe('The shop');
  });

  it('refuses anything that is not a workspace id', async () => {
    const s = await store();
    expect(s.setLabel('../../etc', 'x', null).ok).toBe(false);
    expect(s.setLabel('28C21D3C', 'x', null).ok).toBe(false);
    expect(s.setLabel('28c21d3', 'x', null).ok).toBe(false);
    expect(s.readLabels()).toEqual({});
  });

  it('refuses a name too long to be one', async () => {
    const s = await store();
    expect(s.setLabel('28c21d3c', 'x'.repeat(61), null).ok).toBe(false);
    expect(s.readLabels()['28c21d3c']).toBeUndefined();
  });

  it('costs the names and nothing else when the file is unreadable', async () => {
    const s = await store();
    s.setLabel('28c21d3c', 'The shop', null);
    writeFileSync(s.file, 'not json at all');
    expect(s.readLabels()).toEqual({});
    // And a write still repairs it, rather than inheriting the mess.
    expect(s.setLabel('28c21d3c', 'The shop', null)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(s.file, 'utf8'))['28c21d3c'].label).toBe('The shop');
  });

  it('drops a label whose shape is wrong rather than trusting it', async () => {
    const s = await store();
    writeFileSync(s.file, JSON.stringify({ '28c21d3c': { label: 42 } }));
    expect(s.readLabels()).toEqual({});
  });

  it('shows our name over the box’s, and the box’s over the bare id', async () => {
    const s = await store();
    const base = { id: '28c21d3c', state: 'ready', mine: true, handedOver: false, addresses: [] };
    expect(s.displayName({ ...base, name: 'OkayGets', label: 'The shop' })).toBe('The shop');
    expect(s.displayName({ ...base, name: 'OkayGets', label: null })).toBe('OkayGets');
    expect(s.displayName({ ...base, name: null, label: null })).toBe('28c21d3c');
  });
});
