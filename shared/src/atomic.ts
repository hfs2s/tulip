/**
 * Atomic file writes.
 *
 * Every file in the handoff volumes is read by a *different container* than the
 * one that wrote it, on a poll loop, with no locking between them. A plain
 * `writeFile` is not atomic, so the reader can and will observe a half-written
 * JSON document — which parses as an error, and in the naive handling gets
 * treated as a malformed message and discarded.
 *
 * Write to a temporary name in the same directory, then `rename`. On a POSIX
 * filesystem that swap is atomic: a reader sees either the whole old file, or
 * the whole new one, and never a partial write.
 */
import { mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Atomically write text to `file`, creating parent directories as needed.
 *
 * The temporary file must live in the same directory as the target: `rename` is
 * only atomic within a filesystem, and `/tmp` is a separate tmpfs in every one
 * of Tulip's containers.
 */
export function writeFileAtomic(file: string, contents: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode });
    renameSync(tmp, file);
  } catch (err) {
    // Never leave a temporary behind: the readers on both sides list these
    // directories, and a growing pile of `.tmp` files is how a transient disk
    // error turns into a permanent one.
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** As `writeFileAtomic`, for a JSON document. */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2), mode);
}
