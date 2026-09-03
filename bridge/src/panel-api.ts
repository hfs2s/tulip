/**
 * The panel's data routes.
 *
 * Split from `panel.ts` so that the file holding authentication, the CSP and
 * the failure throttle stays small enough to read in one sitting. Everything
 * here runs *after* the token check; nothing here re-implements it.
 *
 * Two rules hold across every handler:
 *
 *   - **Read-mostly.** The only mutating routes are operational — hold, release,
 *     block, kick delivery, and typing into the terminal. Nothing here edits who
 *     may talk to the agent; that lives in a file on disk, which removes the
 *     whole class of "the panel was reachable and someone opened the allowlist".
 *   - **No phone numbers leave.** The panel is a browser page that may be open
 *     on a laptop in a café. Chats are identified by their opaque key and their
 *     display name, exactly as the agent sees them.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { z } from 'zod';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { TerminalRequest, TerminalScreen, inPaths, outPaths, writeJsonAtomic } from '@tulip/shared';
import { parseConfig } from './config.js';
import type { ChatRegistry } from './chats.js';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { feed, type FeedEntry } from './feed.js';
import { readStatus } from './handoff.js';
import { log } from './log.js';
import { paths } from './paths.js';
import type { Limiter } from './ratelimit.js';
import { state } from './state.js';
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
    },
    audience: {
      everyone: deps.config.audience.everyone,
      groups: deps.config.groups.enabled,
      groupMode: deps.config.groups.replyTo,
    },
    hold: state.holdInfo(),
    queue,
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

// ─── Media ───────────────────────────────────────────────────────────────────

/**
 * Everything people have sent, newest first.
 *
 * Read from the filesystem rather than from the feed: the files are the record.
 * A gallery driven off the log would go blank the moment the log rotated.
 */
export function mediaList(deps: ApiDeps, limit: number): Json {
  const items: Array<Record<string, unknown>> = [];
  let directories: string[] = [];
  try {
    directories = readdirSync(inPaths.media, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { total: 0, items: [] };
  }

  for (const chatKey of directories) {
    const record = deps.chats.get(chatKey);
    let names: string[] = [];
    try {
      names = readdirSync(join(inPaths.media, chatKey));
    } catch {
      continue;
    }
    for (const name of names) {
      const full = join(inPaths.media, chatKey, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const mime = VIEWABLE[extname(name).toLowerCase()] ?? 'application/octet-stream';
      items.push({
        chatKey,
        chatName: record?.name ?? null,
        name,
        mime,
        kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file',
        bytes: stat.size,
        at: stat.mtimeMs,
      });
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
export function mediaFile(res: ServerResponse, headers: Record<string, string>, chatKey: string, name: string): void {
  if (!/^[0-9a-f]{16}$/.test(chatKey) || name !== basename(name) || name.startsWith('.')) {
    res.writeHead(400, { ...headers, 'content-type': 'text/plain' }).end('bad request\n');
    return;
  }
  const root = resolve(inPaths.media);
  const candidate = resolve(root, chatKey, name);
  if (!candidate.startsWith(root + sep) || !existsSync(candidate)) {
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

// ─── Log ─────────────────────────────────────────────────────────────────────

export function logTail(lines: number): Json {
  const file = join(paths.logs, `tulip-${new Date().toISOString().slice(0, 10)}.jsonl`);
  try {
    return readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .slice(-lines)
      .map((line): unknown => {
        try {
          return JSON.parse(line);
        } catch {
          return { at: '', event: 'unparsed', raw: line.slice(0, 200) };
        }
      });
  } catch {
    return [];
  }
}

// ─── Settings (read-only) ────────────────────────────────────────────────────

/**
 * What the deployment is currently configured to do.
 *
 * Read-only, deliberately, and the page says so. The audience and the operator
 * list are shown as counts rather than values: this is a browser page, and the
 * values are phone numbers.
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
    tools: {
      search: (process.env['EXA_API_KEY'] ?? '').length > 0,
      gifs: (process.env['GIPHY_API_KEY'] ?? '').length > 0,
      gifRating: process.env['GIPHY_RATING'] ?? 'pg',
      images: (process.env['MINIMAX_API_KEY'] ?? '').length > 0,
      voice: (process.env['MINIMAX_API_KEY'] ?? '').length > 0,
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
 * See docs/THREAT-MODEL.md §T8.
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
      newSendersPerHour: z.number().int().min(1).max(1000).optional(),
      outboundPerTurn: z.number().int().min(1).max(100).optional(),
      outboundPerChatPerHour: z.number().int().min(1).max(1000).optional(),
      turnTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
    }).strict().optional(),
    delivery: z.object({
      debounceMs: z.number().int().min(0).max(60_000).optional(),
      maxBatch: z.number().int().min(1).max(50).optional(),
    }).strict().optional(),
    /** Cross-chat sending. Off by default; see THREAT-MODEL §T4. */
    agent: z.object({ crossChat: z.boolean().optional() }).strict().optional(),
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

  Object.assign(deps.config, next);

  // Preserve the documentation in the file it is documenting.
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    /* first write, or the file is gone */
  }
  for (const [section, values] of Object.entries(patch.data)) {
    raw[section] = { ...(raw[section] as object), ...values };
  }
  try {
    writeJsonAtomic(CONFIG_FILE, raw, 0o600);
  } catch (err) {
    return { ok: false, message: 'changed in memory, but the file could not be written: ' + String((err as Error).message) };
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
 * as a screen file, over the volumes that already carry everything else.
 */
let keySeq = 0;

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
  return writeTerminal(window, seconds, []);
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
  keySeq += 1;
  log('terminal.send', { window, count: keys.length, seq: keySeq });
  return writeTerminal(window, 120, keys);
}

function writeTerminal(window: string | null, seconds: number, keys: Array<{ text: string; literal: boolean }>): Json {
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
