/**
 * The agent's own Claude Code transcript, read from the workspace volume.
 *
 * This is what the panel's Chat page renders instead of a raw tmux pane: what
 * somebody said, what Juan replied, and a one-line trace of the tools he
 * reached for — rather than a TUI full of box-drawing characters and spinner
 * frames. Nothing here is voice-note transcription; `transcriptFor` in
 * `@tulip/shared` is a different thing entirely and the collision of words is
 * unfortunate.
 *
 * ─── Why the bridge reads the file rather than being handed a rendering ──────
 *
 * There were two ways to get a transcript across the wall, and the choice is
 * worth writing down because the obvious argument for one of them is wrong.
 *
 *   1. Mount `workspace` read-only into the bridge and parse the JSONL here.
 *   2. Have the agent render a transcript and publish it to `handoff-out`,
 *      exactly as it publishes `usage.json` today.
 *
 * The tempting argument for (1) is that reading the file is more trustworthy
 * than being told about it. **That argument is false and must not be repeated
 * here.** These transcripts sit on the agent's own read-write volume; a
 * compromised agent can rewrite them line by line. So (1) and (2) produce
 * exactly the same thing — the untrusted side's account of itself — and this
 * module's output has the same standing as `status.json` and `usage.json`: it
 * is displayed, and no decision anywhere is made from it.
 *
 * With integrity equal, the decision falls to blast radius and to deploy cost.
 *
 *   · **Blast radius.** (1) adds one read-only mount of a volume the agent
 *     writes. The bridge already reads agent-written files on `handoff-out`, so
 *     this is a widening of degree rather than of kind — *provided* symlinks
 *     are refused, which is the whole of the hardening below. (2) adds a writer
 *     on the untrusted side and a second rendering to keep in step across a
 *     container boundary, which is more moving parts for no less trust.
 *   · **Deploy cost.** (2) is an agent code change, and recreating `tulip-agent`
 *     kills every live tmux window — every conversation in flight, mid-turn.
 *     (1) is a bridge change plus a mount on the bridge service, so
 *     `docker compose up -d` recreates the bridge alone and the sessions live.
 *
 * Hence (1). `docker-compose.yml` carries the mount and `docs/THREAT-MODEL.md`
 * carries the consequence.
 *
 * ─── The attack this file exists to refuse ───────────────────────────────────
 *
 * The agent and the bridge share a volume but not a filesystem namespace, so a
 * symlink the agent creates under `/workspace` is resolved by the *bridge*, in
 * the bridge's namespace, where `/state/session` holds the WhatsApp
 * credentials. `ln -s /state /workspace/.claude` and every path below would
 * faithfully confine to the wrong root — and the panel would render the account
 * to whoever asked Juan nicely enough. `bridge/src/outbox.ts` documents this at
 * length for the outbound file path; the checks here are the same shape, for
 * the same reason, and the ordering matters:
 *
 *   0. the chat key is sixteen hex characters, so nothing from a browser is
 *      concatenated into a path;
 *   1. the transcript's name is a UUID with a `.jsonl` suffix — a fixed shape,
 *      never a name the agent chose freely;
 *   2. the directory entry is a real file, not a symlink (`withFileTypes`);
 *   3. `O_NOFOLLOW` on the open, which the kernel enforces atomically;
 *   4. on Linux, `/proc/self/fd` says what was *actually* opened, which is the
 *      only thing that catches a swapped **ancestor** — the `.claude` case
 *      above, which `O_NOFOLLOW` on the leaf cannot see;
 *   5. `fstat` on the descriptor, and every byte read from that one descriptor.
 *
 * And it is bounded: only the tail of the file is read, only that tail is
 * parsed, every string is truncated, and tool *results* are never rendered at
 * all — a tool result is where an `env` dump or a stack trace would be, and
 * "what he did" is the useful half anyway.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * Where the agent's home volume is mounted inside the bridge, read-only.
 *
 * Overridable so the suite can point at a scratch directory; production takes
 * the default and `docker-compose.yml` is what actually puts a volume there.
 */
