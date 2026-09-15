/**
 * Plugins: services on the host that send through this number.
 *
 * The agent is not the only thing that needs to reach people on WhatsApp. An
 * operator runs things beside it — a morning check-in, a ticket desk, a
 * photobooth that hands a guest their picture — and those have to go out from
 * the same number without passing through a conversation. Iris grew this as
 * files dropped into its outbox; Tulip left it out on purpose, and this is it
 * coming back in a shape that fits the rest of the design.
 *
 * **The protocol is a directory per plugin.** A plugin writes one JSON action
 * per message into `TULIP_PLUGINS_DIR/<name>/` (atomically: write a `.tmp`,
 * then rename) and the bridge sends it. On success it leaves a receipt beside
 * it; on a permanent failure the action becomes a `.failed`. That is the whole
 * interface — see docs/PLUGINS.md — and a service written against Iris's outbox
 * works unchanged once it is pointed at its own directory.
 *
 * **Where it sits in the threat model.** The plugins directory is mounted into
 * the bridge and nowhere else; the agent has no path to it, so nothing a
 * conversation says can become a plugin action. A plugin is a process the
 * operator chose to run on the host, and is trusted on that basis — which is
 * why, unlike the agent's outbox, its actions name their own recipient. What it
 * is *not* trusted with is anything the operator did not grant it: the
 * directory must be enabled in config, the recipient must be on its list, the
 * kind must be allowed, and it has an hourly ceiling. A plugin that goes wrong
 * reaches the people it was already allowed to reach, at the rate it was
 * already allowed to, and the panel switch stops it.
 *
 * **Callable plugins run the other way**, and live in pluginCalls.ts: the
 * agent asks, the bridge writes a call into the same directory and reads the
 * plugin's answer back. That shares this directory, so the sender below skips
 * the three names the call protocol owns — `manifest.json`, `calls/` and
 * `answers/` — rather than mistaking a manifest for a message to send.
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '@2lp/shared';
import { feed } from './feed.js';
import { log } from './log.js';
import type { ChatRecord, ChatRegistry } from './chats.js';
import type { Config, PluginSettings } from './config.js';
import type { Transport } from './transport.js';

export const PLUGINS_DIR = process.env['TULIP_PLUGINS_DIR'] ?? '/plugins';

/** An action is a small JSON file; anything larger is not one. */
const MAX_ACTION_BYTES = 64 * 1024;
/** WhatsApp recompresses anyway, and a photobooth keepsake is well under this. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Send attempts before an action is given up on and marked `.failed`. */
const MAX_ATTEMPTS = 4;
/** Backoff between attempts. Sums to well under the 75s the Iris services wait. */
const RETRY_BASE_MS = 5000;
/** Per plugin per tick, so one busy plugin cannot starve the rest. */
const MAX_PER_TICK = 20;
const TICK_MS = 1000;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DIRECT_JID = /^(?:[0-9]{6,20}@s\.whatsapp\.net|[0-9]{5,25}@lid)$/;
const GROUP_JID = /^[0-9-]{10,40}@g\.us$/;
const Jid = z.string().refine((j) => DIRECT_JID.test(j) || GROUP_JID.test(j), 'not a WhatsApp id');

/**
 * One message a plugin wants sent.
 *
 * Strict, as everywhere else at a boundary: a field this version does not
 * understand is a refusal, not something quietly dropped. The Iris-era fields
 * (`chat`, `path`, `source`, `slug`, `queuedAt`) are accepted so those services
 * run unchanged; `chat` and `path` are aliases, and the rest decide nothing.
 */
export const PluginAction = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(['text', 'image']),
    to: Jid.optional(),
    chat: Jid.optional(),
    text: z.string().min(1).max(12_000).optional(),
    /** A plain file name inside the plugin's own directory. */
    file: z.string().max(255).optional(),
    /** Iris's absolute path. Only its last component is used, and only inside the plugin's directory. */
    path: z.string().max(4096).optional(),
    caption: z.string().max(1024).optional(),
    /** The plugin's own id for the thing being delivered. Makes the send idempotent across retries. */
    externalId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
    /** Epoch ms. Past it the action is refused rather than sent late. */
    expiresAt: z.number().finite().optional(),
    source: z.string().max(100).optional(),
    slug: z.string().max(200).optional(),
    queuedAt: z.number().optional(),
  })
  .strict()
  .refine((a) => (a.to ?? a.chat) !== undefined, 'no recipient: set `to`')
  .refine((a) => a.kind !== 'text' || a.text !== undefined, 'a text action needs `text`')
  .refine((a) => a.kind !== 'image' || (a.file ?? a.path) !== undefined, 'an image action needs `file`');
