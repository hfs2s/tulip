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
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

  // Bind the turn NOW, at the start, and let the Stop hook relay against this
  // rather than against `.turn`.
  //
  // `.turn` became a single global file when Tulip moved to one shared session,
  // and the Stop hook reads it when the turn *ends* — so a hook still running
  // when the supervisor dispatches the next chat would read that chat's id and
  // deliver this conversation's leftover reply to a different person. Reading a
  // value captured at the start cannot do that: the worst case is a stale id,
  // which the bridge resolves back to the conversation it actually belongs to.
  try {
    const turnId = readFileSync(join(process.env['TULIP_CHAT_DIR'] ?? '', '.turn'), 'utf8').trim();
    if (turnId.length > 0) writeFileSync(join(markers, 'answering'), turnId);
    else rmSync(join(markers, 'answering'), { force: true });
  } catch {
    // No turn routed here — an operator typing in the pane. The Stop hook then
    // finds nothing to relay against and stays quiet, which is correct.
    rmSync(join(markers, 'answering'), { force: true });
  }
} catch {
  /* never block a turn on bookkeeping */
}

/**
 * Notice when the last turn wrote to the *wrong* memory.
 *
 * Claude Code has a memory tool of its own, and its store is per project —
 * which here means per chat. So a note written with it is invisible in every
 * other conversation, while feeling exactly like remembering something. That is
 * a trap rather than a mistake: the built-in tool is frictionless and always
 * there, `tulip-wa remember` has to be chosen, and nothing about the first
 * announces that it does not cross.
 *
 * Telling it so in the brief is not enough — it has been told, and it reached
 * for the native tool anyway. So the reminder arrives where it is actionable:
 * the turn immediately after, naming what it wrote, while it still knows why.
 */
function nudgeIfPrivateMemoryWritten(): void {
  const chatDir = process.env['TULIP_CHAT_DIR'] ?? '';
  const config = process.env['CLAUDE_CONFIG_DIR'] ?? '';
  if (chatDir.length === 0 || config.length === 0) return;

  // Claude Code names a project directory after its working directory, with the
  // separators replaced. Derived rather than configured, so it follows the
  // workspace wherever that moves.
  const slug = chatDir.replace(/\//g, '-');
  const dir = join(config, 'projects', slug, 'memory');

  let latest = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const at = statSync(join(dir, entry)).mtimeMs;
      if (at > latest) latest = at;
    }
  } catch {
    return; // the tool has never been used here
  }
  if (latest === 0) return;

  const stampFile = join(markers, 'private-memory-seen');
  let seen = 0;
  try {
    seen = Number(readFileSync(stampFile, 'utf8').trim()) || 0;
  } catch {
    /* first time */
  }
  writeFileSync(stampFile, String(latest));
  // Only when it changed, so this is silent on every turn that did not write.
  if (seen === 0 || latest <= seen) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          'Last turn you wrote to your own memory tool. That store is per conversation — ' +
          'nothing there is visible in any other chat, however it felt at the time. If any ' +
          'of it should be known everywhere, record it again with `tulip-wa remember "…"`, ' +
          'which is the only memory that crosses. If it was specific to this conversation, ' +
          'leave it where it is and carry on.',
      },
    })}\n`,
  );
}

try {
  catchUp();
  nudgeIfPrivateMemoryWritten();
} catch {
  /* the memory is a courtesy; a turn must happen regardless */
}

process.exit(0);
