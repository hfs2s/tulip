/**
 * The panel's data routes.
 *
 * Split from `panel.ts` so that the file holding authentication, the CSP and
 * the failure throttle stays small enough to read in one sitting. Everything
 * here runs *after* the token check; nothing here re-implements it.
 *
 * Two rules hold across every handler, and both have exceptions worth stating
 * precisely, because each one used to be absolute:
 *
 *   - **Operational routes mutate freely; configuration mutates through exactly
 *     one door.** Hold, release, block, kick and terminal input are ordinary.
 *     Configuration is `POST /api/settings` alone — `updateSettings`, whose
 *     docblock carries the argument for why that door exists and what it cost.
 *     It genuinely does edit who may talk to the agent.
 *   - **Chats carry no phone number; the settings view does.** Every chat here
 *     is an opaque key and a display name, exactly as the agent sees them, and
 *     that is the rule that matters for a page which may be open on a laptop in
 *     a café. The audience, operator and contact lists are the deliberate
 *     exception: an allow list you cannot read is one you cannot audit, and the
 *     operator reading it is the person who wrote it.
 */
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { TerminalRequest, TerminalScreen, inPaths, outPaths, transcriptFor, writeJsonAtomic } from '@tulip/shared';
import { parseConfig, Contact } from './config.js';
import { deletePage, listPages, pagesHost, type PageSummary } from './pages.js';
import { forget, forgetAll, readMemory } from './memory.js';
import type { ChatRegistry } from './chats.js';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { feed, type FeedEntry } from './feed.js';
import { readStatus, readUsage } from './handoff.js';
import { log } from './log.js';
import { paths } from './paths.js';
import type { Limiter } from './ratelimit.js';
import { state } from './state.js';
// The masked chat's other half. `sessionTranscript` is the agent's own Claude
// Code transcript and has nothing to do with `transcriptFor` above, which is a
// voice note's sidecar — see the header of `transcript.ts`.
import { mergeTimeline, sessionTranscript, type SaidItem } from './transcript.js';
import type { WhatsApp } from './whatsapp.js';

export interface ApiDeps {
  readonly config: Config;
  readonly wa: WhatsApp;
  readonly chats: ChatRegistry;
  readonly limiter: Limiter;
  readonly dispatcher: () => Dispatcher;
}

type Json = Record<string, unknown> | unknown[];

