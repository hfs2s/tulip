#!/usr/bin/env node
/**
 * UserPromptSubmit hook.
 *
 * Clears the "already spoke" marker so the Stop hook can tell whether this turn
 * said anything out loud, and drops a busy marker for anyone reading the
 * workspace.
 *
 * Neither marker is authoritative. The supervisor decides whether a turn is
 * running by reading the pane, because hooks are a courtesy that can stop
 * firing — and when they do, a marker-only check fails in both directions at
 * once: a stale marker pins delivery shut forever, and a missing one lets the
 * supervisor type into a session that is still thinking.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryFile, inPaths } from '@tulip/shared';
import { catchUpText, notesSince } from '../memory-delta.js';

const markers = join(process.env['TULIP_CHAT_DIR'] ?? '', '.markers');
/** The last note this session has been told about. Written by the spawn too. */
const seenFile = join(markers, 'memory-seen');

/**
 * Hand this turn whatever has been remembered since the last one.
 *
 * The brief carries the memory as it stood when the session spawned; without
 * this, that is the only time it is ever read, and a note recorded in another
 * conversation waits for a respawn — four hours on this deployment. Tulip is
 * meant to be one person who knows the same things everywhere, and a memory
 * that arrives hours late is not that.
 *
 * Only the difference is sent, so an ordinary turn emits nothing at all and
 * costs no tokens. Failure is silence: a hook that cannot read the store must
 * not stop somebody being answered.
 */
function catchUp(): void {
  let notes;
  try {
    const parsed = MemoryFile.safeParse(JSON.parse(readFileSync(inPaths.memory, 'utf8')));
    if (!parsed.success) return;
    notes = parsed.data.notes;
  } catch {
    return; // nothing has ever been remembered
  }

  let seen: string | null = null;
  try {
    seen = readFileSync(seenFile, 'utf8').trim() || null;
  } catch {
    /* no marker yet: the spawn writes one, so this is a session that predates it */
  }

  const delta = notesSince(notes, seen);
  if (delta.tip !== null) writeFileSync(seenFile, delta.tip);

  const text = catchUpText(delta);
  if (text === null) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    })}\n`,
  );
}

try {
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, 'busy'), String(Date.now()));
  rmSync(join(markers, 'spoke'), { force: true });
} catch {
  /* never block a turn on bookkeeping */
}

try {
  catchUp();
} catch {
  /* the memory is a courtesy; a turn must happen regardless */
}

process.exit(0);
