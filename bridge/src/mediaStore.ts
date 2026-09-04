/**
 * Copies of what Juan sent, kept so an operator can see it.
 *
 * The panel could always show every attachment people sent *in*, and nothing at
 * all of what the agent produced — so the one capability that is generative,
 * billed and pointed at the public was the one thing that could not be
 * reviewed. If the agent sends a stranger an odd picture, "what did it actually
 * send" should be answerable.
 *
 * Two properties this store must have, and both are the reason it is here
 * rather than beside the inbound media:
 *
 *   - **The agent cannot read it.** `handoff-in` is mounted into the agent
 *     read-only, which is fine for material the agent was already given; a copy
 *     of everything it has ever generated is a different thing. `state` is
 *     mounted in the bridge and nowhere else, so this is invisible to it.
 *   - **It is bounded.** This runs on a Pi with one disk. Pictures are about a
 *     megabyte each and nothing here is load-bearing, so the store is swept to
 *     a byte cap and an age limit on every write, oldest first.
 *
 * Written after a successful send rather than before, so the store means "what
 * was delivered" rather than "what was attempted" — a file here is evidence
 * that somebody received it.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '@tulip/shared';
import { paths } from './paths.js';
import { log } from './log.js';

/** Generous next to a 3.6 MB state volume, and small next to the disk it sits on. */
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const EXTENSIONS: Record<string, string> = {
  image: 'jpg',
  voice: 'ogg',
  gif: 'mp4',
};

/**
 * Keep a copy of one outbound attachment.
 *
 * Never throws and never blocks a send from being reported as successful: the
 * message has already gone, and failing to file a copy of it must not turn a
 * delivered reply into an error the operator has to interpret.
 */
export function retainOutbound(chatKey: string, kind: string, data: Buffer, mimetype?: string): void {
  if (!/^[0-9a-f]{16}$/.test(chatKey)) return;
  try {
    const extension = EXTENSIONS[kind] ?? extensionFor(mimetype) ?? 'bin';
    const directory = join(paths.mediaOut, chatKey);
    mkdirSync(directory, { recursive: true });
    // The timestamp orders the gallery and the random suffix keeps two sends in
    // the same millisecond from colliding.
    const name = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}-${kind}.${extension}`;
    writeFileAtomic(join(directory, name), data, 0o600);
    sweep();
  } catch (err) {
    log('mediaOut.writeFailed', { err: String((err as Error).message) });
  }
}

function extensionFor(mimetype: string | undefined): string | null {
  if (typeof mimetype !== 'string') return null;
  const subtype = mimetype.split('/')[1]?.split(';')[0] ?? '';
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : null;
}

/** Oldest first, to an age limit and then to a byte cap. */
function sweep(): void {
  let files: Array<{ path: string; at: number; bytes: number }> = [];
  try {
    for (const chat of readdirSync(paths.mediaOut, { withFileTypes: true })) {
      if (!chat.isDirectory()) continue;
      const directory = join(paths.mediaOut, chat.name);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        try {
          const stat = statSync(path);
          if (stat.isFile()) files.push({ path, at: stat.mtimeMs, bytes: stat.size });
        } catch {
          /* vanished under us; nothing to sweep */
        }
      }
    }
  } catch {
    return;
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const expired = files.filter((f) => f.at < cutoff);
  for (const file of expired) remove(file.path);
  files = files.filter((f) => f.at >= cutoff);

  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total <= MAX_BYTES) return;
  files.sort((a, b) => a.at - b.at);
  for (const file of files) {
    if (total <= MAX_BYTES) break;
    remove(file.path);
    total -= file.bytes;
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort: a copy we cannot delete is not worth failing a send over */
  }
}