export const WORKSPACE_MOUNT = process.env['TULIP_WORKSPACE_MOUNT'] ?? '/workspace';

/**
 * The agent's own working directory for a chat — its path *inside the agent*,
 * which is not the same question as where the bridge mounted the volume.
 *
 * Claude Code names a project directory after the cwd it was started in, with
 * every separator replaced by a hyphen: `/workspace/chats/<key>` becomes
 * `-workspace-chats-<key>`. That name was baked in by the agent at spawn time,
 * so it stays fixed here even if `WORKSPACE_MOUNT` moves.
 */
const AGENT_CHAT_DIR = '/workspace/chats';

const CHAT_KEY = /^[0-9a-f]{16}$/;
/** A Claude Code session file: a UUID, and nothing else. */
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/**
 * How much of the tail is read per request.
 *
 * A week of one busy conversation was 900 KB when this was written, and the
 * page shows the recent end of it. Reading a bounded window means an agent that
 * appends a gigabyte costs a fixed amount rather than the bridge's memory.
 */
const TAIL_BYTES = 256 * 1024;
/** Longest single message shown. Long replies are rare; unbounded ones are not. */
const MAX_TEXT = 4000;
/** Longest one-line summary of a tool call. */
const MAX_SUMMARY = 240;
/** Items parsed out of one tail, before the caller's own limit applies. */
const MAX_ITEMS = 600;

// ─── What comes out ──────────────────────────────────────────────────────────

/**
 * One thing that happened inside the session.
 *
 *   · `turn`    — the supervisor handed over a batch. A boundary, not content.
 *   · `prompt`  — something typed at the session's prompt that was not that,
 *                 which in practice means an operator typed it from this panel.
 *   · `note`    — Juan's own words in the session. Not what was sent: what he
 *                 actually sent went out through `tulip-wa` and arrives here as
 *                 a `said` item from the bridge's own feed.
 *   · `thought` — extended thinking. Recessive in the UI; genuinely useful when
 *                 the persona is behaving oddly.
 *   · `tool`    — a tool call, as a name and one line. Never its result.
 */
export interface TranscriptItem {
  readonly ts: number;
  readonly kind: 'turn' | 'prompt' | 'note' | 'thought' | 'tool';
  readonly text: string;
  readonly tool?: string;
}

/** A real message, from the bridge's own feed rather than from the agent. */
export interface SaidItem {
  readonly ts: number;
  readonly kind: 'said';
  readonly direction: 'in' | 'out';
  readonly who: string;
  readonly text: string;
}

export type ViewItem = SaidItem | TranscriptItem;

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * One content block, validated loosely on purpose.
 *
 * Zod strips unknown keys, so a Claude Code release that adds a field changes
 * nothing here — and a release that adds a block *type* degrades to "ignored"
 * rather than to a parse failure that empties the page.
 */
const Block = z.object({
  type: z.string().max(64),
  text: z.string().optional(),
  thinking: z.string().optional(),
  name: z.string().max(128).optional(),
  input: z.unknown().optional(),
});

/** One JSONL line. Everything is optional: this file is written by the agent. */
const Line = z.object({
  type: z.string().max(64),
  timestamp: z.string().max(64).optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  message: z
    .object({
      role: z.string().max(32).optional(),
      content: z.union([z.string(), z.array(Block)]).optional(),
    })
    .optional(),
});

/**
 * The supervisor's own prompt, which is a pointer to a batch file rather than
 * anybody's words. Matched so it can be shown as a boundary instead of as
 * something a person said — see `runTurn` in `agent/src/supervisor.ts`.
 */
const TURN_PROMPT = /^New WhatsApp message/;

/**
 * Flatten text for display, and strip what a browser should never be handed.
 *
 * Control characters first: a transcript can carry any byte the agent felt like
 * writing, and while the panel assigns everything through `textContent` — so
 * nothing here can execute — an escape sequence still garbles the line it lands
 * in. The bidirectional overrides go too: they cannot execute either, and they
 * can make one string render as a different one, which on a page an operator
 * reads to decide something is worse than noise.
 */
