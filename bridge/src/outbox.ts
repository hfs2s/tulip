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
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { mkdirSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { OutboxAction, ToolResult, inPaths, outPaths, writeJsonAtomic } from '@tulip/shared';
import type { OutboxAction as OutboxActionType } from '@tulip/shared';
import { feed } from './feed.js';
import { findGif, type Rating } from './giphy.js';
import { fetchPage, search, type ExaOutcome } from './exa.js';
import { generateImage, synthesise } from './minimax.js';
import { log } from './log.js';
import { retainOutbound } from './mediaStore.js';
import { claim } from './spend.js';
import { imageCount, MAX_IMAGES_PER_PAGE, publishPage, scaffoldPage, usesKit, writePageImage } from './pages.js';
import { remember } from './memory.js';
import type { Limiter } from './ratelimit.js';
import type { Turn, TurnRegistry } from './turns.js';
import type { Config } from './config.js';
import type { ChatRegistry } from './chats.js';
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
  /**
   * The bytes, not a path — and that distinction is the entire point.
   *
   * `unlinkPath` exists solely so the caller can delete the staged file
   * afterwards. It must never be reopened to read content: doing so
   * reintroduces the race this function was rewritten to close.
   */
  | { ok: true; data: Buffer; mimetype: string; bytes: number; unlinkPath: string }
  | { ok: false; reason: string };

/**
 * Read a file the agent staged, or refuse it.
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
 * **Why this returns bytes rather than a path.** An earlier version ran the
 * checks below and handed the *path* back; the caller then opened it again to
 * send it, and the magic-byte check had opened it a third time. Every check was
 * individually correct and the whole was still defeatable, because the agent
 * writes to that directory and only had to swap the name between the last check
 * and the next open — the classic check-by-path / use-by-path race (CWE-367).
 * With 8 sends a turn it had as many attempts as it liked, driven by a shell
 * loop that does not have to win on the first try.
 *
 * So: **exactly one `open()` for the lifetime of the data.** Everything below —
 * the type, the size, the magic bytes, the content that is actually sent — is
 * derived from that one descriptor. There is no second resolution of the name
 * for an attacker to race, because the name is never resolved twice.
 *
 * The checks, in order of what they stop:
 *
 *   0. the name is a bare basename — no separators, no traversal;
 *   1. the extension is on the allowlist (cheap, and done before any syscall);
 *   2. the outbox directory is itself a real directory, not a symlink the agent
 *      swapped in to move every later check somewhere useful;
 *   3. `O_NOFOLLOW` on the open — the kernel refuses a symlinked leaf, and it
 *      does so atomically, which is what a separate `lstat` could never be;
 *   4. on Linux, `/proc/self/fd` says what was *actually* opened, which catches
 *      a swapped *ancestor* that `O_NOFOLLOW` on the leaf cannot see;
 *   5. `fstat` on the descriptor — regular file, non-empty, under the cap;
 *   6. the leading bytes match the claimed type, for the formats where that is
 *      cheap. Note that `.json`, `.txt`, `.md` and `.csv` have no signature to
 *      check, which is exactly why steps 2–4 have to be airtight rather than
 *      merely careful: `chats.json` is the phone-number map.
 */
export function resolveOutboundFile(name: string, directory = outPaths.files): FileResolution {
  if (name !== basename(name) || name.includes('..') || name.startsWith('.')) {
    return { ok: false, reason: 'file must be a plain name inside the outbox' };
  }

  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot).toLowerCase();
  const mimetype = SENDABLE[extension];
  if (mimetype === undefined) {
    return { ok: false, reason: `files of type "${extension || 'none'}" may not be sent` };
  }

  const root = resolve(directory);

  // The outbox directory itself must be a real directory. The agent has write
  // access to this volume, so it can `rmdir out/files && ln -s /state
  // out/files` — after which every check below would faithfully confine to the
  // wrong root. Racy on its own, which is why step 4 rechecks against what the
  // kernel actually opened; this is the cheap early rejection.
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

  // The one and only open. O_NOFOLLOW makes the kernel fail with ELOOP if the
  // final component is a symlink, atomically — no window between deciding and
  // opening.
  let fd: number;
  try {
    fd = openSync(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return { ok: false, reason: 'file is a symlink' };
    if (code === 'ENOENT') return { ok: false, reason: 'file does not exist' };
    return { ok: false, reason: 'file could not be opened' };
  }

  try {
    // What did we actually open? On Linux this is authoritative and settles the
    // swapped-ancestor case: if `files` was replaced by a link to /state, the
    // descriptor's real path is under /state and does not match. Absent on
    // macOS, where a developer runs the suite — there the lstat above plus
    // realpath below are the best available, and production is Linux.
    const opened = describeFd(fd);
    if (opened !== null) {
      if (opened !== join(root, name)) {
        return { ok: false, reason: 'file resolves outside the outbox' };
      }
    } else {
      try {
        const real = realpathSync(candidate);
        const realRoot = realpathSync(root);
        if (real !== join(realRoot, name) && !real.startsWith(realRoot + sep)) {
          return { ok: false, reason: 'file resolves outside the outbox' };
        }
      } catch {
        return { ok: false, reason: 'file could not be resolved' };
      }
    }

    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: 'file is not a regular file' };
    if (stat.size === 0) return { ok: false, reason: 'file is empty' };
    if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: `file exceeds ${MAX_FILE_BYTES} bytes` };

    // Read from the descriptor, never from the name. These are the bytes that
    // get sent; nothing re-reads the file afterwards.
    const data = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, data, read, stat.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    if (read !== stat.size) return { ok: false, reason: 'file could not be read' };

    const expected = MAGIC.find(([type]) => type === mimetype);
    if (expected && !expected[1].every((byte, i) => data[i] === byte)) {
      return { ok: false, reason: `file does not contain ${mimetype} data` };
    }

    return { ok: true, data, mimetype, bytes: stat.size, unlinkPath: candidate };
  } finally {
    closeSync(fd);
  }
}

