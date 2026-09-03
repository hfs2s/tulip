/**
 * Trust boundary B3: everything the agent asks the bridge to do.
 *
 * This is the file to read adversarially. The agent is assumed to be executing
 * an attacker's code, so every field arriving here is hostile, and the whole
 * design is that there is very little a hostile field can express:
 *
 *   - **The destination is not in the message.** Actions carry a `turnId`. The
 *     bridge resolves it through its own registry and sends to *that* chat. An
 *     action for an unknown, expired or exhausted turn is dropped.
 *   - **The schema is strict.** Unknown fields are a parse error, not something
 *     stripped and ignored, so a field a future version might honour cannot be
 *     smuggled in early.
 *   - **Files are resolved, not trusted.** `resolveOutboundFile` below is the
 *     single most dangerous function in the bridge, and is commented as such.
 */
import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { OutboxAction, ToolResult, inPaths, outPaths, writeJsonAtomic } from '@tulip/shared';
import type { OutboxAction as OutboxActionType } from '@tulip/shared';
import { feed } from './feed.js';
import { findGif, type Rating } from './giphy.js';
import { fetchPage, search, type ExaOutcome } from './exa.js';
import { log } from './log.js';
import type { Limiter } from './ratelimit.js';
import type { TurnRegistry } from './turns.js';
import type { WhatsApp } from './whatsapp.js';

/** Attempts before an action is abandoned. */
const MAX_ATTEMPTS = 4;
/** How large a file the agent may ask the bridge to send. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * What the agent may send, by extension.
 *
 * An allowlist rather than a deny list, and deliberately short. Every entry is
 * something a helpful assistant plausibly produces; nothing here executes
 * anywhere, and archives are excluded because their contents are not inspected.
 */
const SENDABLE: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

/** Leading bytes that must match, for the formats where it is cheap to check. */
const MAGIC: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
];

export type FileResolution =
  | { ok: true; path: string; mimetype: string; bytes: number }
  | { ok: false; reason: string };

/**
 * Resolve a file name the agent supplied to a path the bridge may open.
 *
 * **The attack this exists to stop.** The agent shares a writable volume with
 * the bridge, but not a filesystem namespace — so a symlink the agent creates
 * inside that volume is resolved by the *bridge*, in the bridge's namespace,
 * where `/state/session` holds the WhatsApp credentials. Left unchecked,
 * `ln -s /state/session/creds.json out/files/holiday.jpg` followed by a send
 * would deliver the account to whoever asked for it. That is a complete
 * compromise reachable through an interface that otherwise looks like "send a
 * picture".
 *
 * Four independent checks, in order of what they stop:
 *
 *   0. the outbox directory is itself a real directory, not a symlink the
 *      agent swapped in to move the whole check somewhere useful;
 *   1. the name is a bare basename — no separators, no traversal;
 *   2. `lstat` says regular file — a symlink is refused rather than followed,
 *      which is the check that stops the attack above outright;
 *   3. `realpath` still lies inside the files directory — belt and braces,
 *      covering a symlinked ancestor rather than a symlinked leaf;
 *   4. the extension is on the allowlist, the size is under the cap, and for
 *      the common formats the leading bytes match the claimed type.
 */
export function resolveOutboundFile(name: string, directory = outPaths.files): FileResolution {
  if (name !== basename(name) || name.includes('..') || name.startsWith('.')) {
    return { ok: false, reason: 'file must be a plain name inside the outbox' };
  }

  const root = resolve(directory);

  // The outbox directory itself must be a real directory. The agent has write
  // access to this volume, so it can `rmdir out/files && ln -s /state
  // out/files` — after which every check below would faithfully confine to the
  // wrong root, and `chats.json` (the phone-number map) would pass the
  // extension allowlist. Checking the container before its contents is what
  // makes the containment argument mean anything.
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, reason: 'the outbox directory has been replaced' };
    }
  } catch {
    return { ok: false, reason: 'the outbox directory is missing' };
  }

  const candidate = resolve(root, name);
  if (!candidate.startsWith(root + sep)) {
    return { ok: false, reason: 'file resolves outside the outbox' };
  }

  let stat;
  try {
    stat = lstatSync(candidate);
  } catch {
    return { ok: false, reason: 'file does not exist' };
  }

  // lstat, not stat: a symlink must be refused, never followed.
  if (stat.isSymbolicLink()) return { ok: false, reason: 'file is a symlink' };
  if (!stat.isFile()) return { ok: false, reason: 'file is not a regular file' };
  if (stat.size === 0) return { ok: false, reason: 'file is empty' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: `file exceeds ${MAX_FILE_BYTES} bytes` };

  // Guards against a symlinked *ancestor*, which lstat on the leaf would miss.
  try {
    const real = realpathSync(candidate);
    const realRoot = realpathSync(root);
    if (real !== join(realRoot, name) && !real.startsWith(realRoot + sep)) {
      return { ok: false, reason: 'file resolves outside the outbox' };
    }
  } catch {
    return { ok: false, reason: 'file could not be resolved' };
  }

  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot).toLowerCase();
  const mimetype = SENDABLE[extension];
  if (mimetype === undefined) {
    return { ok: false, reason: `files of type "${extension || 'none'}" may not be sent` };
  }

  const expected = MAGIC.find(([type]) => type === mimetype);
  if (expected) {
    let head: Buffer;
    try {
      head = readFileSync(candidate).subarray(0, expected[1].length);
    } catch {
      return { ok: false, reason: 'file could not be read' };
    }
    if (!expected[1].every((byte, i) => head[i] === byte)) {
      return { ok: false, reason: `file does not contain ${mimetype} data` };
    }
  }

  return { ok: true, path: candidate, mimetype, bytes: stat.size };
}