const send = (res: ServerResponse, headers: Record<string, string>, status: number, body: Json): void => {
  res.writeHead(status, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/** What the panel is willing to render inline. */
const VIEWABLE: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.bin': 'application/octet-stream',
};

// ─── Overview ────────────────────────────────────────────────────────────────

export function snapshot(deps: ApiDeps): Json {
  const status = readStatus();
  const queue = deps.dispatcher().snapshot();
  const recent = feed.recent(600).filter((e) => e.ts > Date.now() - 24 * 3600 * 1000);

  return {
    now: Date.now(),
    whatsapp: { connected: deps.wa.connected, name: deps.wa.me?.name ?? null },
    agent: {
      reporting: status !== null,
      busyTurn: status?.busyTurn ?? null,
      fatal: status?.fatal ?? null,
      sessions: status?.sessions.length ?? 0,
      // Which chats have a window open, not just how many. The Chat page's
      // conversation list shows a dot per row, and a count cannot say which
      // row it belongs to — the alternative was a transcript fetch per
      // conversation on every poll. Same standing as the rest of this object:
      // the agent's account of itself, displayed and never decided from, and
      // `AgentStatus` caps the array at 64.
      openChats: status?.sessions.map((s) => s.chatKey) ?? [],
    },
    audience: {
      everyone: deps.config.audience.everyone,
      groups: deps.config.groups.enabled,
      groupMode: deps.config.groups.replyTo,
    },
    hold: state.holdInfo(),
    queue,
    // Null until the agent has reported once. The panel says "not reported yet"
    // rather than drawing zeroes, because zero spend and no measurement look
    // identical in a number and mean opposite things.
    usage: readUsage(),
    today: {
      in: recent.filter((e) => e.kind === 'in').length,
      accepted: recent.filter((e) => e.kind === 'in' && e.accepted === true).length,
      refused: recent.filter((e) => e.kind === 'in' && e.accepted === false).length,
      out: recent.filter((e) => e.kind === 'out').length,
    },
    chats: deps.chats
      .all()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((c) => ({
        chatKey: c.chatKey,
        name: c.name,
        isGroup: c.isGroup,
        blocked: c.blocked,
        // The `ChatRecord` docblock promises the panel says which rows an
        // operator put there by hand. It never sent the flag, so a contact just
        // added sat at the top of Chats with zero messages, indistinguishable
        // from a stranger who had only just written in.
        contact: c.contact,
        messages: c.messages,
        firstSeenAt: c.firstSeenAt,
        lastSeenAt: c.lastSeenAt,
        turnsToday: deps.limiter.stats(c.chatKey)?.turnsToday ?? 0,
      })),
  };
}

// ─── One chat's history ──────────────────────────────────────────────────────

export function chatHistory(deps: ApiDeps, chatKey: string, limit: number): Json {
  const record = deps.chats.get(chatKey);
  const messages = feed
    .recent(4000)
    .filter((e) => e.chatKey === chatKey && (e.kind === 'in' || e.kind === 'out'))
    .slice(-limit);

  return {
    chat: record
      ? {
          chatKey: record.chatKey,
          name: record.name,
          isGroup: record.isGroup,
          blocked: record.blocked,
          messages: record.messages,
          firstSeenAt: record.firstSeenAt,
          lastSeenAt: record.lastSeenAt,
        }
      : null,
    limits: deps.limiter.stats(chatKey),
    messages,
  };
}

// ─── One chat, as a conversation ─────────────────────────────────────────────

/**
 * The masked chat: the agent's live session for one chat, rendered as a
 * conversation rather than as a terminal.
 *
 * Two sources, and the difference between them is the whole point of the shape:
 *
 *   · **The messages** come from the bridge's own feed. They are first-hand —
 *     the bridge received them and the bridge sent them — and they are the
 *     conversation that actually happened on WhatsApp.
 *   · **The session items** come from `bridge/src/transcript.ts`, which reads a
 *     file the untrusted container wrote. They are the agent's account of
 *     itself, on exactly the same footing as `status.json`: displayed, never
 *     decided from. Read that module's header before changing anything here.
 *
 * `live` is what gates sending. It comes from the agent's status report, which
 * is advisory everywhere else — here it is load-bearing for a reason given in
 * `sendToChat`, and the failure mode of trusting it is a refused send rather
 * than a misdirected one.
 */
export function chatTranscript(deps: ApiDeps, chatKey: string, limit: number): Json {
  const record = deps.chats.get(chatKey);
  if (record === null) return { ok: false, message: 'No such chat.' };

  const said: SaidItem[] = feed
    .recent(4000)
    .filter((e) => e.chatKey === chatKey && (e.kind === 'in' || e.kind === 'out'))
    .map((e) => ({
      ts: e.ts,
      kind: 'said' as const,
      direction: e.kind === 'out' ? ('out' as const) : ('in' as const),
      who: e.kind === 'out' ? 'Juan' : (e.from ?? e.chatName ?? 'Someone'),
      text: e.text ?? (e.detail ? `(${e.detail})` : ''),
    }));

  const status = readStatus();
  return {
    ok: true,
    chat: {
      chatKey: record.chatKey,
      name: record.name,
      isGroup: record.isGroup,
      blocked: record.blocked,
      messages: record.messages,
      lastSeenAt: record.lastSeenAt,
    },
    // Whether a tmux window exists for this chat right now. Without one there
    // is nothing to type into — see `sendToChat`.
    live: status?.sessions.some((s) => s.chatKey === chatKey) ?? false,
    reporting: status !== null,
    items: mergeTimeline(said, sessionTranscript(chatKey), limit),
  };
}

/**
 * Type a line into the agent's session for one chat.
 *
 * This reuses the terminal's path — `terminalKeys` — rather than opening a
 * second one, so there is one place where a keystroke can reach a live
 * conversation and one place to get it right. Three refusals stand in front of
 * it, and the second is the one that matters:
 *
 *   · the chat key must be a chat we issued a key for;
 *   · **the chat must have a live window.** `resolveWindow` in the supervisor
 *     falls back to the busy window, then the most recent session, then
 *     `windows[0]` when the window it was asked for is not open. That fallback
 *     is right for a terminal following whatever is active and catastrophic
 *     here: a message meant for a sleeping chat would be typed into whichever
 *     stranger happened to be talking. So a chat with no window is refused, and
 *     the operator is told to wait for the person's next message;
 *   · the line must be one line. `send-keys -l` types a newline as a newline,
 *     and the TUI reads that as submit — so a pasted paragraph would send its
 *     first line as a prompt and leave the rest typed at a stale one.
 *
 * The Enter is sent as a key rather than as a newline in the text, for the same
 * reason `sendLine` does it in `agent/src/tmux.ts`.
 */
export function sendToChat(deps: ApiDeps, chatKey: string, raw: string): { ok: boolean; message: string } {
  if (!/^[0-9a-f]{16}$/.test(chatKey)) return { ok: false, message: 'A 16-character chat key is required.' };
  if (deps.chats.get(chatKey) === null) return { ok: false, message: 'No such chat.' };

  const line = typedLine(raw);
  if (line.length === 0) return { ok: false, message: 'Nothing to send.' };
  if (line.length > MAX_TYPED) {
    return { ok: false, message: `That is longer than ${MAX_TYPED} characters. Say it in fewer.` };
  }

  const status = readStatus();
  if (status === null) return { ok: false, message: 'The agent is not reporting. Nothing would be typed.' };
  if (!status.sessions.some((s) => s.chatKey === chatKey)) {
    return {
      ok: false,
      message: 'This chat has no session open, so there is nowhere to type. It wakes on their next message.',
    };
  }

  const window = `c-${chatKey}`;
  const result = terminalKeys(window, [
    { text: line, literal: true },
    { text: 'Enter', literal: false },
  ]) as { ok?: boolean; message?: string };
  if (result.ok === false) return { ok: false, message: result.message ?? 'The keystrokes could not be written.' };

  log('chat.typed', { chatKey, window, chars: line.length });
  feed.event('operator.typed', `${chatKey} — ${line.slice(0, 160)}`);
  return { ok: true, message: 'Typed into the session.' };
}

/** Matches `TerminalRequest`'s own per-key cap, so nothing is silently trimmed. */
const MAX_TYPED = 2000;

/**
 * Flatten what an operator typed into the single line tmux will type.
 *
 * Collapsing rather than refusing, because a pasted two-line note is a normal
 * thing to want to send and "your message contains a newline" is a bad answer
 * to it. What the operator confirms in the panel is this exact line, not what
 * they typed, so nothing is changed behind their back.
 */
export function typedLine(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Media ───────────────────────────────────────────────────────────────────

/**
 * Every attachment, both directions, newest first.
 *
 * Read from the filesystem rather than from the feed: the files are the record.
 * A gallery driven off the log would go blank the moment the log rotated.
 *
 * The two roots are separate volumes on purpose — inbound lives in the handoff
 * the agent can read, outbound in the bridge-only state volume, so the agent
 * cannot read back what it generated. See `mediaStore.ts`.
 */
const ROOTS = { in: inPaths.media, out: paths.mediaOut } as const;

const isTranscript = (name: string): boolean => name.endsWith('.txt');

/**
 * The path of one attachment, or null if the request cannot name one.
 *
 * Shared by every route that touches a file, because "which file did they
 * mean" is exactly the question a second implementation gets subtly wrong. The
 * chat key and name are pattern-checked so nothing from the browser is
 * concatenated into a path that could climb out, and the resolved path is
 * re-checked against the root regardless — the same belt and braces the outbox
 * file resolver uses, for the same reason.
 */
export function resolveMedia(chatKey: string, name: string, direction: string): string | null {
  if (!/^[0-9a-f]{16}$/.test(chatKey)) return null;
  if (name !== basename(name) || name.startsWith('.')) return null;
  // Chosen from a fixed pair rather than built from the parameter, so an
  // unexpected value can only fail to match — it can never name a third root.
  if (direction !== 'in' && direction !== 'out') return null;

  const root = resolve(ROOTS[direction]);
  const candidate = resolve(root, chatKey, name);
  if (!candidate.startsWith(root + sep)) return null;
  return candidate;
}

export function mediaList(deps: ApiDeps, limit: number): Json {
  const items: Array<Record<string, unknown>> = [];

  for (const [direction, root] of Object.entries(ROOTS)) {
    let directories: string[] = [];
    try {
      directories = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const chatKey of directories) {
      const record = deps.chats.get(chatKey);
      let names: string[] = [];
      try {
        names = readdirSync(join(root, chatKey));
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(root, chatKey, name);
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        // A sidecar belongs to the recording beside it, not in the list as an
        // attachment of its own.
        if (isTranscript(name)) continue;
        const mime = VIEWABLE[extname(name).toLowerCase()] ?? 'application/octet-stream';
        let transcript: string | null = null;
        try {
          // Capped: this is a caption on a tile, not the transcript of a lecture.
          transcript = readFileSync(transcriptFor(full), 'utf8').slice(0, 4000).trim() || null;
        } catch {
          /* not a voice note, or transcription was not configured when it arrived */
        }
        items.push({
          chatKey,
          chatName: record?.name ?? null,
          name,
          direction,
          mime,
          kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file',
          bytes: stat.size,
          at: stat.mtimeMs,
          transcript,
        });
      }
    }
  }

  items.sort((a, b) => (b['at'] as number) - (a['at'] as number));
  return { total: items.length, items: items.slice(0, limit) };
}

/**
 * Serve one attachment.
 *
 * The chat key and file name are separate parameters and are both pattern-
 * checked, so nothing the browser sends is concatenated into a path that could
 * climb out of the media directory. The resolved path is re-checked against the
 * root regardless — the same belt-and-braces the outbox file resolver uses,
 * for the same reason.
 */
export function mediaFile(
  res: ServerResponse,
  headers: Record<string, string>,
  chatKey: string,
  name: string,
  direction: string,
): void {
  const candidate = resolveMedia(chatKey, name, direction);
  if (candidate === null) {
    res.writeHead(400, { ...headers, 'content-type': 'text/plain' }).end('bad request\n');
    return;
  }
  if (!existsSync(candidate)) {
    res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('not found\n');
    return;
  }
  const mime = VIEWABLE[extname(name).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    ...headers,
    'content-type': mime,
    'content-length': statSync(candidate).size,
    // Attachments are private message content; never let a shared cache hold one.
    'cache-control': 'private, max-age=300',
  });
  createReadStream(candidate).pipe(res);
}

/**
 * Delete one attachment, and whatever was said in it.
 *
 * There is no trash and nothing keeps a copy, so this is final — which is why
 * the panel confirms before calling it and why it is recorded in the feed. The
 * transcript goes with the recording rather than outliving it: a voice note
 * an operator deleted should not leave its words behind in the list.
 *
 * Deliberately narrow. It removes one named file inside one chat's media
 * directory and cannot be asked to remove a directory, a chat, or anything
 * outside those roots — `resolveMedia` is the only way a path is produced here.
 */
export function deleteMedia(chatKey: string, name: string, direction: string): { ok: boolean; message: string } {
  const target = resolveMedia(chatKey, name, direction);
  if (target === null) return { ok: false, message: 'That is not an attachment this panel can name.' };
  if (!existsSync(target)) return { ok: false, message: 'It is already gone.' };

  try {
    unlinkSync(target);
  } catch (err) {
    return { ok: false, message: String((err as Error).message) };
  }
  try {
    unlinkSync(transcriptFor(target));
  } catch {
    /* most attachments have no transcript, and a leftover sidecar is not worth failing for */
  }

  log('media.deleted', { chatKey, direction, name });
  feed.event('media.deleted', `an attachment was deleted from the panel (${direction === 'out' ? 'sent' : 'received'})`);
  return { ok: true, message: 'Deleted.' };
}

// ─── Pages ───────────────────────────────────────────────────────────────────

/**
 * What the agent has published, so an operator can see it and remove it.
 *
 * The listing exists because these are public and agent-authored: the first
 * thing an operator needs is to know one was made, and the second is to be able
 * to take it down without a shell.
 */
export function pagesList(): Json {
  const host = pagesHost();
  return {
    host,
    items: listPages().map((p: PageSummary) => ({ ...p, url: host === null ? null : `https://${host}/${p.slug}/` })),
  };
}

export function pageDelete(slug: string): { ok: boolean; message: string } {
  if (!deletePage(slug)) return { ok: false, message: 'No such page.' };
  feed.event('page.deleted', `the page ${slug} was removed`);
  return { ok: true, message: 'Deleted.' };
}

// ─── Persona ─────────────────────────────────────────────────────────────────

/** The four files, in the order they are assembled into the agent's brief. */
const PERSONA_PARTS = ['IDENTITY.md', 'VOICE.md', 'OPERATING.md', 'BOUNDARIES.md'] as const;
const PERSONA_DIR = process.env['TULIP_PERSONA_DOCS'] ?? '/persona';

/**
 * What Tulip has been told to be, for reading.
 *
 * Read-only, deliberately. These files are version-controlled and reach a
 * conversation only when its session next spawns, so an editor here would
 * promise something it could not deliver — a change that appears saved and
 * takes effect at some unrelated moment. Editing belongs in the repository,
 * where it is reviewed and can be reverted.
 */
export function personaDocs(): Json {
  const parts = PERSONA_PARTS.map((name) => {
    try {
      const path = join(PERSONA_DIR, name);
      return { name, text: readFileSync(path, 'utf8'), bytes: statSync(path).size };
    } catch {
      return { name, text: null, bytes: 0 };
    }
  });
  return { parts, total: parts.reduce((sum, p) => sum + p.bytes, 0) };
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * What the agent has been told to remember, and where each note came from.
 *
 * The listing exists because this is the one piece of state that reaches every
 * conversation. Anyone who can message the number can ask for something to be
 * remembered, so an operator needs to see what is in there and be able to take
 * it out.
 */
export function memoryList(): Json {
  return { notes: readMemory() };
}

export function memoryForget(id: string): { ok: boolean; message: string } {
  if (id === 'all') {
    const removed = forgetAll();
    feed.event('memory.cleared', `${String(removed)} remembered notes were removed`);
    return { ok: true, message: `Forgot ${String(removed)}.` };
  }
  if (!forget(id)) return { ok: false, message: 'No such note.' };
  feed.event('memory.forgot', 'a remembered note was removed');
  return { ok: true, message: 'Forgotten.' };
}

// ─── Log ─────────────────────────────────────────────────────────────────────

/** The writer's naming, from `log.ts`. ISO dates sort lexicographically. */
const LOG_FILE = /^tulip-\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * How many day files one request may open.
 *
 * Two is enough to cross a midnight, three leaves room for a quiet day in
 * between. The cap is the whole reason this is not "read them all": the panel
 * is a long-lived deployment on a Pi, and `?n=1000` against a year of logs is a
 * request that reads the disk.
 */
const MAX_LOG_FILES = 3;

/**
 * The tail of the structured log, read **backwards across day files**.
 *
 * The obvious implementation opens today's file and stops, and it is wrong for
 * a reason that only shows up at 00:00 UTC: `log.ts` names files by UTC date,
 * so at the boundary the file this would ask for does not exist yet. A missing
 * file reads as no rows, and an empty Logs page is indistinguishable from a
 * broken deployment — observed live, blank from 00:02 until the next line was
 * written at 00:03. The operator is in CEST, where that is 02:00 local, in the
 * middle of an evening's work. `n` could not be satisfied across the boundary
 * either: one minute past midnight the whole previous day was unreachable
 * through the panel with the file sitting right there.
 *
 * So: newest file first, accumulate until there are enough rows, return them in
 * chronological order. Do not simplify this back to today-only.
 *
 * Total by construction — a missing directory, an unreadable file and a line
 * that is not JSON each degrade to less output rather than to an error. This is
 * an observability surface; it must not be the thing that breaks.
 */
export function logTail(lines: number): Json {
  const want = Math.max(Math.trunc(lines), 0);
  if (want === 0) return [];

  let names: string[];
  try {
    names = readdirSync(paths.logs).filter((name) => LOG_FILE.test(name)).sort().reverse();
  } catch {
    return [];
  }

  const rows: string[] = [];
  for (const name of names.slice(0, MAX_LOG_FILES)) {
    if (rows.length >= want) break;
    let text: string;
    try {
      text = readFileSync(join(paths.logs, name), 'utf8');
    } catch {
      continue;
    }
    // Blank lines are dropped rather than parsed: an empty file would otherwise
    // spend a row of the budget on an `unparsed` entry with nothing in it.
    const day = text.split('\n').filter((line) => line.length > 0);
    rows.unshift(...day.slice(-(want - rows.length)));
  }

  return rows.map((line): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      return { at: '', event: 'unparsed', raw: line.slice(0, 200) };
    }
  });
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * What the deployment is currently configured to do.
 *
 * Reading is separated from writing only because they are different HTTP verbs;
 * both are exposed. See `updateSettings` below for why the panel writes
 * configuration at all, and what backs that decision.
 */
export function settingsView(deps: ApiDeps): Json {
  const c = deps.config;
  return {
    // The actual values, not counts. An allow list you cannot read is one you
    // cannot audit, and the panel already sits behind whatever authenticates
    // in front of it — hiding the numbers from the operator protects nobody.
    audience: { everyone: c.audience.everyone, numbers: c.audience.numbers, jids: c.audience.jids },
    operators: { numbers: c.operators.numbers, jids: c.operators.jids },
    agent: c.agent,
    groups: c.groups,
    limits: c.limits,
    delivery: c.delivery,
    panel: { host: c.panel.host, port: c.panel.port },
    // `keyed` is whether a credential exists; `agent.*` is whether the operator
    // permits it. A capability needs both, and the panel shows which is missing.
    tools: {
      keyed: {
        search: (process.env['EXA_API_KEY'] ?? '').length > 0,
        gifs: (process.env['GIPHY_API_KEY'] ?? '').length > 0,
        images: (process.env['MINIMAX_API_KEY'] ?? '').length > 0,
        voice: (process.env['MINIMAX_API_KEY'] ?? '').length > 0,
      },
      gifRating: process.env['GIPHY_RATING'] ?? 'pg',
    },
    model: {
      name: process.env['TULIP_MODEL'] || 'default',
      provider: process.env['ANTHROPIC_BASE_URL'] || 'api.anthropic.com',
    },
  };
}

/**
 * What the panel may change.
 *
 * This reverses an earlier decision, deliberately and with the cost written
 * down. The panel used to expose nothing that wrote configuration, on the
 * grounds that it removed the class of "the panel was reachable and someone
 * opened the allowlist". That is a real protection and it is now gone: an
 * attacker holding the panel token *can* open this bot to the world.
 *
 * It was traded for something an operator genuinely needs — a console where the
 * controls work, rather than a row of disabled switches with no explanation.
 * What backs it instead:
 *
 *   - every change is written to the feed and the structured log, with the old
 *     and new values, so opening the audience is loud rather than silent;
 *   - the panel is not reachable without both the bearer token and whatever
 *     authenticates in front of it (Cloudflare Access, in this deployment);
 *   - `panel.*` is deliberately absent below. The bind address decides who can
 *     reach this surface at all, and a surface that can widen its own exposure
 *     is a different kind of mistake.
 *
 * See docs/THREAT-MODEL.md §T7.
 */
const PhoneNumber = z.string().regex(/^[1-9][0-9]{6,15}$/, 'bare international digits, no + or spaces');
const LinkedId = z.string().regex(/^[0-9]{5,25}(@lid)?$/, 'digits, optionally @lid');

const SettingsPatch = z
  .object({
    audience: z.object({
      everyone: z.boolean().optional(),
      numbers: z.array(PhoneNumber).max(500).optional(),
      jids: z.array(LinkedId).max(500).optional(),
    }).strict().optional(),
    operators: z.object({
      numbers: z.array(PhoneNumber).max(50).optional(),
      jids: z.array(LinkedId).max(50).optional(),
    }).strict().optional(),
    groups: z.object({
      enabled: z.boolean().optional(),
      replyTo: z.enum(['mention', 'trigger', 'observe']).optional(),
      triggers: z.array(z.string().min(1).max(32)).max(8).optional(),
    }).strict().optional(),
    limits: z.object({
      messagesPerHour: z.number().int().min(1).max(1000).optional(),
      burst: z.number().int().min(1).max(50).optional(),
      turnsPerDay: z.number().int().min(1).max(10_000).optional(),
      maxInboundChars: z.number().int().min(200).max(100_000).optional(),
      maxMediaBytes: z.number().int().min(1024).max(100 * 1024 * 1024).optional(),
      maxMediaPerMessage: z.number().int().min(0).max(10).optional(),
      newSendersPerHour: z.number().int().min(1).max(1000).optional(),
      imagesPerDay: z.number().int().min(0).max(1000).optional(),
      transcriptionsPerDay: z.number().int().min(0).max(5000).optional(),
      outboundPerTurn: z.number().int().min(1).max(100).optional(),
      outboundPerChatPerHour: z.number().int().min(1).max(1000).optional(),
      turnTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
    }).strict().optional(),
    delivery: z.object({
      debounceMs: z.number().int().min(0).max(60_000).optional(),
      maxBatch: z.number().int().min(1).max(50).optional(),
      stuckAfterMs: z.number().int().min(0).max(3_600_000).optional(),
    }).strict().optional(),
    /** Cross-chat sending. Off by default; see THREAT-MODEL §T4. */
    agent: z.object({
      crossChat: z.boolean().optional(),
      search: z.boolean().optional(),
      gifs: z.boolean().optional(),
      images: z.boolean().optional(),
      voice: z.boolean().optional(),
      voiceId: z.string().max(128).regex(/^[A-Za-z0-9_-]*$/, 'letters, digits, dashes and underscores only').optional(),
      /**
       * Imported from `config.ts` rather than restated. This one decides who a
       * machine holding a shell may open a conversation with, and a second copy
       * of that rule is a copy that will eventually disagree with the first.
       */
      contacts: z.array(Contact).max(50).optional(),
    }).strict().optional(),
  })
  .strict();

const CONFIG_FILE = process.env['TULIP_CONFIG'] ?? '/config/config.json';

/**
 * Apply a settings change.
 *
 * Merged into the live config object *in place*, because every component holds
 * a reference to it — mutating is what makes a change take effect without a
 * restart that would drop the WhatsApp socket.
 *
 * The file is rewritten from its own raw contents rather than from the parsed
 * object, so the `_comment` keys that document it survive the round trip.
 */
export function updateSettings(deps: ApiDeps, body: unknown): { ok: boolean; message: string } {
  const patch = SettingsPatch.safeParse(body);
  if (!patch.success) {
    return { ok: false, message: patch.error.issues[0]?.message ?? 'invalid settings' };
  }

  // Validate the *result*, not just the patch: a field may be individually
  // valid and still produce a configuration the rest of the system rejects.
  const merged = structuredClone(deps.config) as Record<string, unknown>;
  for (const [section, values] of Object.entries(patch.data)) {
    merged[section] = { ...(merged[section] as object), ...values };
  }
  let next;
  try {
    next = parseConfig(merged);
  } catch (err) {
    return { ok: false, message: String((err as Error).message).split('\n').slice(0, 2).join(' ') };
  }

  const before = {
    everyone: deps.config.audience.everyone,
    allowed: deps.config.audience.numbers.length + deps.config.audience.jids.length,
    groups: deps.config.groups.enabled,
  };

  // Write first, then apply. The other order leaves the running config and the
  // file disagreeing whenever the write fails — a setting that looks saved,
  // works until the next restart, and then silently reverts. A failed save must
  // change nothing at all.
  //
  // The raw file is edited rather than the parsed object so the `_comment` keys
  // that document it survive the round trip.
  //
  // "Absent" and "unreadable" must not be the same case. A parse failure on a
  // file that exists — a hand edit with a trailing comma, which OPERATIONS.md
  // actively invites — would otherwise leave `raw` empty and the atomic write
  // would replace the whole file with just the patched section. Every other
  // section would come back as a schema default on the next restart, which
  // silently sets `audience.everyone` to false and empties `operators`. That is
  // a config wipe reported as `Saved.`, so it is refused instead.
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('settings.rawUnreadable', { err: String((err as Error).message) });
      return {
        ok: false,
        message:
          `${CONFIG_FILE} exists but is not valid JSON, so nothing was changed. ` +
          'Fix the file by hand and restart the bridge, or the next save would overwrite every other section.',
      };
    }
    /* genuinely absent: this is the first write */
  }
  for (const [section, values] of Object.entries(patch.data)) {
    raw[section] = { ...(raw[section] as object), ...values };
  }
  try {
    writeJsonAtomic(CONFIG_FILE, raw, 0o600);
  } catch (err) {
    log('settings.writeFailed', { err: String((err as Error).message) });
    return {
      ok: false,
      message: 'Could not write the configuration file, so nothing changed: ' + String((err as Error).message),
    };
  }

  Object.assign(deps.config, next);

  // Contacts are the one setting with state behind it: a destination has to
  // exist in the chat registry before the agent can be given a key for it.
  // Re-synced here rather than on the next restart, so "add a contact" and
  // "the agent can write to them" are the same action.
  if (patch.data.agent?.contacts !== undefined) {
    deps.chats.syncContacts(next.agent.contacts, Date.now());
    deps.chats.flush();
  }

  const after = {
    everyone: next.audience.everyone,
    allowed: next.audience.numbers.length + next.audience.jids.length,
    groups: next.groups.enabled,
  };
  log('settings.changed', {
    sections: Object.keys(patch.data).join(','),
    everyone: `${before.everyone} -> ${after.everyone}`,
    allowed: `${before.allowed} -> ${after.allowed}`,
    groups: `${before.groups} -> ${after.groups}`,
  });
  feed.event('settings.changed', Object.keys(patch.data).join(', ') + ' updated from the panel');
  if (!before.everyone && after.everyone) {
    feed.event('audience.opened', 'this number now answers anyone who messages it');
  }

  return { ok: true, message: 'Saved.' };
}

