/**
 * The photo the agent could not open.
 *
 * WhatsApp's full-size photo is 2048px on its long edge and the agent's reader
 * refuses past 2000, with no resize of its own — so every ordinary photo came
 * back unreadable, receipts included. What matters here is the boundary either
 * side of that, and that the original is never touched.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { VIEW_EDGE, VIEW_SUFFIX, viewCopy } from '../src/images.js';

let dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function photo(width: number, height: number): Promise<{ abs: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'tulip-img-'));
  dirs.push(dir);
  const abs = join(dir, 'shot.jpg');
  await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } } })
    .jpeg()
    .toFile(abs);
  return { abs, dir };
}

const sizeOf = async (p: string) => {
  const { width, height } = await sharp(p).metadata();
  return { width, height };
};

describe('a photo the reader can open', () => {
  it('shrinks the 2048px photo WhatsApp actually sends', async () => {
    const { abs } = await photo(1152, 2048);
    const before = readFileSync(abs);
    const out = await viewCopy(abs, 'media/abc/shot.jpg');

    expect(out).toBe(`media/abc/shot.jpg${VIEW_SUFFIX}`);
    const made = await sizeOf(`${abs}${VIEW_SUFFIX}`);
    expect(Math.max(made.width ?? 0, made.height ?? 0)).toBe(VIEW_EDGE);
    // The shape is kept: a receipt squeezed into a square is a receipt nobody
    // can read.
    expect((made.width ?? 0) / (made.height ?? 1)).toBeCloseTo(1152 / 2048, 2);
    // And the operator's copy is byte-for-byte what arrived.
    expect(readFileSync(abs).equals(before)).toBe(true);
  });

  it('leaves a photo that already fits alone, with no copy beside it', async () => {
    const { abs } = await photo(800, 600);
    expect(await viewCopy(abs, 'media/abc/shot.jpg')).toBeNull();
    expect(existsSync(`${abs}${VIEW_SUFFIX}`)).toBe(false);
  });

  it('treats the edge itself as fitting', async () => {
    const { abs } = await photo(VIEW_EDGE, VIEW_EDGE);
    expect(await viewCopy(abs, 'media/abc/shot.jpg')).toBeNull();
  });

  it('shrinks a very wide photo by its long edge', async () => {
    const { abs } = await photo(4000, 600);
    await viewCopy(abs, 'media/abc/shot.jpg');
    const made = await sizeOf(`${abs}${VIEW_SUFFIX}`);
    expect(made.width).toBe(VIEW_EDGE);
    expect(made.height).toBeLessThan(VIEW_EDGE);
  });

  it('answers null rather than throwing when the file is not an image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tulip-img-'));
    dirs.push(dir);
    const abs = join(dir, 'not-a-photo.jpg');
    require('node:fs').writeFileSync(abs, 'this is text, not a jpeg');
    expect(await viewCopy(abs, 'media/abc/not-a-photo.jpg')).toBeNull();
  });
});
