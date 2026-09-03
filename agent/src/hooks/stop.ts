#!/usr/bin/env node
/**
 * Stop hook — the safety net.
 *
 * If a turn ended without a single `tulip-wa send`, relay the final assistant
 * message so a conversation can never go silent just because the model finished
 * its thought in the terminal instead of out loud. Someone waiting on WhatsApp
 * cannot tell the difference between "thinking" and "broken", and the second
 * one is what silence looks like.
 *
 * Best-effort throughout: a hook that throws is a turn that never ends.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OutboxAction, outPaths, writeJsonAtomic } from '@tulip/shared';

interface HookInput {
  last_assistant_message?: string;
  transcript_path?: string;
}

function readInput(): HookInput {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  } catch {
    return {};
  }
}

/**
 * The chat directory this hook belongs to.
 *
 * From the environment, never from the hook payload's `cwd`: the agent may have
 * changed directory during the turn, and a marker written under a subdirectory
 * is invisible to everything that looks for it.
 */
const chatDir = process.env['TULIP_CHAT_DIR'] ?? '';
const markers = join(chatDir, '.markers');

/** Assistant text emitted since the last user turn, main thread only. */
function lastAssistantText(transcript: string | undefined): string {
  if (transcript === undefined) return '';
  let lines: string[];
  try {
    lines = readFileSync(transcript, 'utf8').trimEnd().split('\n');
  } catch {
    return '';
  }

  const chunks: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[i] ?? '') as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry['isSidechain'] === true) continue; // subagent chatter is not for the user
    if (entry['type'] === 'user') break; // includes tool results — stop there
    if (entry['type'] !== 'assistant') continue;

    const message = entry['message'] as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) continue;
    const text = (message.content as Array<Record<string, unknown>>)
      .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
      .map((part) => String(part['text']).trim())
      .filter((t) => t.length > 0)
      .join('\n\n');
    if (text.length > 0) chunks.unshift(text);
  }
  return chunks.join('\n\n').trim();
}

function relay(input: HookInput): void {
  if (existsSync(join(markers, 'spoke'))) return; // this turn already said something

  let turnId: string;
  try {
    turnId = readFileSync(join(chatDir, '.turn'), 'utf8').trim();
  } catch {
    return; // nothing routed here yet
  }
  if (turnId.length === 0) return;

  // Prefer the payload: the transcript file is flushed asynchronously and often
  // does not yet hold this turn's final block when the hook fires.
  const text = (input.last_assistant_message ?? '').trim() || lastAssistantText(input.transcript_path);
  if (text.length === 0) return;

  const id = randomUUID();
  const action = OutboxAction.safeParse({ id, turnId, kind: 'text', text: text.slice(0, 4096) });
  if (!action.success) return;

  mkdirSync(outPaths.actions, { recursive: true });
  writeJsonAtomic(outPaths.action(id), action.data, 0o644);
}

try {
  mkdirSync(markers, { recursive: true });
  relay(readInput());
} catch {
  /* a failed relay must never wedge the session */
} finally {
  try {
    rmSync(join(markers, 'busy'), { force: true });
  } catch {
    /* ignore */
  }
}

process.exit(0);