/**
 * The real path behind an open descriptor, on Linux. Null anywhere else.
 *
 * Null means "cannot tell", never "fine" — the caller falls back to a weaker
 * check rather than treating an unknown as a pass.
 */
function describeFd(fd: number): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

export interface OutboxDeps {
  readonly wa: WhatsApp;
  /** Live config: cross-chat sending is a switch an operator can flip. */
  readonly config: Config;
  readonly chats: ChatRegistry;
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
  /**
   * A capability the operator has switched off.
   *
   * Recorded rather than silent: an agent quietly failing to send a picture and
   * an operator having turned pictures off look identical from the outside, and
   * only one of them is worth investigating.
   */
  private refuse(capability: string): void {
    log('outbox.capabilityOff', { capability });
    feed.event('capability.off', `${capability} is switched off; the agent asked for it`);
  }

  /** Answer a `chats` request on the inbound volume, like a search result. */
  private async answerChats(
    chats: Array<{ chatKey: string; name: string; isGroup: boolean; contact: boolean }>,
    actionId?: string,
  ): Promise<void> {
    if (!actionId) return;
    await this.answer(actionId, 'chats', {
      ok: true,
      items: chats.map((c) => ({
        title: c.name + (c.isGroup ? ' (group)' : ''),
        url: c.chatKey,
        published: null,
        // The one thing the agent needs in order to apply the rule it is given:
        // a contact is somebody an operator listed, so approaching them
        // unprompted is expected. Any other row is a chat that happened to
        // write in once, and messaging it out of the blue is not.
        text: c.contact ? 'contact' : 'has messaged before',
      })),
    });
  }

  /**
   * Fill a silence the agent is about to create.
   *
   * `turn.sends` is the exact question — has anything reached this person
   * during this turn — so a turn that has already spoken needs nothing, and one
   * that has not is about to go quiet for minutes.
   *
   * Deliberately not counted against `outboundPerTurn`. That allowance exists
   * to bound what the agent can push through the reply channel; this is the
   * bridge saying "wait" on its behalf, and it would be perverse for keeping
   * somebody informed to cost the agent a reply.
   */
  private async holdingMessage(turn: Turn, text: string): Promise<void> {
    if (turn.sends > 0) return;
    try {
      await this.deps.wa.sendText(turn.chatJid, text);
      feed.outbound(turn.chatKey, 'text', text);
      log('outbox.holding', { chatKey: turn.chatKey, why: 'a page is being built' });
    } catch (err) {
      // A holding message that fails must not fail the thing it announced.
      log('outbox.holdingFailed', { err: String((err as Error).message) });
    }
  }