// ─── Terminal ────────────────────────────────────────────────────────────────

/**
 * The terminal is a file exchange, not a socket.
 *
 * The bridge and the agent share no network — Docker will not publish a port
 * into an `internal` network, and proxying a shell through the bridge would
 * give the agent a route to the container holding the WhatsApp credentials. So
 * the panel's keystrokes become a request file and the agent's pane comes back
 * over the volumes that already carry everything else.
 *
 * What comes back is a *stream*, not a series of frames. `screen.json` is still
 * written and still read by the rest of the panel, but the terminal itself
 * reads `pane.raw` — the bytes the pane emitted, escape sequences and all,
 * forwarded to a terminal emulator in the browser. That is the difference
 * between a summary of the session and the session: a TUI is cursor movements,
 * and no amount of polling stripped text will reconstruct one.
 */
/** Every key ever sent. The last entry of `pending` has this index. */
let keySeq = 0;
/** How many recent keys travel in each request. The schema's own cap is 32. */
const KEY_WINDOW = 32;
/**
 * A sliding window of recent keys, resent with every write of the request file.
 *
 * There is one request file and the bridge rewrites all of it — for a new
 * keystroke, and every thirty seconds to renew the watch. Sending only the
 * newest key would mean any keystroke the agent had not yet collected was
 * overwritten and lost, which at a 250ms tick is most of them once somebody
 * types at speed.
 *
 * So a window is resent instead, and the agent skips what it has already
 * typed by each key's own index — `keySeq - keys.length + 1` gives the first.
 * Resending is free, and nothing is lost unless more than `KEY_WINDOW` keys
 * are sent inside one tick. A paste is one entry rather than one per
 * character, so that bound is about typing speed, not message length.
 */
