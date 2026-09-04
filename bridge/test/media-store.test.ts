/**
 * Copies of what the agent sent.
 *
 * Two properties carry the whole design, and both are testable. The store must
 * be **bounded** — this runs on a Pi with one disk and nothing here is
 * load-bearing — and it must live where the **agent cannot read it**, which is
 * the difference between an audit trail and a memory the agent can be talked
 * into consulting.
 */
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = join(tmpdir(), `tulip-mediaout-${String(Date.now())}`);
mkdirSync(root, { recursive: true });
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { retainOutbound } = await import('../src/mediaStore.js');
const { paths } = await import('../src/paths.js');
const { inPaths } = await import('@tulip/shared');

const KEY = 'a'.repeat(16);
const files = (): string[] => {
  try {
    return readdirSync(join(paths.mediaOut, KEY));
  } catch {
    return [];
  }
};

beforeEach(() => { rmSync(paths.mediaOut, { recursive: true, force: true }); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('keeping a copy', () => {
  it('writes what was sent, named by kind', () => {
    retainOutbound(KEY, 'image', Buffer.from('a picture'));
    const written = files();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/-image\.jpg$/);
  });

  it('keeps both when two sends land in the same millisecond', () => {
    retainOutbound(KEY, 'voice', Buffer.from('one'));
    retainOutbound(KEY, 'voice', Buffer.from('two'));
    expect(files()).toHaveLength(2);
  });

  it('takes the extension from the mimetype for an arbitrary file', () => {
    retainOutbound(KEY, 'file', Buffer.from('%PDF-'), 'application/pdf');
    expect(files()[0]).toMatch(/-file\.pdf$/);
  });

  it('refuses a chatKey that is not a chatKey, rather than creating a path from it', () => {
    retainOutbound('../escape', 'image', Buffer.from('x'));
    expect(existsSync(join(paths.mediaOut, '../escape'))).toBe(false);
  });

  it('never throws, because the message has already been delivered', () => {
    expect(() => retainOutbound(KEY, 'image', Buffer.alloc(0))).not.toThrow();
  });
});

describe('staying bounded', () => {
  it('sweeps anything past the age limit', () => {
    retainOutbound(KEY, 'image', Buffer.from('old'));
    const stale = join(paths.mediaOut, KEY, files()[0] as string);
    const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);

    // The sweep runs on write, so the next send is what collects it.
    retainOutbound(KEY, 'image', Buffer.from('new'));

    expect(existsSync(stale)).toBe(false);
    expect(files()).toHaveLength(1);
  });

  it('drops the oldest first when the byte cap is exceeded', () => {
    // 512 MB is the cap; fake it with sparse files rather than allocating it.
    mkdirSync(join(paths.mediaOut, KEY), { recursive: true });
    for (let i = 0; i < 3; i += 1) {
      const path = join(paths.mediaOut, KEY, `${String(1000 + i)}-pad-image.jpg`);
      writeFileSync(path, Buffer.alloc(0));
      // 200 MB apiece: three of them are over the cap, two are not.
      const handle = openSync(path, 'r+');
      ftruncateSync(handle, 200 * 1024 * 1024);
      closeSync(handle);
      const when = new Date(Date.now() - (3 - i) * 60_000);
      utimesSync(path, when, when);
    }

    retainOutbound(KEY, 'image', Buffer.from('newest'));

    const remaining = files();
    // The oldest padding file is gone; the newest write survives.
    expect(remaining).not.toContain('1000-pad-image.jpg');
    expect(remaining.some((n) => n.endsWith('-image.jpg'))).toBe(true);
  });
});

describe('where it lives', () => {
  it('is under the bridge-only state volume, not the handoff the agent mounts', () => {
    // The containment property in one assertion: `handoff-in` is mounted into
    // the agent read-only, so a copy of everything it ever generated must not
    // be filed there.
    expect(paths.mediaOut.startsWith(root)).toBe(true);
    expect(paths.mediaOut.startsWith(inPaths.media)).toBe(false);
    expect(paths.mediaOut).not.toContain(join(root, 'in'));
    expect(paths.mediaOut).not.toContain(join(root, 'out'));
  });
});
