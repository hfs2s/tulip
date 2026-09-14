/**
 * A photo the agent can actually open.
 *
 * WhatsApp sends a full-size photo at 2048px on its long edge. The agent's
 * reader refuses anything over 2000px and cannot resize it itself — so *every
 * ordinary photo* came back as "Unable to resize image — dimensions exceed the
 * 2000x2000px limit", and the agent, correctly, would not guess at what it
 * could not see. That was receipts it was asked to total.
 *
 * So the trusted side does the work, as it does for every other capability
 * here: the bridge writes a smaller copy beside the original and hands the
 * agent that one. The original is untouched, because it is the operator's —
 * the Media page shows it, a receipt may need zooming into, and a photo is not
 * ours to degrade on the way past.
 *
 * 1568px, not 2000, and that is not caution. It is the long edge the vision
 * stack resizes to anyway; anything larger is re-encoded on arrival and paid
 * for in tokens on the way. Sending 2000 would cost more to say the same.
 */
import { existsSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { log } from './log.js';

/** How the smaller copy is named, and what `mediaList` filters out. */
export const VIEW_SUFFIX = '.view.jpg';

/** The long edge the reader is given. See the note above. */
export const VIEW_EDGE = 1568;

/**
 * Write a readable copy of an image, or answer null when none is needed.
 *
 * Never throws. A photo that cannot be resized is a photo the agent reads at
 * full size and may refuse — which is the behaviour before this file existed,
 * and is a great deal better than losing the message it arrived with.
 */
export async function viewCopy(absolute: string, relative: string): Promise<string | null> {
  try {
    const image = sharp(absolute, { failOn: 'none' });
    const { width, height } = await image.metadata();
    if (typeof width !== 'number' || typeof height !== 'number') return null;
    if (width <= VIEW_EDGE && height <= VIEW_EDGE) return null;

    await image
      .rotate() // honour EXIF orientation; a receipt photographed sideways is unreadable twice over
      .resize({ width: VIEW_EDGE, height: VIEW_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(`${absolute}${VIEW_SUFFIX}`);

    log('media.resized', { from: `${String(width)}x${String(height)}`, to: VIEW_EDGE });
    return `${relative}${VIEW_SUFFIX}`;
  } catch (err) {
    log('media.resizeFailed', { note: String((err as Error).message).slice(0, 160) });
    return null;
  }
}

/**
 * Turn the paths an agent named into files it is allowed to work from.
 *
 * The agent names `media/<chatKey>/<file>` because that is how the batch names
 * them. What it must not be able to do is name *another* conversation's photo
 * and have the bridge feed it to an image service — so the chat key is taken
 * from the turn rather than from the request, and anything that does not
 * resolve inside that one chat's directory is dropped.
 *
 * The same shape as `resolveMedia` in panel-api.ts, and for the same reason:
 * a path is chosen from a fixed root, never built out of what arrived.
 */
export function referencePaths(
  mediaRoot: string,
  chatKey: string,
  named: readonly string[],
): { paths: string[]; refused: number } {
  const root = resolve(mediaRoot, chatKey);
  const paths: string[] = [];
  let refused = 0;
  for (const raw of named) {
    // `media/<chatKey>/<file>`, as the batch spells it, or a bare file name.
    // A path naming a different chat is refused rather than quietly read from
    // this one: the agent asked for a particular picture, and handing it a
    // different picture with the same file name is its own kind of wrong.
    const full = /^media\/([0-9a-f]{16})\/([^/]+)$/.exec(raw);
    let file: string | undefined;
    if (full !== null) {
      if (full[1] !== chatKey) { refused += 1; continue; }
      file = full[2];
    } else if (!raw.includes('/')) {
      file = raw;
    } else {
      refused += 1;
      continue;
    }
    if (file === undefined || file.startsWith('.') || file !== basename(file)) { refused += 1; continue; }
    const candidate = resolve(root, file);
    if (!candidate.startsWith(root + sep) || !existsSync(candidate)) { refused += 1; continue; }
    paths.push(candidate);
  }
  return { paths, refused };
}