let pending: Array<{ text: string; literal: boolean }> = [];

export function terminalScreen(): Json {
  try {
    const parsed = TerminalScreen.safeParse(JSON.parse(readFileSync(outPaths.screen, 'utf8')));
    if (parsed.success) return { ...parsed.data, pendingSeq: keySeq };
  } catch {
    /* the agent has not published one yet */
  }
  return { at: null, window: null, windows: [], content: '', keySeq: 0, pendingSeq: keySeq };
}

/** Ask the agent to keep capturing, and optionally switch window. */
export function terminalWatch(window: string | null, seconds: number): Json {
  return writeTerminal(window, seconds, pending);
}

/**
 * Type into the agent's terminal.
 *
 * This types into a live conversation with a member of the public, which is why
 * the panel confirms before it will do it. The sequence number makes delivery
 * exactly-once across a polled file: the agent ignores anything at or below what
 * it has already applied.
 */
export function terminalKeys(window: string | null, keys: Array<{ text: string; literal: boolean }>): Json {
  keySeq += keys.length;
  pending = [...pending, ...keys].slice(-KEY_WINDOW);
  if (window !== null) {
    aimWindow = window;
    aimSeq = keySeq;
    aimSince = Date.now();
  }
  log('terminal.send', { window, count: keys.length, seq: keySeq });
  return writeTerminal(window, 120, pending);
}

