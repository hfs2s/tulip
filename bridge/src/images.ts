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
