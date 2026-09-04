/**
 * What the agent remembers, shared by every conversation.
 *
 * **This is the one piece of state that crosses chats, and it was added
 * deliberately against the grain of the rest of the design.** Everywhere else,
 * isolation is structural: one session per chat, so there is nothing to leak
 * rather than a rule against leaking it. Shared memory gives that up on purpose,
 * because the operator wants one assistant rather than a dozen strangers who
 * happen to share a voice.
 *
 * What follows from that, and why this file is shaped the way it is:
 *
 *   - **The agent cannot write it.** The file lives on the inbound volume, which
 *     the agent mounts read-only. It asks; the bridge writes. A file the agent
 *     could edit is one a compromised agent could rewrite wholesale, and this
 *     one reaches every conversation.
 *   - **Every write is loud.** Each note goes to the structured log and to the
 *     feed, with the chat that asked for it. An operator who never looks will
 *     still scroll past it.
 *   - **Every note records its source.** If something odd turns up in Tulip's
 *     answers, the question "who taught it that" has an answer.
 *   - **It is small and finite.** Two hundred notes, three hundred characters
 *     each. A memory that grows without limit becomes the context window.
 *
 * The residual risk is real and is not engineered away: anyone who can message
 * this number can ask it to remember something, and what it remembers reaches
 * everybody. The persona is told what must never go in — secrets, and anything
 * personal about somebody who is not in the room — and the operator can read and
 * delete the whole store from the panel. That is mitigation, not prevention.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MemoryFile, type MemoryNote, inPaths, writeJsonAtomic } from '@tulip/shared';
import { log } from './log.js';

const MAX_NOTES = 200;

export function readMemory(): MemoryNote[] {
  try {
    if (!existsSync(inPaths.memory)) return [];
    const parsed = MemoryFile.safeParse(JSON.parse(readFileSync(inPaths.memory, 'utf8')));
    if (!parsed.success) {
      log('memory.invalid', { note: 'unreadable; treating as empty rather than guessing' });
      return [];
    }
    return parsed.data.notes;
  } catch {
    return [];
  }
}

function persist(notes: MemoryNote[]): boolean {
  try {
    // Mode 0644: the agent reads this, and its mount is read-only anyway.
    writeJsonAtomic(inPaths.memory, { notes }, 0o644);
    return true;
  } catch (err) {
    log('memory.writeFailed', { err: String((err as Error).message) });
    return false;
  }
}

export type Remembered = { ok: true; total: number } | { ok: false; error: string };

/** Add a note. Oldest falls off the end rather than refusing a new one. */
export function remember(text: string, chatKey: string, chatName: string | null): Remembered {
  const trimmed = text.trim().slice(0, 300);
  if (trimmed.length === 0) return { ok: false, error: 'nothing to remember' };

  const notes = readMemory();
  // Exact duplicates are the commonest failure here: an agent reminded of
  // something re-remembers it, and the store fills with one fact.
  if (notes.some((n) => n.text.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: true, total: notes.length };
  }

  const note: MemoryNote = {
    id: randomUUID(),
    at: new Date().toISOString(),
    text: trimmed,
    chatKey,
    chatName,
  };
  const next = [...notes, note].slice(-MAX_NOTES);
  if (!persist(next)) return { ok: false, error: 'the memory could not be written' };

  log('memory.remembered', { chatKey, chars: trimmed.length, total: next.length });
  return { ok: true, total: next.length };
}

export function forget(id: string): boolean {
  const notes = readMemory();
  const next = notes.filter((n) => n.id !== id);
  if (next.length === notes.length) return false;
  if (!persist(next)) return false;
  log('memory.forgot', { id, total: next.length });
  return true;
}

export function forgetAll(): number {
  const count = readMemory().length;
  persist([]);
  log('memory.cleared', { removed: count });
  return count;
}