/**
 * Keys addressed to a named window, held there until the agent has typed them.
 *
 * There is one request file, and it carries one window for the whole sliding
 * key window. That is fine while every writer asks for `null` — "follow the
 * active chat" — and becomes a cross-chat mis-delivery the moment one of them
 * names a window, which the Chat page does:
 *
 *   1. the Chat page writes `{ window: 'c-<A>', keys: [...] }`;
 *   2. before the agent's 250ms tick collects it, the Terminal page's own
 *      stream renews its watch and rewrites the file as `{ window: null, keys:
 *      [same keys] }` — `terminalWatch` resends `pending` unchanged;
 *   3. the agent resolves `null` to whichever chat is busy, and types A's
 *      message into B's conversation.
 *
 * `keysToApply` does not help: those keys are still unapplied, so they are
 * still eligible. So the aim is sticky. Until the agent reports having applied
 * everything up to `aimSeq` — it publishes its applied count in `screen.json`
 * — a watch renewal cannot move the window off the chat the keys were meant
 * for. The wall-clock cap is there because the agent may never report at all,
 * and pinning the operator's terminal to a dead window forever is a worse
 * failure than the one being fixed.
 */
let aimWindow: string | null = null;
let aimSeq = 0;
let aimSince = 0;
const AIM_HOLD_MS = 20_000;

