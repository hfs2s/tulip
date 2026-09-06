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
import { inPaths, writeFileAtomic } from '@tulip/shared';

/** Where per-chat workspaces and the persona live inside the agent container. */
export const WORKSPACE_ROOT = process.env['TULIP_WORKSPACE'] ?? '/workspace';
export const PERSONA_DIR = process.env['TULIP_PERSONA'] ?? '/persona';

/** Assembled in this order: who she is, how she carries herself, how she works. */
const PERSONA_PARTS = ['IDENTITY.md', 'VOICE.md', 'OPERATING.md', 'BOUNDARIES.md'] as const;

/**
 * How many remembered notes the brief carries.
 *
 * Claude Code refuses to carry a CLAUDE.md past 40k characters, and the persona
 * is most of that already. Forty notes is a few thousand characters and leaves
 * the brief itself room; the rest stay in the store, and anything new arrives
 * through the prompt hook rather than by growing this file.
 */
const MEMORY_IN_BRIEF = 40;

export interface ChatWorkspace {
  readonly chatKey: string;
  readonly dir: string;
  /** Holds the id of the turn being answered. Read by `tulip-wa` and the hooks. */
  readonly turnFile: string;
  readonly claudeMd: string;
}

/**
 * The operator's own pane, and why it is a workspace rather than a note.
 *
 * ttyd attaches with `new-session -A`, so the session has to exist before
 * anybody looks at it. It used to be created holding a printed message saying
 * no conversation was running — honest, and the wrong thing entirely: the pane
 * is the operator's window into this container, and a paragraph of text is not
 * a terminal. What belongs there when no chat is live is a working session.
 *
 * It is deliberately NOT the persona. Juan is a person answering a specific
 * conversation, and a Juan with no conversation is a character with nobody to
 * talk to — it would answer the operator in voice, then try to reply over
 * WhatsApp and fail. This is the console: it knows what box it is on.
 *
 * **It cannot send a message, and that is structural rather than instructed.**
 * `tulip-wa` resolves its chat by walking up for a `.turn` file, and this
 * directory is outside `chats/` — so every send verb refuses here, whatever an
 * operator or an injected instruction asks for.
 */
export const CONSOLE_DIR = join(WORKSPACE_ROOT, 'console');

const CONSOLE_BRIEF = `# The Tulip console

This is a Claude Code session inside the \`tulip-agent\` container, attached to
no conversation. An operator opened the Terminal page and this is what was
waiting for them.

You are not answering anybody. The persona is not loaded here on purpose — when
a chat is being answered it gets its own window and this pane follows it.

**You cannot send WhatsApp messages from here.** \`tulip-wa\` finds the chat it
belongs to by walking up for a \`.turn\` file; there is none above this
directory, so every send verb will refuse. That is the design, not a fault, and
it is not worth working around — a message sent from here would arrive in
whichever conversation happened to be open.

What this pane is good for: looking at the container. Process state, disk, the
logs under \`/handoff/out\`, what a session actually wrote. Chat workspaces are
under \`/workspace/chats/<key>\` — read one if an operator asks you to diagnose
something, but do not go browsing conversations, and never carry what is in one
into another.
`;

/**
 * Create the console workspace.
 *
 * No hooks in its settings: both of them key off `TULIP_CHAT_DIR` to find the
 * conversation they belong to, and here there is not one. Wiring them anyway
 * would have the prompt hook writing markers into a relative `.markers` path
 * on every keystroke an operator made.
 */
export function ensureConsoleWorkspace(): string {
  mkdirSync(join(CONSOLE_DIR, '.claude'), { recursive: true });
  writeFileSync(join(CONSOLE_DIR, '.claude', 'settings.json'), JSON.stringify({}, null, 2));
  writeFileSync(join(CONSOLE_DIR, 'CLAUDE.md'), CONSOLE_BRIEF);
  return CONSOLE_DIR;
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

  // The brief below carries the memory as it stands now, so the prompt hook
  // starts from here and sends only what arrives later. Written together with
  // the brief, deliberately: two writes that could disagree would either repeat
  // the whole memory into the first turn or skip a note entirely.
  markMemorySeen(workspace);

  const persona = composePersona();
  writeFileSync(
    workspace.claudeMd,
    `${persona}${sharedMemory()}\n\n---\n\nThis file is regenerated from the persona directory every time a ` +
      `session starts. Editing it here changes nothing; edit the persona instead.\n`,
  );

  return workspace;
}

/**
 * Record how much of the memory the brief already contains.
 *
 * The hook tops up from this point on every turn. Absent, it would resend the
 * entire store into the first turn of every session — the brief's copy and the
 * hook's copy, one after the other.
 */
function markMemorySeen(workspace: ChatWorkspace): void {
  try {
    const raw = readFileSync(inPaths.memory, 'utf8');
    const notes = (JSON.parse(raw) as { notes?: Array<{ id?: unknown }> }).notes ?? [];
    const tip = notes[notes.length - 1]?.id;
    mkdirSync(join(workspace.dir, '.markers'), { recursive: true });
    writeFileSync(join(workspace.dir, '.markers', 'memory-seen'), typeof tip === 'string' ? tip : '');
  } catch {
    /* nothing remembered yet, or unreadable — the hook then sends what it finds */
  }
}

/**
 * What has been remembered, folded into every chat's brief.
 *
 * The one thing in this file that is *not* per chat. It is read from the
 * inbound volume, which is read-only here — the agent asks the bridge to
 * remember and the bridge writes, so a session cannot edit what every other
 * session will read.
 *
 * Absent or unreadable yields nothing at all rather than an empty heading: a
 * "Remembered" section with no entries invites an agent to fill it.
 */
function sharedMemory(): string {
  try {
    const raw = readFileSync(inPaths.memory, 'utf8');
    const all = (JSON.parse(raw) as { notes?: Array<{ text?: unknown }> }).notes ?? [];
    // Capped, because the brief has a ceiling and this does not: the store holds
    // two hundred notes of three hundred characters, which is 60k on its own —
    // more than Claude Code will carry, and it would push the persona out to
    // make room. The newest are the ones worth having, and anything recorded
    // after this session started arrives through the prompt hook anyway.
    const notes = all.slice(-MEMORY_IN_BRIEF);
    const older = all.length - notes.length;
    const lines = notes
      .map((n) => (typeof n.text === 'string' ? n.text.trim() : ''))
      .filter((t) => t.length > 0)
      .map((t) => `- ${t}`);
    if (lines.length === 0) return '';
    const elided = older > 0
      ? ` The ${String(older)} oldest are not shown here; ask an operator if you need them.`
      : '';
    return (
      `\n\n## Remembered\n\n` +
      `Things you have been asked to remember. They are shared by every ` +
      `conversation, so treat them as things you know rather than as things ` +
      `somebody here told you — and never repeat one back in a way that reveals ` +
      `which chat it came from.${elided}\n\n${lines.join('\n')}\n`
    );
  } catch {
    return '';
  }
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