function clean(value: string, limit: number): string {
  return value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, limit);
}

/** The same, collapsed to a single line — for the summary beside a tool name. */
function oneLine(value: string, limit: number): string {
  return clean(value, limit * 4).replace(/\s+/g, ' ').slice(0, limit);
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The one interesting argument of a tool call, chosen per tool.
 *
 * An allowlist of field names rather than "stringify the input": tool inputs
 * carry file contents and whole edit payloads, and a page meant to be readable
 * at a glance is not the place for either. Anything unrecognised contributes a
 * name and no detail, which is the honest rendering of "he used a tool I do not
 * have a summary for".
 */
const TOOL_FIELD: Readonly<Record<string, string>> = {
  Bash: 'command',
  BashOutput: 'bash_id',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Task: 'description',
  TodoWrite: 'description',
};

function summariseTool(name: string, input: unknown): string {
  const fields = asRecord(input);
  if (fields === null) return '';
  const preferred = TOOL_FIELD[name];
  const raw = preferred !== undefined ? fields[preferred] : (fields['description'] ?? fields['command']);
  return typeof raw === 'string' ? oneLine(raw, MAX_SUMMARY) : '';
}

/**
 * Turn one validated line into zero or more items.
 *
 * Sidechains are dropped: a subagent's transcript is interleaved into the same
 * file and reads, in a conversational view, as Juan talking to himself in the
 * middle of answering somebody.
 */
function itemsFor(line: z.infer<typeof Line>): TranscriptItem[] {
  if (line.isSidechain === true || line.isMeta === true) return [];
  const ts = Date.parse(line.timestamp ?? '');
  if (!Number.isFinite(ts)) return [];

  const content = line.message?.content;

  if (line.type === 'user') {
    // Array content on a user line is a tool *result* being fed back, which is
    // deliberately not rendered. Only a typed prompt is a string.
    if (typeof content !== 'string') return [];
    const text = clean(content, MAX_TEXT);
    if (text.length === 0) return [];
    if (TURN_PROMPT.test(text)) return [{ ts, kind: 'turn', text: 'A new message was handed over.' }];
    return [{ ts, kind: 'prompt', text }];
  }

  if (line.type !== 'assistant' || !Array.isArray(content)) return [];

  const items: TranscriptItem[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = clean(block.text, MAX_TEXT);
      if (text.length > 0) items.push({ ts, kind: 'note', text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const text = clean(block.thinking, MAX_TEXT);
      if (text.length > 0) items.push({ ts, kind: 'thought', text });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const tool = oneLine(block.name, 64) || 'tool';
      items.push({ ts, kind: 'tool', text: summariseTool(tool, block.input), tool });
    }
  }
  return items;
}

/** Parse a tail of JSONL into items, skipping anything that does not fit. */
export function parseTranscript(text: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue; // a half-written line, or something that is not a record
    }
    const line = Line.safeParse(value);
    if (!line.success) continue;
    for (const item of itemsFor(line.data)) {
      items.push(item);
      if (items.length >= MAX_ITEMS) return items;
    }
  }
  return items;
}

// ─── Finding the file ────────────────────────────────────────────────────────

