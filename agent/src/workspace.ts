/**
 * One workspace per chat.
 *
 * Chat isolation in Tulip is structural rather than instructed. Each chat gets
 * its own directory, its own `CLAUDE.md`, and its own Claude Code session keyed
 * by a UUID derived from the chat — so another person's messages are not in the
 * context window that answers this one, and there is nothing to leak rather
 * than a rule against leaking it.
 *
 * Iris shares one session across every conversation and relies on its persona
 * for discretion. That is a reasonable trade for six friends. For a number
 * strangers can message it is not: "do not repeat one chat to another" is an
 * instruction, and instructions are what a prompt injection overrides.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '@tulip/shared';

/** Where per-chat workspaces and the persona live inside the agent container. */
export const WORKSPACE_ROOT = process.env['TULIP_WORKSPACE'] ?? '/workspace';
export const PERSONA_DIR = process.env['TULIP_PERSONA'] ?? '/persona';

/** Assembled in this order: who she is, how she carries herself, how she works. */
const PERSONA_PARTS = ['IDENTITY.md', 'VOICE.md', 'OPERATING.md', 'BOUNDARIES.md'] as const;

export interface ChatWorkspace {
  readonly chatKey: string;
  readonly dir: string;
  /** Holds the id of the turn being answered. Read by `tulip-wa` and the hooks. */
  readonly turnFile: string;
  readonly claudeMd: string;
}

export function workspaceFor(chatKey: string): ChatWorkspace {
  const dir = join(WORKSPACE_ROOT, 'chats', chatKey);
  return { chatKey, dir, turnFile: join(dir, '.turn'), claudeMd: join(dir, 'CLAUDE.md') };
}

/**
 * Compose the persona from the version-controlled files.
 *
 * Kept as separate files rather than one blob so identity, voice, operating
 * notes and boundaries can be edited without disturbing each other — and so
 * that the boundaries section, which is the security-relevant half, is
 * reviewable on its own.
 */
function composePersona(): string {
  const chunks: string[] = [];
  for (const part of PERSONA_PARTS) {
    const file = join(PERSONA_DIR, part);
    if (!existsSync(file)) continue;
    chunks.push(readFileSync(file, 'utf8').trim());
  }
  return chunks.join('\n\n---\n\n');
}

/** Hook wiring, written into each chat workspace's `.claude/settings.json`. */
function settings(): unknown {
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /app/agent/dist/hooks/prompt.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node /app/agent/dist/hooks/stop.js' }] }],
    },
  };
}

/**
 * Create or refresh a chat's workspace.
 *
 * `CLAUDE.md` is regenerated on every spawn, so editing `persona/` and
 * restarting the container changes who Tulip is everywhere at once. Editing the
 * generated file does nothing, which the file says about itself.
 */
export function ensureWorkspace(chatKey: string): ChatWorkspace {
  const workspace = workspaceFor(chatKey);
  mkdirSync(join(workspace.dir, '.claude'), { recursive: true });

  writeFileSync(join(workspace.dir, '.claude', 'settings.json'), JSON.stringify(settings(), null, 2));

  const persona = composePersona();
  writeFileSync(
    workspace.claudeMd,
    `${persona}\n\n---\n\nThis file is regenerated from the persona directory every time a session ` +
      `starts. Editing it here changes nothing; edit the persona instead.\n`,
  );

  return workspace;
}

/**
 * Record which turn this chat is answering.
 *
 * This is why a reply cannot be delivered to the wrong conversation. The turn
 * id is written *per chat*, immediately before the prompt is injected, and
 * `tulip-wa` reads it from the workspace it is running in — never from a global
 * "current turn" file. With a global file, a session that finished slowly would
 * stamp its reply with whichever turn happened to be current when it got around
 * to sending, and that reply would be delivered to a different person.
 */
export function setTurn(workspace: ChatWorkspace, turnId: string): void {
  writeFileAtomic(workspace.turnFile, turnId, 0o644);
}

export function readTurn(workspace: ChatWorkspace): string | null {
  try {
    const value = readFileSync(workspace.turnFile, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
