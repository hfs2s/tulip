/**
 * Working from a picture, and the boundary that makes it safe to.
 *
 * The reference images are the reason this provider exists, and they are also
 * the risk: the agent names the files. So the two things tested are that a
 * reference resolves only inside the turn's *own* chat, and that the bytes
 * go to the provider inlined rather than as a link — those photos live on a
 * volume with no public address, and making a URL would mean publishing them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { referencePaths } from '../src/images.js';

const MINE = '1111111111111111';
const THEIRS = '2222222222222222';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

let roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.resetModules(); });

function store() {
  const root = mkdtempSync(join(tmpdir(), 'tulip-refs-'));
  roots.push(root);
  for (const chat of [MINE, THEIRS]) {
    mkdirSync(join(root, chat), { recursive: true });
    writeFileSync(join(root, chat, 'shot.jpg'), JPEG);
  }
  return root;
}

describe('which pictures the agent may work from', () => {
  it('takes one from this chat, named as the batch names it', () => {
    const root = store();
    const got = referencePaths(root, MINE, [`media/${MINE}/shot.jpg`]);
    expect(got.paths).toHaveLength(1);
    expect(got.paths[0]).toBe(join(root, MINE, 'shot.jpg'));
    expect(got.refused).toBe(0);
  });

  /** The one that matters: a photo from somebody else's conversation. */
  it('refuses another chat’s photo, however it is spelled', () => {
    const root = store();
    const got = referencePaths(root, MINE, [
      `media/${THEIRS}/shot.jpg`,
      `../${THEIRS}/shot.jpg`,
      `/etc/passwd`,
      `media/${MINE}/../${THEIRS}/shot.jpg`,
    ]);
    expect(got.paths).toEqual([]);
    expect(got.refused).toBe(4);
  });

  it('refuses a file that is not there', () => {
    const root = store();
    expect(referencePaths(root, MINE, [`media/${MINE}/missing.jpg`]).refused).toBe(1);
  });

  it('keeps the good ones when only some are refused', () => {
    const root = store();
    const got = referencePaths(root, MINE, [`media/${MINE}/shot.jpg`, `media/${THEIRS}/shot.jpg`]);
    expect(got.paths).toHaveLength(1);
    expect(got.refused).toBe(1);
  });
});

describe('what reaches the provider', () => {
  it('inlines the bytes and never a link, and says which model', async () => {
    const root = store();
    vi.stubEnv('APIMART_API_KEY', 'sk-test');
    vi.resetModules();
    const { generateImage } = await import('../src/apimart.js');

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/images/generations')) {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return { ok: true, json: async () => ({ data: [{ task_id: 'task_1' }] }) } as never;
      }
      if (String(url).includes('/v1/tasks/')) {
        return {
          ok: true,
          json: async () => ({ data: { status: 'completed', result: { images: [{ url: 'https://example/p.png' }] } } }),
        } as never;
      }
      return { ok: true, arrayBuffer: async () => JPEG.buffer } as never;
    });

    const out = await generateImage('a poster of this', referencePaths(root, MINE, [`media/${MINE}/shot.jpg`]).paths);
    expect(out.ok).toBe(true);

    const sent = calls[0]?.body ?? {};
    expect(sent['model']).toBe('gpt-image-2');
    const refs = sent['image_urls'] as string[];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(refs[0]).not.toMatch(/^https?:/);
  });

  it('says so plainly when no key is configured', async () => {
    vi.stubEnv('APIMART_API_KEY', '');
    vi.resetModules();
    const { generateImage, configured } = await import('../src/apimart.js');
    expect(configured()).toBe(false);
    expect(await generateImage('anything')).toEqual({ ok: false, error: 'no APIMART_API_KEY is configured' });
  });
})