export interface OutboxDeps {
  readonly wa: WhatsApp;
  readonly turns: TurnRegistry;
  readonly limiter: Limiter;
  /** Resolve the newest inbound message in a chat, so `react` has a target. */
  readonly lastMessageIn: (chatKey: string) => { id: string; participant?: string } | null;
}

/**
 * Watches the outbound volume and performs what it finds there.
 *
 * Polls rather than relying on `fs.watch`: the two sides are different
 * containers writing to a shared volume, where watch semantics vary by
 * filesystem and driver. A one-second delay is a much smaller problem than a
 * reply that is never sent.
 */
export class Outbox extends EventEmitter {
  private readonly attempts = new Map<string, number>();
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly deps: OutboxDeps) {
    super();
  }

  start(): this {
    this.timer = setInterval(() => void this.drain(), 1000);
    this.sweeper = setInterval(() => this.sweepResults(), 60_000);
    this.sweeper.unref();
    void this.drain();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.timer = null;
    this.sweeper = null;
  }

  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let names: string[];
      try {
        names = readdirSync(outPaths.actions).filter((n) => n.endsWith('.json')).sort();
      } catch {
        return; // the volume is not there yet
      }

      for (const name of names) {
        const file = join(outPaths.actions, name);
        const action = this.read(file);
        if (action === null) continue; // unreadable or invalid — already handled

        try {
          await this.perform(action);
          rmSync(file, { force: true });
          this.attempts.delete(name);
        } catch (err) {
          const count = (this.attempts.get(name) ?? 0) + 1;
          this.attempts.set(name, count);
          log('outbox.error', { id: action.id, attempt: count, err: String((err as Error).message) });
          if (count >= MAX_ATTEMPTS) {
            rmSync(file, { force: true });
            this.attempts.delete(name);
            log('outbox.dropped', { id: action.id, note: 'giving up after repeated failures' });
          }
          // Stop the pass here: whatever failed is likely to fail again this
          // second, and retrying the whole directory would multiply the noise.
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Read and validate one action.
   *
   * A file that does not parse is deleted rather than retried. It cannot become
   * valid, and leaving it would make the directory grow forever — which a
   * compromised agent could arrange deliberately.
   */
  private read(file: string): OutboxActionType | null {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null; // mid-write; the next pass will catch it
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Possibly a partial write. Only discard it once it has stopped changing.
      if (this.stale(file)) {
        rmSync(file, { force: true });
        log('outbox.discarded', { file: basename(file), reason: 'not valid JSON' });
      }
      return null;
    }

    const result = OutboxAction.safeParse(parsed);
    if (!result.success) {
      rmSync(file, { force: true });
      log('outbox.rejected', {
        file: basename(file),
        reason: result.error.issues[0]?.message ?? 'failed validation',
        path: result.error.issues[0]?.path.join('.') ?? '',
      });
      return null;
    }
    return result.data;
  }

  /**
   * Write a tool answer where the agent can read it.
   *
   * Onto the *inbound* volume, which the agent mounts read-only: it can read
   * the answer and cannot forge, edit or replay one. The bridge stays the only
   * writer of anything the agent treats as having come from outside.
   */
  private async answer(actionId: string, kind: 'search' | 'fetch', outcome: ExaOutcome): Promise<void> {
    const result = ToolResult.safeParse({
      actionId,
      kind,
      at: new Date().toISOString(),
      ok: outcome.ok,
      error: outcome.ok ? null : outcome.error.slice(0, 300),
      items: outcome.ok ? outcome.items : [],
    });
    if (!result.success) {
      log('outbox.resultInvalid', { actionId, issues: result.error.issues.length });
      return;
    }
    try {
      mkdirSync(inPaths.results, { recursive: true });
      writeJsonAtomic(inPaths.result(actionId), result.data, 0o644);
      log('outbox.answered', { actionId, kind, ok: result.data.ok, items: result.data.items.length });
    } catch (err) {
      log('outbox.answerFailed', { actionId, err: String((err as Error).message) });
    }
    await Promise.resolve();
  }

  /**
   * Delete answers the agent has had long enough to read.
   *
   * The agent cannot clean these up — its mount is read-only — so the bridge
   * must, or the volume grows for as long as the deployment runs.
   */
  private sweepResults(): void {
    let names: string[];
    try {
      names = readdirSync(inPaths.results);
    } catch {
      return;
    }
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const name of names) {
      const file = join(inPaths.results, name);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  private stale(file: string): boolean {
    try {
      return Date.now() - lstatSync(file).mtimeMs > 5000;
    } catch {
      return false;
    }
  }

  /**
   * Perform one validated action.
   *
   * Note what is *not* read from `action`: the destination. It comes from the
   * turn registry, which the agent cannot write to.
   */
  private async perform(action: OutboxActionType): Promise<void> {
    const now = Date.now();
    const resolution = this.deps.turns.resolve(action.turnId, now);
    if (!resolution.ok) {
      log('outbox.unroutable', { id: action.id, kind: action.kind, reason: resolution.reason });
      return; // dropped, not retried: an unroutable turn never becomes routable
    }
    const { turn } = resolution;

    // Typing is cosmetic and uncounted; everything else spends allowance.
    if (action.kind !== 'typing') {
      const allowance = this.deps.limiter.admitOutbound(turn.chatKey, now);
      if (!allowance.ok) {
        log('outbox.throttled', { chatKey: turn.chatKey, reason: allowance.reason });
        return;
      }
      this.deps.turns.countSend(action.turnId);
    }

    switch (action.kind) {
      case 'text': {
        await this.deps.wa.sendText(turn.chatJid, action.text);
        feed.outbound(turn.chatKey, 'text', action.text);
        break;
      }
      case 'file': {
        const file = resolveOutboundFile(action.file);
        if (!file.ok) {
          log('outbox.fileRefused', { id: action.id, name: action.file, reason: file.reason });
          feed.event('outbox.fileRefused', `${action.file}: ${file.reason}`);
          return;
        }
        await this.deps.wa.sendFile(turn.chatJid, file.path, file.mimetype, action.caption);
        feed.outbound(turn.chatKey, file.mimetype, action.caption);
        // Sent files are removed: the volume is not storage, and leaving them
        // lets a compromised agent fill the disk one send at a time.
        rmSync(file.path, { force: true });
        break;
      }
      case 'gif': {
        const gif = await findGif(action.query, {
          apiKey: process.env['GIPHY_API_KEY'] ?? '',
          rating: (process.env['GIPHY_RATING'] as Rating | undefined) ?? 'pg',
        });
        if (!gif.ok) {
          // Cosmetic. A missing GIF must never cost somebody their reply, so
          // this is recorded and dropped rather than retried or escalated.
          log('outbox.gifFailed', { query: action.query, reason: gif.reason });
          feed.event('gif.failed', `${action.query}: ${gif.reason}`);
          return;
        }
        await this.deps.wa.sendGif(turn.chatJid, gif.video, action.caption);
        feed.outbound(turn.chatKey, 'gif', `[gif] ${gif.title}`);
        break;
      }
      // Tool requests. These do not send anybody a message, so they are not
      // charged against the outbound allowance above — but they do leave the
      // deployment, which is why they are rate-limited by turn instead.
      case 'search': {
        await this.answer(action.id, 'search', await search(action.query, action.results));
        break;
      }
      case 'fetch': {
        await this.answer(action.id, 'fetch', await fetchPage(action.url));
        break;
      }
      case 'react': {
        const target = this.deps.lastMessageIn(turn.chatKey);
        if (!target) {
          log('outbox.noReactTarget', { chatKey: turn.chatKey });
          return;
        }
        await this.deps.wa.react(turn.chatJid, target.id, action.emoji, target.participant);
        feed.outbound(turn.chatKey, 'react', action.emoji);
        break;
      }
      case 'typing': {
        await this.deps.wa.typing(turn.chatJid, action.on);
        break;
      }
    }

    this.emit('sent', { chatKey: turn.chatKey, kind: action.kind });
    log('outbox.sent', { chatKey: turn.chatKey, kind: action.kind });
  }
}

export { createReadStream };