/** The highest key index the agent says it has typed. Zero if it has not said. */
function appliedSeq(): number {
  try {
    const parsed = TerminalScreen.safeParse(JSON.parse(readFileSync(outPaths.screen, 'utf8')));
    return parsed.success ? parsed.data.keySeq : 0;
  } catch {
    return 0;
  }
}

/** The window this write must name, which is not always the one it asked for. */
function aim(requested: string | null): string | null {
  if (aimWindow === null) return requested;
  if (Date.now() - aimSince > AIM_HOLD_MS || appliedSeq() >= aimSeq) {
    aimWindow = null;
    return requested;
  }
  return aimWindow;
}

function writeTerminal(requested: string | null, seconds: number, keys: Array<{ text: string; literal: boolean }>): Json {
  const window = aim(requested);
  const request = TerminalRequest.safeParse({
    window,
    watchUntil: new Date(Date.now() + seconds * 1000).toISOString(),
    keySeq,
    keys,
  });
  if (!request.success) return { ok: false, message: 'invalid terminal request' };
  try {
    writeJsonAtomic(inPaths.terminal, request.data, 0o644);
    return { ok: true, keySeq };
  } catch (err) {
    return { ok: false, message: String((err as Error).message) };
  }
}

/** Read back at most this much per tick, so one catch-up cannot block the loop. */
const PANE_CHUNK_BYTES = 256 * 1024;
const NO_BYTES = Buffer.alloc(0);

