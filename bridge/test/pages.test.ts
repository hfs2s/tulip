/**
 * Pages the agent builds, and what must never be served from them.
 *
 * These are public, agent-authored, and on the operator's own domain. The
 * happy path is the least interesting part: what matters is that the extension
 * allowlist holds, that a name cannot climb out of the directory, and that the
 * whole feature stays off until a hostname is configured — because the hostname
 * is what keeps agent JavaScript off the panel's origin.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-pages-'));
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { publishPage, listPages, deletePage, isPagesRequest, SLUG } = await import('../src/pages.js');
const { outPaths } = await import('@tulip/shared');

function build(slug: string, files: Record<string, string> = { 'index.html': '<h1>hi</h1>' }): void {
  const dir = outPaths.page(slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

beforeEach(() => {
  rmSync(outPaths.pages, { recursive: true, force: true });
  process.env['TULIP_PAGES_HOST'] = 'pages.example.com';
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('publishing', () => {
  it('hands back the address on the pages host, not the panel’s', () => {
    build('party-plan');
    expect(publishPage('party-plan')).toEqual({ ok: true, url: 'https://pages.example.com/party-plan/' });
  });

  it('refuses a page with no index, and says what to do about it', () => {
    build('nothing', { 'app.js': 'console.log(1)' });
    const result = publishPage('nothing');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('index.html');
  });

  it('refuses a directory that does not exist', () => {
    expect(publishPage('never-made').ok).toBe(false);
  });
});

describe('the whole feature is off without a hostname', () => {
  it('refuses to publish, because a page has nowhere safe to live', () => {
    // Without its own origin, agent-authored JavaScript would be same-origin
    // with the operator's session. Off is the correct behaviour, not a
    // degraded one.
    delete process.env['TULIP_PAGES_HOST'];
    build('party-plan');
    expect(publishPage('party-plan').ok).toBe(false);
  });

  it('routes nothing to pages, so the panel keeps every hostname', () => {
    delete process.env['TULIP_PAGES_HOST'];
    expect(isPagesRequest('pages.example.com')).toBe(false);
  });
});

describe('which hostname is a page', () => {
  it('matches the configured host and ignores its port', () => {
    expect(isPagesRequest('pages.example.com')).toBe(true);
    expect(isPagesRequest('pages.example.com:8791')).toBe(true);
    expect(isPagesRequest('PAGES.EXAMPLE.COM')).toBe(true);
  });

  it('does not match the panel, which is the entire point', () => {
    expect(isPagesRequest('tulip.example.com')).toBe(false);
    expect(isPagesRequest(undefined)).toBe(false);
    // A prefix match here would hand the panel's origin to a page.
    expect(isPagesRequest('evil-pages.example.com')).toBe(false);
  });
});

describe('slugs', () => {
  it('accepts ordinary names', () => {
    expect(SLUG.test('party-plan')).toBe(true);
  });

  it('refuses anything that could climb, shout or hide', () => {
    for (const bad of ['..', '../etc', 'Party', 'a', 'x'.repeat(49), 'has space', '.hidden', 'under_score']) {
      expect(SLUG.test(bad)).toBe(false);
    }
  });

  it('refuses to delete by a name that is not a slug', () => {
    build('keeper');
    expect(deletePage('../keeper')).toBe(false);
    expect(listPages().map((p) => p.slug)).toEqual(['keeper']);
  });
});

describe('listing', () => {
  it('reports what is there, newest first, and forgets what is deleted', () => {
    build('one');
    build('two', { 'index.html': '<h1>2</h1>', 'app.css': 'body{}' });
    expect(listPages().map((p) => p.slug).sort()).toEqual(['one', 'two']);
    expect(listPages().find((p) => p.slug === 'two')?.files).toBe(2);

    expect(deletePage('two')).toBe(true);
    expect(listPages().map((p) => p.slug)).toEqual(['one']);
  });

  it('ignores a directory whose name is not a slug', () => {
    mkdirSync(join(outPaths.pages, 'Not A Slug'), { recursive: true });
    writeFileSync(join(outPaths.pages, 'Not A Slug', 'index.html'), 'x');
    expect(listPages()).toEqual([]);
  });
});