  private async answer(actionId: string, kind: 'search' | 'fetch' | 'chats' | 'page', outcome: ExaOutcome): Promise<void> {
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
        await this.deps.wa.sendFile(turn.chatJid, file.data, file.mimetype, action.file, action.caption);
        retainOutbound(turn.chatKey, 'file', file.data, file.mimetype);
        feed.outbound(turn.chatKey, file.mimetype, action.caption);
        // Sent files are removed: the volume is not storage, and leaving them
        // lets a compromised agent fill the disk one send at a time. Deleting
        // by name is safe in a way that *reading* by name is not — if the agent
        // has swapped a symlink in since, this unlinks the link, not its target.
        rmSync(file.unlinkPath, { force: true });
        break;
      }
      case 'gif': {
        if (!this.deps.config.agent.gifs) return this.refuse('gifs');
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
        retainOutbound(turn.chatKey, 'gif', gif.video);
        feed.outbound(turn.chatKey, 'gif', `[gif] ${gif.title}`);
        break;
      }
      // Tool requests. These do not send anybody a message, so they are not
      // charged against the outbound allowance above — but they do leave the
      // deployment, which is why they are rate-limited by turn instead.
      case 'search': {
        if (!this.deps.config.agent.search) {
          await this.answer(action.id, 'search', { ok: false, error: 'web search is switched off by the operator' });
          return;
        }
        await this.answer(action.id, 'search', await search(action.query, action.results));
        break;
      }
      case 'fetch': {
        if (!this.deps.config.agent.search) {
          await this.answer(action.id, 'fetch', { ok: false, error: 'web access is switched off by the operator' });
          return;
        }
        await this.answer(action.id, 'fetch', await fetchPage(action.url));
        break;
      }
      // The one action that names a destination, and the only one gated on an
      // operator switch. Off by default; see THREAT-MODEL.md T4.
      case 'sendTo': {
        if (!this.deps.config.agent.crossChat) {
          log('outbox.crossChatRefused', { note: 'agent.crossChat is off' });
          feed.event('crossChat.refused', 'the agent tried to message another chat');
          return;
        }
        const jid = this.deps.chats.jidFor(action.chatKey);
        if (jid === null) {
          log('outbox.unknownChat', { chatKey: action.chatKey });
          return; // a key the bridge never issued resolves to nothing
        }
        if (this.deps.chats.isBlocked(action.chatKey)) {
          log('outbox.blockedChat', { chatKey: action.chatKey });
          return;
        }
        await this.deps.wa.sendText(jid, action.text);
        feed.outbound(action.chatKey, 'text', action.text);
        // Recorded against both chats, so a message that crossed conversations
        // is visible from the one it came from as well as the one it went to.
        feed.event('crossChat.sent', `${turn.chatKey} -> ${action.chatKey}`);
        break;
      }

      case 'remember': {
        const record = this.deps.chats.get(turn.chatKey);
        const kept = remember(action.text, turn.chatKey, record?.name ?? null);
        if (kept.ok) {
          // Loud on purpose. This is the one thing the agent learns that reaches
          // every other conversation, so an operator who never opens the Memory
          // page still scrolls past it.
          feed.event('memory.remembered', action.text.slice(0, 160));
        }
        await this.answer(action.id, 'page', kept.ok
          ? { ok: true, items: [] }
          : { ok: false, error: kept.error });
        break;
      }

      case 'pageImage': {
        if (!this.deps.config.agent.images) return this.refuse('images');
        if (imageCount(action.slug) >= MAX_IMAGES_PER_PAGE) {
          await this.answer(action.id, 'page', {
            ok: false,
            error: `a page may hold ${String(MAX_IMAGES_PER_PAGE)} pictures — delete one or reuse a name`,
          });
          break;
        }
        // The same daily allowance as a picture sent to a person: the cost is
        // in making it, not in where it lands.
        if (!claim('images', this.deps.config.limits.imagesPerDay)) {
          await this.answer(action.id, 'page', { ok: false, error: "today's picture allowance is spent" });
          break;
        }
        const made = await generateImage(action.prompt);
        if (!made.ok) {
          await this.answer(action.id, 'page', { ok: false, error: made.error });
          break;
        }
        const written = writePageImage(action.slug, action.name, made.data);
        await this.answer(action.id, 'page', written.ok
          ? { ok: true, items: [{ title: action.name, url: written.url, published: null, text: '' }] }
          : { ok: false, error: written.error });
        break;
      }

