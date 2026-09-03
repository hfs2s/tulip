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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const markers = join(process.env['TULIP_CHAT_DIR'] ?? '', '.markers');

try {
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, 'busy'), String(Date.now()));
  rmSync(join(markers, 'spoke'), { force: true });
} catch {
  /* never block a turn on bookkeeping */
}

process.exit(0);