export interface PaneChunk {
  /** The stream restarted: clear the screen before writing `bytes`. */
  reset: boolean;
  bytes: Buffer;
}

/**
 * A cursor over the agent's pane stream.
 *
 * Tails `pane.raw` by byte offset, which is all a terminal needs — the bytes
 * are already in the order the pane emitted them. The one interesting case is
 * truncation: the agent shortens the file whenever it repaints, either because
 * the followed window changed or because the cap was reached, and a file now
 * smaller than the offset we hold is unambiguously a new stream rather than a
 * gap in an old one.
 *
 * Detecting that by size rather than by a marker in the bytes is deliberate.
 * The pane's contents are chosen by an agent that reads messages from strangers
 * and can emit any byte sequence at all, so there is no in-band marker it could
 * not forge. A file length is not something it can write.
 *
 * One reader per viewer: the offset is the viewer's position, not the file's.
 */
export function paneReader(file: string = outPaths.pane): () => PaneChunk {
  let offset = 0;
  return (): PaneChunk => {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      // Not there. The agent starts the stream when it sees somebody watching,
      // so this is the ordinary state for the first tick of a connection.
      offset = 0;
      return { reset: false, bytes: NO_BYTES };
    }

    let reset = false;
    if (size < offset) {
      offset = 0;
      reset = true;
    }
    if (size === offset) return { reset, bytes: NO_BYTES };

    const want = Math.min(size - offset, PANE_CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(want);
    let fd: number | null = null;
    let read = 0;
    try {
      fd = openSync(file, 'r');
      read = readSync(fd, buffer, 0, want, offset);
    } catch {
      return { reset, bytes: NO_BYTES };
    } finally {
      if (fd !== null) closeSync(fd);
    }

    offset += read;
    return { reset, bytes: buffer.subarray(0, read) };
  };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export function runAction(deps: ApiDeps, action: string, key: string): { ok: boolean; message: string } {
  switch (action) {
    case 'hold':
      state.setHold(true, 'panel');
      feed.event('hold.on', 'delivery held from the panel');
      return { ok: true, message: 'Holding. Messages keep arriving and are recorded.' };

    case 'release':
      state.setHold(false, 'panel');
      feed.event('hold.off', 'delivery released from the panel');
      void deps.dispatcher().pump();
      return { ok: true, message: 'Released.' };

    case 'pump':
      void deps.dispatcher().pump();
      return { ok: true, message: 'Delivery loop kicked.' };

    case 'block':
    case 'unblock': {
      if (!/^[0-9a-f]{16}$/.test(key)) return { ok: false, message: 'A 16-character chat key is required.' };
      if (!deps.chats.setBlocked(key, action === 'block')) return { ok: false, message: 'No such chat.' };
      deps.chats.flush();
      feed.event(action === 'block' ? 'chat.blocked' : 'chat.unblocked', key);
      return { ok: true, message: action === 'block' ? 'Blocked.' : 'Unblocked.' };
    }

    default:
      return { ok: false, message: `Unknown action: ${action}` };
  }
}

export { send, type FeedEntry };