/** Claude Code's project directory for one chat's workspace. */
export function projectDirName(chatKey: string): string {
  return `${AGENT_CHAT_DIR}/${chatKey}`.replace(/\//g, '-');
}

/**
 * The real path behind an open descriptor, on Linux. Null anywhere else.
 *
 * Null means "cannot tell", never "fine": the caller falls back to a weaker
 * check rather than treating an unknown as a pass. The canonical copy of this
 * is in `bridge/src/outbox.ts`; it is eight lines and duplicated rather than
 * shared because importing that module here would drag the whole outbound
 * stack — Baileys, MiniMax, Giphy — into a read-only reader.
 */
function describeFd(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * The newest transcript for a chat, or null.
 *
 * **Newest by mtime, not by derived session id.** `sessionUuidFor(chatKey,
 * generation)` looks like the right answer and is not: the bridge keeps its own
 * generation counter, the agent reads `TULIP_GENERATION` from its environment,
 * and nothing carries one to the other — so a derived name can point at a file
 * that is not the session being written. The file the agent is appending to is
 * the session, whatever it is called.
 */
export function findTranscript(chatKey: string, root: string = WORKSPACE_MOUNT): string | null {
  if (!CHAT_KEY.test(chatKey)) return null;

  const dir = resolve(root, '.claude', 'projects', projectDirName(chatKey));
  // Belt and braces against a `root` that is itself a relative path: the
  // resolved directory has to still be under the mount.
  const base = resolve(root);
  if (!dir.startsWith(base + sep)) return null;

  let newest: { path: string; at: number } | null = null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // `withFileTypes` reports a symlink as a symlink, so this rejects one
      // without a second syscall and without following it.
      if (!entry.isFile()) continue;
      if (!TRANSCRIPT_NAME.test(entry.name)) continue;
      const path = join(dir, entry.name);
      let at: number;
      try {
        at = lstatSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (newest === null || at > newest.at) newest = { path, at };
    }
  } catch {
    return null; // no session has ever run for this chat
  }
  return newest?.path ?? null;
}

/**
 * Read the tail of a transcript, refusing anything that is not the file we
 * meant to open.
 *
 * Returns null rather than throwing: a missing transcript is the ordinary state
 * of a chat nobody has messaged, and it is the caller's job to say so.
 */
export function readTranscriptTail(path: string, root: string = WORKSPACE_MOUNT): string | null {
  const base = resolve(root);
  if (!resolve(path).startsWith(base + sep)) return null;

  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null; // ELOOP for a symlinked leaf, ENOENT for a file that has gone
  }

  try {
    // What did we actually open? This is the check that catches a swapped
    // *ancestor* — `.claude` replaced by a link to `/state` — which O_NOFOLLOW
    // on the leaf cannot see. Absent on macOS, where the suite runs; there the
    // realpath below is the best available, and production is Linux.
    const opened = describeFd(fd);
    if (opened !== null) {
      if (!opened.startsWith(base + sep)) return null;
    } else {
      try {
        if (!realpathSync(path).startsWith(realpathSync(base) + sep)) return null;
      } catch {
        return null;
      }
    }

    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return null;

    const start = Math.max(0, stat.size - TAIL_BYTES);
    const want = stat.size - start;
    const buffer = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, start + read);
      if (n <= 0) break;
      read += n;
    }

    const text = buffer.subarray(0, read).toString('utf8');
    // Starting mid-file means the first line is a fragment. Dropping it costs
    // one record and saves parsing half a JSON object as if it were whole.
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * The chat's session, as items. Empty when there is nothing to read.
 *
 * Named `sessionTranscript` and not `transcriptFor` on purpose: `@tulip/shared`
 * already exports a `transcriptFor`, and it is about voice notes. Two functions
 * with the same name and unrelated meanings, one import line apart, is a
 * mistake waiting for somebody in a hurry.
 */
export function sessionTranscript(chatKey: string, root: string = WORKSPACE_MOUNT): TranscriptItem[] {
  const path = findTranscript(chatKey, root);
  if (path === null) return [];
  const text = readTranscriptTail(path, root);
  if (text === null) return [];
  return parseTranscript(text);
}

// ─── Merging ─────────────────────────────────────────────────────────────────

/**
 * One timeline out of two sources, newest last.
 *
 * The messages come from the bridge's own feed and are first-hand; the items
 * come from the agent and are its account of itself. They are interleaved by
 * timestamp because that is the only ordering an operator can reason about —
 * and on a tie the message wins, since `sort` is stable and the messages are
 * concatenated first. That is the right way round: a reply lands in the feed at
 * the moment `tulip-wa` runs, which is the same instant the transcript records
 * the tool call that sent it.
 */
export function mergeTimeline(said: readonly SaidItem[], items: readonly TranscriptItem[], limit: number): ViewItem[] {
  const merged: ViewItem[] = [...said, ...items];
  merged.sort((a, b) => a.ts - b.ts);
  return limit > 0 && merged.length > limit ? merged.slice(-limit) : merged;
}