export type PluginAction = z.infer<typeof PluginAction>;

/**
 * May this plugin write to this chat?
 *
 * `"any"` means any *direct* chat. A group is a room of people who did not ask
 * for a plugin's messages, so it has to be named on the list explicitly, and
 * "any" never reaches one.
 */
export function recipientAllowed(jid: string, recipients: PluginSettings['recipients']): boolean {
  if (GROUP_JID.test(jid)) return recipients !== 'any' && recipients.includes(jid);
  if (recipients === 'any') return DIRECT_JID.test(jid);
  if (jid.endsWith('@s.whatsapp.net')) return recipients.includes(jid.slice(0, -'@s.whatsapp.net'.length));
  return recipients.includes(jid);
}

type Read = { ok: true; data: Buffer } | { ok: false; reason: string };

/**
 * Read a file by plain name from a plugin's directory, or refuse it.
 *
 * `O_NOFOLLOW` and a regular-file check on the descriptor, as outbox.ts does
 * for the agent: a link planted in the directory is resolved in *this*
 * container's namespace, where `/state` holds the WhatsApp credentials.
 */
function readPlain(dir: string, name: string, maxBytes: number): Read {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) return { ok: false, reason: `${name} is not a plain file name` };
  let fd: number;
  try {
    fd = openSync(join(dir, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return { ok: false, reason: `cannot open ${name} (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: `${name} is not a regular file` };
    if (st.size > maxBytes) return { ok: false, reason: `${name} is over ${maxBytes} bytes` };
    const data = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, data, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { ok: true, data: data.subarray(0, offset) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Names in a plugin's directory that belong to the call protocol, not to sending.
 *
 * Only `manifest.json` would actually be picked up — `calls` and `answers` are
 * directories and end in no `.json` — but all three are listed so the rule
 * reads as what it is, and a plugin that names a file `calls.json` is not
 * caught by it. A manifest read as an action would be refused and renamed to
 * `manifest.failed`, quietly unlisting the plugin it describes.
 */
export const CALL_PROTOCOL_NAMES: ReadonlySet<string> = new Set(['manifest.json', 'calls', 'answers']);

const isOutboundAction = (file: string): boolean => file.endsWith('.json') && !CALL_PROTOCOL_NAMES.has(file);

/** A real directory, not a link to one — see `readPlain` for why that matters here. */
export function isPlainDirectory(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isImage(data: Buffer): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const jpeg = [0xff, 0xd8, 0xff];
  const starts = (magic: number[]): boolean => data.length >= magic.length && magic.every((b, i) => data[i] === b);
  return starts(png) || starts(jpeg);
}

function countPending(dir: string): number {
  try {
    return readdirSync(dir).filter(isOutboundAction).length;
  } catch {
    return 0;
  }
}

function countBySuffix(dir: string, suffix: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

export interface PluginStatus {
  readonly name: string;
  readonly label: string;
  /** Has an entry in config.json. A directory without one is shown, and ignored. */
  readonly configured: boolean;
  readonly enabled: boolean;
  /** Its directory exists under the plugins mount. */
  readonly present: boolean;
  readonly pending: number;
  readonly failed: number;
  /** Since the bridge started. */
  readonly sent: number;
  readonly lastSentAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
}

interface Stats {
  sent: number;
  lastSentAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface PluginHostDeps {
  readonly wa: Pick<Transport, 'connected' | 'sendText' | 'sendImage'>;
  readonly config: Pick<Config, 'plugins'>;
  readonly chats: Pick<ChatRegistry, 'all' | 'isBlocked'>;
  readonly dir?: string;
  readonly now?: () => number;
}

let active: PluginHost | null = null;

/** What the panel shows. Empty until the bridge has started its host. */
export function pluginStatus(): PluginStatus[] {
  return active?.status() ?? [];
}

export class PluginHost {
  private readonly root: string;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  /** Keyed by full path. In memory: a restart retrying a failed send is the right outcome. */
  private readonly attempts = new Map<string, { n: number; retryAt: number }>();
  private readonly recent = new Map<string, number[]>();
  private readonly stats = new Map<string, Stats>();
  /** Plugins currently over their hour, so the log says so once rather than every second. */
  private readonly limited = new Set<string>();

  constructor(private readonly deps: PluginHostDeps) {
    this.root = deps.dir ?? PLUGINS_DIR;
    this.now = deps.now ?? Date.now;
  }

  start(): this {
    active = this;
    this.timer = setInterval(() => void this.drain(), TICK_MS);
    this.timer.unref();
    void this.drain();
    return this;
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (active === this) active = null;
  }

  async drain(): Promise<void> {
    if (this.draining || !this.deps.wa.connected) return;
    this.draining = true;
    try {
      for (const [name, settings] of Object.entries(this.deps.config.plugins)) {
        if (!settings.enabled || !NAME.test(name)) continue;
        await this.drainPlugin(name, settings);
      }
    } finally {
      this.draining = false;
    }
  }

  status(): PluginStatus[] {
    const configured = this.deps.config.plugins;
    const names = new Set<string>([...Object.keys(configured), ...this.discovered()]);
    return [...names].sort().map((name) => {
      const settings = configured[name];
      const dir = join(this.root, name);
      const present = isPlainDirectory(dir);
      const stats = this.stats.get(name);
      return {
        name,
        label: settings?.label || name,
        configured: settings !== undefined,
        enabled: settings?.enabled ?? false,
        present,
        pending: present ? countPending(dir) : 0,
        failed: present ? countBySuffix(dir, '.failed') : 0,
        sent: stats?.sent ?? 0,
        lastSentAt: stats?.lastSentAt ?? null,
        lastError: stats?.lastError ?? null,
        lastErrorAt: stats?.lastErrorAt ?? null,
      };
    });
  }

  private discovered(): string[] {
    try {
      return readdirSync(this.root).filter((n) => NAME.test(n) && isPlainDirectory(join(this.root, n)));
    } catch {
      return [];
    }
  }

  private async drainPlugin(name: string, settings: PluginSettings): Promise<void> {
    const dir = join(this.root, name);
    if (!isPlainDirectory(dir)) return;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter(isOutboundAction)
        .sort()
        .slice(0, MAX_PER_TICK);
    } catch {
      return;
    }
    for (const file of files) {
      if (!this.deps.wa.connected) return;
      await this.handle(name, settings, dir, file);
    }
  }

  private async handle(name: string, settings: PluginSettings, dir: string, file: string): Promise<void> {
    const full = join(dir, file);
    const pending = this.attempts.get(full);
    const now = this.now();
    if (pending !== undefined && pending.retryAt > now) return;

    const raw = readPlain(dir, file, MAX_ACTION_BYTES);
    if (!raw.ok) return this.refuse(name, settings, dir, file, raw.reason);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data.toString('utf8'));
    } catch {
      // Most likely a writer that skipped the rename and is mid-write. Give it
      // the same allowance as a failed send before calling it broken.
      return this.failedAttempt(name, settings, dir, file, 'not valid JSON');
    }
    const result = PluginAction.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      return this.refuse(name, settings, dir, file, `not a valid action: ${issue?.path.join('.') || ''} ${issue?.message ?? ''}`.trim());
    }
    const action = result.data;
    const to = (action.to ?? action.chat) as string;
    const stem = file.slice(0, -'.json'.length);
    const receipt = action.externalId !== undefined ? `${name}-${action.externalId}.sent` : `${stem}.sent`;

    // Idempotent. A service that retries an acknowledgement, or a bridge that
    // stopped between sending and tidying up, must never produce a second send
    // of something already delivered — a ticket or a photo arriving twice is
    // the failure a customer notices.
    if (existsSync(join(dir, receipt))) {
      rmSync(full, { force: true });
      return;
    }

    if (action.expiresAt !== undefined && action.expiresAt < now) {
      return this.refuse(name, settings, dir, file, 'expired before it could be sent');
    }
    if (!settings.kinds.includes(action.kind)) {
      return this.refuse(name, settings, dir, file, `this plugin is not allowed to send ${action.kind}`);
    }
    if (!recipientAllowed(to, settings.recipients)) {
      return this.refuse(name, settings, dir, file, 'the recipient is not on this plugin’s list');
    }
    const chat = this.chatFor(to);
    if (chat !== null && this.deps.chats.isBlocked(chat.chatKey)) {
      return this.refuse(name, settings, dir, file, 'that chat is blocked');
    }
    if (!this.withinHour(name, settings.perHour, now)) return;

    let image: Buffer | null = null;
    if (action.kind === 'image') {
      const read = readPlain(dir, action.file ?? basename(action.path as string), MAX_IMAGE_BYTES);
      if (!read.ok) return this.refuse(name, settings, dir, file, read.reason);
      if (!isImage(read.data)) return this.refuse(name, settings, dir, file, 'the file is not a PNG or JPEG');
      image = read.data;
    }

    try {
      if (image === null) await this.deps.wa.sendText(to, action.text as string);
      else await this.deps.wa.sendImage(to, image, action.caption ?? null);
    } catch (err) {
      return this.failedAttempt(name, settings, dir, file, String((err as Error).message));
    }

    this.attempts.delete(full);
    this.recent.get(name)?.push(now);
    try {
      writeJsonAtomic(join(dir, receipt), { id: action.id, sentAt: now }, 0o600);
    } catch (err) {
      // Sent, but the service will not see it confirmed. Worth knowing; not
      // worth resending over, which is what leaving the action would cause.
      log('plugin.receiptFailed', { plugin: name, err: String((err as Error).message) });
    }
    rmSync(full, { force: true });

    const stats = this.statsFor(name);
    stats.sent += 1;
    stats.lastSentAt = now;
    log('plugin.sent', { plugin: name, kind: action.kind, ...(settings.private ? {} : { id: action.id }) });
    this.record(name, settings, action, to, chat);
  }

  /** Into the feed, so an operator reading a chat sees what a plugin said in it. */
  private record(name: string, settings: PluginSettings, action: PluginAction, to: string, chat: ChatRecord | null): void {
    const label = settings.label || name;
    const what = action.kind === 'image' ? 'a picture' : 'a message';
    if (settings.private) {
      feed.event('plugin.sent', `${label} sent ${what} (private — recipient and contents not recorded)`);
    } else if (chat !== null) {
      feed.outbound(chat.chatKey, `plugin:${name}`, action.kind === 'text' ? (action.text ?? null) : (action.caption ?? null));
    } else {
      feed.event('plugin.sent', `${label} sent ${what} to ${to.split('@')[0]}`);
    }
  }

  private failedAttempt(name: string, settings: PluginSettings, dir: string, file: string, reason: string): void {
    const full = join(dir, file);
    const n = (this.attempts.get(full)?.n ?? 0) + 1;
    if (n >= MAX_ATTEMPTS) {
      this.attempts.delete(full);
      return this.refuse(name, settings, dir, file, `gave up after ${n} attempts: ${reason}`);
    }
    this.attempts.set(full, { n, retryAt: this.now() + RETRY_BASE_MS * 2 ** (n - 1) });
    this.noteError(name, reason);
    log('plugin.retry', { plugin: name, file, attempt: n, reason });
  }

  /**
   * Give up on an action, leaving a `.failed` where the service will look.
   *
   * A private plugin's action is replaced rather than renamed: what failed to
   * reach somebody was their ticket or their photo, and a `.failed` file kept
   * for the service to notice does not need to keep that as well.
   */
  private refuse(name: string, settings: PluginSettings, dir: string, file: string, reason: string): void {
    const full = join(dir, file);
    const failed = join(dir, file.replace(/\.json$/, '.failed'));
    try {
      if (settings.private) {
        writeJsonAtomic(failed, { failedAt: this.now(), reason }, 0o600);
        rmSync(full, { force: true });
      } else {
        renameSync(full, failed);
      }
    } catch (err) {
      log('plugin.refuseFailed', { plugin: name, file, err: String((err as Error).message) });
    }
    this.noteError(name, reason);
    log('plugin.refused', { plugin: name, file, reason });
    feed.event('plugin.refused', `${settings.label || name}: ${reason}`);
  }

  private withinHour(name: string, perHour: number, now: number): boolean {
    const since = now - 3_600_000;
    const recent = (this.recent.get(name) ?? []).filter((t) => t > since);
    this.recent.set(name, recent);
    if (recent.length < perHour) {
      this.limited.delete(name);
      return true;
    }
    if (!this.limited.has(name)) {
      this.limited.add(name);
      this.noteError(name, `over its limit of ${perHour} an hour; holding the rest`);
      log('plugin.limited', { plugin: name, perHour });
      feed.event('plugin.limited', `${name} reached ${perHour} messages this hour; the rest wait`);
    }
    return false;
  }

  private chatFor(jid: string): ChatRecord | null {
    const all = this.deps.chats.all();
    return all.find((r) => r.mergedInto === null && (r.jid === jid || r.altJid === jid)) ?? null;
  }

  private statsFor(name: string): Stats {
    let stats = this.stats.get(name);
    if (stats === undefined) {
      stats = { sent: 0, lastSentAt: null, lastError: null, lastErrorAt: null };
      this.stats.set(name, stats);
    }
    return stats;
  }

  private noteError(name: string, reason: string): void {
    const stats = this.statsFor(name);
    stats.lastError = reason;
    stats.lastErrorAt = this.now();
  }
}