      case 'pageNew': {
        // Say something before the silence starts, and say it from here rather
        // than trusting the brief. The brief already asked for this — under
        // "slow work", which the agent did not connect to building a page — and
        // the result was minutes of nothing at the other end.
        //
        // Only when the turn has produced nothing yet, so this never talks over
        // an agent that did the right thing on its own. After this the agent's
        // own words take over.
        await this.holdingMessage(turn, 'Working on a page for you — give me a few minutes and I will send the link.');
        const made = scaffoldPage(action.slug, action.title);
        await this.answer(action.id, 'page', made.ok
          ? {
              ok: true,
              items: [{
                title: action.slug,
                url: made.url,
                published: null,
                // Said here as well as in the brief, because this is the moment
                // it matters: everything after this point is minutes of silence
                // for whoever asked.
                text: 'If you have not already told them you are building this, do it now — a page takes minutes and silence reads as being ignored.',
              }],
            }
          : { ok: false, error: made.error });
        break;
      }

      case 'page': {
        // The address comes back as an ordinary result item, so the answer file
        // keeps one shape. A page has no text to carry — the point is the URL.
        const published = publishPage(action.slug);
        // Published either way: a page that opted out of the house style is a
        // choice the agent is allowed to make, and refusing would turn a look
        // into a gate. Saying so is enough, and it is said where it will be
        // read rather than in a log nobody opens.
        const note = published.ok && !usesKit(action.slug)
          ? ' (this page does not use the house style — link /_kit/kit.css unless you meant to)'
          : '';
        await this.answer(action.id, 'page', published.ok
          ? { ok: true, items: [{ title: action.slug + note, url: published.url, published: null, text: '' }] }
          : { ok: false, error: published.error });
        break;
      }

      case 'chats': {
        if (!this.deps.config.agent.crossChat) {
          // Reported as a refusal rather than an empty list, the way `search`
          // and `fetch` report being switched off. An empty list cannot be told
          // apart from "switched on, but nobody to write to", and the agent
          // acting on that guess is how it ends up telling somebody the feature
          // is off when it is on.
          await this.answer(action.id, 'chats', {
            ok: false,
            error: 'cross-chat messaging is switched off by the operator',
          });
          return;
        }
        await this.answerChats(
          this.deps.chats
            .all()
            .filter((c) => !c.blocked)
            // Operator-listed destinations first, then by recency. A contact is
            // the answer to "who can I introduce myself to", and burying it
            // under whoever messaged most recently is how it goes unnoticed.
            .sort((a, b) => Number(b.contact) - Number(a.contact) || b.lastSeenAt - a.lastSeenAt)
            .slice(0, 30)
            .map((c) => ({
              chatKey: c.chatKey,
              name: c.name ?? 'someone',
              isGroup: c.isGroup,
              contact: c.contact,
            })),
          action.id,
        );
        break;
      }

      case 'image': {
        if (!this.deps.config.agent.images) return this.refuse('images');
        // Claimed before the request, so a slow provider cannot let two through
        // the same last unit of the day's allowance.
        if (!claim('images', this.deps.config.limits.imagesPerDay)) {
          log('outbox.imageCapped', { perDay: this.deps.config.limits.imagesPerDay });
          feed.event('image.capped', "today's picture allowance is spent");
          await this.deps.wa.sendText(turn.chatJid, 'I have made as many pictures as I can today — ask me again tomorrow.');
          feed.outbound(turn.chatKey, 'text', 'picture allowance spent');
          return;
        }
        const image = await generateImage(action.prompt);
        if (!image.ok) {
          log('outbox.imageFailed', { reason: image.error });
          feed.event('image.failed', image.error);
          return;
        }
        await this.deps.wa.sendImage(turn.chatJid, image.data, action.caption);
        retainOutbound(turn.chatKey, 'image', image.data);
        feed.outbound(turn.chatKey, 'image', action.caption ?? '[image]');
        break;
      }

      case 'voice': {
        if (!this.deps.config.agent.voice) return this.refuse('voice');
        const audio = await synthesise(action.text, this.deps.config.agent.voiceId);
        if (!audio.ok) {
          // Never drop the message: say it in text rather than stay silent.
          log('outbox.voiceFallback', { reason: audio.error });
          await this.deps.wa.sendText(turn.chatJid, action.text);
          feed.outbound(turn.chatKey, 'text', action.text);
          return;
        }
        await this.deps.wa.sendVoice(turn.chatJid, audio.data);
        retainOutbound(turn.chatKey, 'voice', audio.data);
        feed.outbound(turn.chatKey, 'voice', action.text);
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
