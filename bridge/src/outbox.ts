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
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  OutboxAction,
  ToolResult,
  inPaths,
  outPaths,
  writeJsonAtomic,
  canRecall,
  describeSpec,
  formatLocal,
} from '@2lp/shared';
import type { OutboxAction as OutboxActionType } from '@2lp/shared';
import { feed } from './feed.js';
import { search, type ExaOutcome } from './exa.js';
import { readPage } from './browse.js';
import { APPS_PLUGIN, NOT_THE_BOX, NOT_YOUR_APP, WORKSPACE_ARG, mayUse, setLabel } from './apps.js';
import {
  EXCHANGE_CLOSED, NO_CHAINING, NO_SUCH_PEER, NOT_OPERATOR,
  askOwed, isAnswerTurn, peerByHandle, peerOf, withMark,
} from './peers.js';
import { callPlugin, listCallable } from './pluginCalls.js';
import { configured as apimartReady, generateImage as apimartImage } from './apimart.js';
import { referencePaths } from './images.js';
import { generateImage, synthesise } from './minimax.js';
import { log } from './log.js';
import { retainOutbound } from './mediaStore.js';
import { sent } from './sent.js';
import { claim } from './spend.js';
import {
  imageCount,
  MAX_IMAGES_PER_PAGE,
  hashPagePassword,
  mayChange,
  unpublishPage,
  NO_NEW_PAGES,
  NOT_YOURS,
  databaseNotes,
  publishPage,
  scaffoldPage,
  usesKit,
  writePageImage,
} from './pages.js';
import { addContact } from './contacts.js';
import { resolveVoice, voiceless } from './voice.js';
import { remember } from './memory.js';
import { cancelSchedule, createSchedule, schedulesFor } from './schedule.js';
import { lastInbound, recentMessages } from './history.js';
import type { Limiter } from './ratelimit.js';
import type { Cost, Turn, TurnRegistry } from './turns.js';
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
  /** Persist page passwords. Injected so the outbox does not reach into the panel's API. */
  readonly setPagePasswords: (passwords: Readonly<Record<string, { salt: string; hash: string }>>) => void;
  /** Where callable plugins live. Defaults to the plugins mount; tests point it elsewhere. */
  readonly pluginsDir?: string;
}

/**
 * Watches the outbound volume and performs what it finds there.
 *
 * Polls rather than relying on `fs.watch`: the two sides are different
 * containers writing to a shared volume, where watch semantics vary by
 * filesystem and driver. A one-second delay is a much smaller problem than a
 * reply that is never sent.
 */
/**
 * Actions that put something in front of a person.
 *
 * These spend the turn's send allowance and the destination's outbound rate.
 * Everything else either delivers nothing (`search`, `page`, `remember`,
 * `contact` …) or costs nothing at all (`typing`), and charging them here was
 * a real bug rather than an over-cautious default: the five-picture page the
 * persona recommends spent all eight of a turn's sends before the message
 * carrying the link was written, and that message was then refused.
 *
 * `edit` and `unsend` are deliberately absent, and so cost a tool rather than a
 * send. Neither puts a *new* message in front of anybody: one replaces words
 * already delivered and charged for, the other removes them. Rationing them
 * alongside new messages would mean a turn that spent its allowance could no
 * longer fix what it spent it on, which is exactly backwards.
 */
const DELIVERS: ReadonlySet<string> = new Set(['text', 'sendTo', 'file', 'image', 'voice', 'react']);

/** What one action costs its turn. `typing` is cosmetic and free. */
/**
 * Where inbound photos live, and which provider an operator prefers.
 *
 * The root matches the dispatcher's own media root so a reference names the
 * same file the agent was shown. The preference is an environment variable
 * rather than config.json because it names a credential's provider, which is
 * what `.env` is for everywhere else here.
 */
const MEDIA_ROOT = join(inPaths.root, 'media');
const preferApimart = (): boolean => {
  const named = (process.env['TULIP_IMAGE_PROVIDER'] ?? '').trim().toLowerCase();
  if (named === 'apimart') return true;
  if (named === 'minimax') return false;
  // Unset: whichever can do the most. A deployment that has configured the
  // reference-capable one plainly wants it.
  return apimartReady();
};

function costOf(kind: string): Cost {
  if (kind === 'typing') return 'free';
  return DELIVERS.has(kind) ? 'send' : 'tool';
}

export class Outbox extends EventEmitter {
  private readonly attempts = new Map<string, number>();
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly deps: OutboxDeps) {
    super();
  }

  /**
   * Send text, and keep the handle that makes it correctable.
   *
   * A method rather than two lines repeated at seven call sites, because the
   * failure mode of repeating them is invisible: forget `sent.record` at one
   * site and that message simply cannot be edited later, with nothing to
   * indicate why. `logged` exists for the one caller that sends a truncated
   * message but records the whole of what the agent wrote.
   */
  private async sayText(chatKey: string, jid: string, text: string, logged?: string): Promise<void> {
    const id = await this.deps.wa.sendText(jid, text);
    sent.record(chatKey, id, 'text', text, feed.outbound(chatKey, 'text', logged ?? text).uid);
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
  /**
   * A capability the operator has switched off.
   *
   * This used to log, write a feed event, and stop — both of which an operator
   * reads and neither of which the person waiting sees. Worse, `wa-cli` has
   * already written its `spoke` marker by the time an action reaches here, so
   * the Stop hook does not relay a closing message either: with a capability off,
   * first time the agent reached for one the turn ended in complete silence,
   * which is the single outcome its brief forbids.
   *
   * So a refusal now falls back to whatever words already exist. A voice note
   * has its own text — the fallback is lossless, and the same one synthesis
   * failure already used. A picture has a caption or it has nothing, and a
   * caption is usually the sentence the picture was illustrating.
   *
   * Nothing is invented where there are no words: a bare picture with no
   * caption is decoration, and losing it costs nobody their reply. What must
   * not happen is a *reply* being lost, and that is what this prevents.
   */
  private async refuse(
    capability: string,
    dest: { jid: string; key: string },
    fallback: string | null,
  ): Promise<void> {
    log('outbox.capabilityOff', { capability, spoken: fallback !== null });
    feed.event('capability.off', `${capability} is switched off; the agent asked for it`);
    const words = (fallback ?? '').trim();
    if (words.length === 0) return;
    await this.sayText(dest.key, dest.jid, words.slice(0, 4000), words);
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
      await this.sayText(turn.chatKey, turn.chatJid, text);
      log('outbox.holding', { chatKey: turn.chatKey, why: 'a page is being built' });
    } catch (err) {
      // A holding message that fails must not fail the thing it announced.
      log('outbox.holdingFailed', { err: String((err as Error).message) });
    }
  }

  private async answer(
    actionId: string,
    kind:
      | 'search' | 'fetch' | 'chats' | 'page' | 'contact' | 'sent' | 'history' | 'schedule' | 'edit' | 'unsend'
      | 'leaveGroup' | 'plugin' | 'app' | 'peer',
    outcome: ExaOutcome,
  ): Promise<void> {
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
   * Resolve a chat the agent named, or refuse.
   *
   * Three checks, in this order, and all three are the point: the operator's
   * switch is on, the key is one this bridge actually issued, and the chat is
   * not blocked. A forged key fails the second — `jidFor` is a lookup, not a
   * derivation, so an invented one has no destination at all.
   *
   * Shared by every verb that can name a destination so there is exactly one
   * copy of the rule. When `sendTo` owned its own copy, adding a second
   * cross-chat verb meant remembering to write the checks again.
   */
  private crossChatTarget(chatKey: string): { jid: string; key: string } | null {
    if (!this.deps.config.agent.crossChat) {
      log('outbox.crossChatRefused', { note: 'agent.crossChat is off' });
      feed.event('crossChat.refused', 'the agent tried to message another chat');
      return null;
    }
    const jid = this.deps.chats.jidFor(chatKey);
    if (jid === null) {
      log('outbox.unknownChat', { chatKey });
      return null; // a key the bridge never issued resolves to nothing
    }
    if (this.deps.chats.isBlocked(chatKey)) {
      log('outbox.blockedChat', { chatKey });
      return null;
    }
    return { jid, key: chatKey };
  }

  /**
   * Perform one validated action.
   *
   * Note what is *not* read from `action`: a phone number, or a jid. A
   * destination is either the turn's own chat — resolved through a registry the
   * agent cannot write — or a `chatKey` this bridge issued and an operator has
   * allowed. Those are the only two things it can be.
   */
  private async perform(action: OutboxActionType): Promise<void> {
    const now = Date.now();
    const cost = costOf(action.kind);
    const resolution = this.deps.turns.resolve(action.turnId, now, cost);
    if (!resolution.ok) {
      log('outbox.unroutable', { id: action.id, kind: action.kind, reason: resolution.reason });
      return; // dropped, not retried: an unroutable turn never becomes routable
    }
    const { turn } = resolution;

    // Where this one goes. `chatKey` is absent on most kinds and null by
    // default on the media verbs, and both mean the same thing: the chat whose
    // turn this is. Resolved once, here, so no verb below can accidentally send
    // to the turn's chat while reporting it went somewhere else.
    //
    // `leaveGroup` is the exception. Its key names the group to leave, not a
    // chat to deliver to, and it resolves that itself — after the operator
    // check, and with an answer for every refusal. Sent through here it would
    // be dropped in silence whenever cross-chat was off, which is a switch
    // about something else entirely.
    let dest = { jid: turn.chatJid, key: turn.chatKey, crossed: false };
    if ('chatKey' in action && action.chatKey !== null && action.kind !== 'leaveGroup') {
      const target = this.crossChatTarget(action.chatKey);
      if (target === null) return; // refused and logged
      dest = { jid: target.jid, key: target.key, crossed: true };
    }

    // Only something a person receives spends the outbound rate, and it is
    // charged to the *destination* — the chat being written into. It used to be
    // charged to the turn's chat, so a cross-chat send spent the sender's
    // budget and the recipient had no ceiling of their own; one conversation
    // could be used to flood another.
    //
    // A tool request delivers nothing, so it spends the turn's separate tool
    // budget instead and no chat's rate at all. Both budgets exist; neither is
    // the other's spare capacity.
    if (cost === 'send') {
      const allowance = this.deps.limiter.admitOutbound(dest.key, now);
      if (!allowance.ok) {
        log('outbox.throttled', { chatKey: dest.key, reason: allowance.reason });
        return;
      }
      this.deps.turns.countSend(action.turnId);
    } else if (cost === 'tool') {
      this.deps.turns.countTool(action.turnId);
    }

    switch (action.kind) {
      case 'text': {
        // Talking back to another agent, where the exchange is shaped by the
        // bridge rather than by either agent's good manners.
        //
        // A reply in a peer's chat is that peer's answer, so it goes out marked
        // as one — the asking side then knows the exchange is closed and says
        // so in its banner. And once an answer has arrived, nothing more may be
        // sent into that chat at all: "do not write back" in a prompt is a
        // suggestion, and two of these will happily be polite to each other
        // until the month's budget is gone.
        const peer = peerOf(this.deps.config, this.deps.chats.get(turn.chatKey));
        if (peer !== null) {
          if (isAnswerTurn(turn.turnId)) {
            log('peers.refused', { chatKey: turn.chatKey, peer: peer.handle, why: 'exchange closed' });
            await this.answer(action.id, 'peer', { ok: false, error: EXCHANGE_CLOSED });
            break;
          }
          await this.sayText(turn.chatKey, turn.chatJid, withMark('answer', askOwed(turn.chatKey), action.text));
          break;
        }
        await this.sayText(turn.chatKey, turn.chatJid, action.text);
        break;
      }
      case 'file': {
        const file = resolveOutboundFile(action.file);
        if (!file.ok) {
          log('outbox.fileRefused', { id: action.id, name: action.file, reason: file.reason });
          feed.event('outbox.fileRefused', `${action.file}: ${file.reason}`);
          return;
        }
        const filed = await this.deps.wa.sendFile(dest.jid, file.data, file.mimetype, action.file, action.caption);
        retainOutbound(dest.key, 'file', file.data, file.mimetype);
        sent.record(dest.key, filed, 'file', action.caption, feed.outbound(dest.key, file.mimetype, action.caption).uid);
        // Sent files are removed: the volume is not storage, and leaving them
        // lets a compromised agent fill the disk one send at a time. Deleting
        // by name is safe in a way that *reading* by name is not — if the agent
        // has swapped a symlink in since, this unlinks the link, not its target.
        rmSync(file.unlinkPath, { force: true });
        break;
      }
      // Tool requests. These do not send anybody a message, so they are not
      // charged against the outbound allowance above — but they do leave the
      // deployment, which is why they are rate-limited by turn instead, against
      // `limits.toolsPerTurn`. That sentence was true of no code for a long
      // time: everything but `typing` was charged as a send, and this comment
      // was the only place the intended design was written down.
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
        // Not awaited, and that is deliberate. `drain` performs actions one at
        // a time, and a page read in a browser — with the search provider
        // behind it — can take most of a minute. Awaited here, it would hold
        // every other chat's reply behind one person's link. The browser still
        // sees one page at a time (browse.ts queues them), the per-turn tool
        // allowance described above is unchanged, and neither `readPage` nor
        // `answer` throws. See bridge/src/browse.ts for the order it tries.
        void readPage(action.id, action.url, action.screenshot).then((outcome) =>
          this.answer(action.id, 'fetch', outcome),
        );
        break;
      }
      // Text to a named chat. Its destination was resolved above, like every
      // other verb's; what is left here is just the send. Gated on
      // `agent.crossChat`; off by default. See THREAT-MODEL.md T4.
      case 'sendTo': {
        await this.sayText(dest.key, dest.jid, action.text);
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

      /**
       * Promise something for later, into this chat.
       *
       * `turn.chatKey` is the destination and there is nowhere else it could
       * have come from — the action carries no `chatKey` field at all, so the
       * cross-chat question is not answered here, it is never asked. See the
       * schema in shared/src/handoff.ts.
       *
       * Charged as a *tool*, alongside `remember` and `search`, because it
       * delivers nothing at the moment it is called. The eventual send spends
       * the destination's hourly outbound allowance on the day it happens, in
       * `Scheduler.fire`. Both budgets exist; neither is the other's spare
       * capacity — see the comment above `DELIVERS`.
       */
      case 'schedule': {
        if (!this.deps.config.agent.schedule) {
          // Answered rather than spoken, and this is the one refusal in this
          // file that must never be quiet: the failure being designed against
          // is a reminder promised in words that no machinery could keep. The
          // agent waits for this answer and prints it, so "cannot" reaches the
          // person before "done" ever gets a chance to.
          await this.answer(action.id, 'schedule', {
            ok: false,
            error:
              'Reminders are switched off by the operator, so nothing was scheduled. Say so plainly — do not ' +
              'promise to remind them, and offer to send something now instead.',
          });
          break;
        }
        // Who asked, and what they actually said — read from the bridge's own
        // feed rather than accepted from the action. The agent may ask for a
        // reminder; it may not author the evidence that a person requested one.
        const asked = lastInbound(turn.chatKey);
        const made = createSchedule(this.deps.config, {
          chatKey: turn.chatKey,
          spec: action.spec,
          text: action.text,
          createdBy: 'agent',
          requestedBy: asked?.from ?? null,
          sourceText: asked?.text ?? null,
          sourceAt: asked?.at ?? null,
        });
        if (!made.ok) {
          log('schedule.refused', { chatKey: turn.chatKey, reason: made.error.slice(0, 80) });
          await this.answer(action.id, 'schedule', { ok: false, error: made.error });
          break;
        }
        // Loud on purpose, exactly like `memory.remembered` above. A message
        // that will arrive in somebody's chat later, with no human in the loop
        // at the time, is precisely the thing an operator should scroll past
        // even if they never open the page.
        feed.event(
          'schedule.created',
          `a reminder was set for ${formatLocal(Date.parse(made.entry.nextAt ?? ''), made.entry.timezone)}` +
            `: ${made.entry.text.slice(0, 120)}`,
        );
        await this.answer(action.id, 'schedule', {
          ok: true,
          items: [
            {
              // The id, so the agent can tell somebody how to call it off.
              title: made.entry.id,
              // The resolved absolute time, spelled out with its zone. Quoting
              // it back is what stops two people meaning different nine
              // o'clocks — see shared/src/schedule.ts.
              url: formatLocal(Date.parse(made.entry.nextAt ?? ''), made.entry.timezone),
              published: null,
              text: describeSpec(made.entry.spec, made.entry.timezone),
            },
          ],
        });
        break;
      }

      case 'scheduleCancel': {
        if (!this.deps.config.agent.schedule) {
          await this.answer(action.id, 'schedule', {
            ok: false,
            error: 'Reminders are switched off by the operator, so I cannot change them.',
          });
          break;
        }
        // Scoped to this chat. An id from another conversation gets the same
        // answer as an invented one, so this is not a way to find out what
        // anybody else has been promised.
        const dropped = cancelSchedule(action.scheduleId, turn.chatKey);
        if (dropped.ok) feed.event('schedule.cancelled', `a reminder was called off: ${dropped.entry.text.slice(0, 120)}`);
        await this.answer(action.id, 'schedule', dropped.ok
          ? { ok: true, items: [{ title: dropped.entry.id, url: '', published: null, text: dropped.entry.text }] }
          : { ok: false, error: dropped.error });
        break;
      }

      case 'scheduleList': {
        if (!this.deps.config.agent.schedule) {
          await this.answer(action.id, 'schedule', {
            ok: false,
            error: 'Reminders are switched off by the operator, so there are none to list.',
          });
          break;
        }
        // This chat's own, and nothing else's. `schedulesFor` filters by key;
        // the key comes from the turn, which the agent cannot choose.
        const mine = schedulesFor(turn.chatKey).filter((e) => e.state === 'active');
        await this.answer(action.id, 'schedule', {
          ok: true,
          items: mine.slice(0, 40).map((e) => ({
            title: e.id,
            url: e.nextAt === null ? '' : formatLocal(Date.parse(e.nextAt), e.timezone),
            published: e.spec.kind === 'cron' ? e.spec.expression : null,
            text: e.text.slice(0, 300),
          })),
        });
        break;
      }

      case 'pageImage': {
        if (!mayChange(this.deps.config, action.slug, turn.chatKey, this.deps.chats.get(turn.chatKey))) {
          log('pages.refused', { chatKey: turn.chatKey, slug: action.slug, verb: 'pageImage' });
          await this.answer(action.id, 'page', { ok: false, error: NOT_YOURS });
          break;
        }
        // Answered rather than spoken: this one the agent waits for, so telling
        // it is both possible and better — it can write the page without the
        // picture instead of stopping. The other three are fire-and-forget.
        if (!this.deps.config.agent.images) {
          log('outbox.capabilityOff', { capability: 'images', spoken: false });
          feed.event('capability.off', 'images is switched off; the agent asked for it');
          await this.answer(action.id, 'page', {
            ok: false,
            error: 'pictures are switched off by the operator — write the page without one',
          });
          break;
        }
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
        // Checked before the holding message below, not after: refusing second
        // would promise somebody a page and then take it back.
        if (!mayChange(this.deps.config, action.slug, turn.chatKey, this.deps.chats.get(turn.chatKey))) {
          log('pages.refused', { chatKey: turn.chatKey, slug: action.slug, verb: 'pageNew' });
          await this.answer(action.id, 'page', {
            ok: false,
            error: this.deps.config.pages.grants[action.slug] === undefined ? NO_NEW_PAGES : NOT_YOURS,
          });
          break;
        }
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

      case 'pageDelete': {
        // Same grant as changing it. Taking a page down is a smaller act than
        // rewriting it, and anyone who may do the second may do the first.
        if (!mayChange(this.deps.config, action.slug, turn.chatKey, this.deps.chats.get(turn.chatKey))) {
          log('pages.refused', { chatKey: turn.chatKey, slug: action.slug, verb: 'pageDelete' });
          await this.answer(action.id, 'page', { ok: false, error: NOT_YOURS });
          break;
        }
        const taken = unpublishPage(action.slug);
        await this.answer(action.id, 'page', taken.ok
          ? {
              ok: true,
              items: [{
                title: action.slug,
                url: '',
                published: null,
                text: 'Taken down — the link now says the page does not exist. Nothing was deleted, so an operator can put it back.',
              }],
            }
          : { ok: false, error: taken.error });
        break;
      }

      case 'pagePassword': {
        if (!mayChange(this.deps.config, action.slug, turn.chatKey, this.deps.chats.get(turn.chatKey))) {
          log('pages.refused', { chatKey: turn.chatKey, slug: action.slug, verb: 'pagePassword' });
          await this.answer(action.id, 'page', { ok: false, error: NOT_YOURS });
          break;
        }
        const clearing = action.password.length === 0;
        const passwords = { ...this.deps.config.pages.passwords };
        if (clearing) delete passwords[action.slug];
        else passwords[action.slug] = hashPagePassword(action.password);
        this.deps.setPagePasswords(passwords);
        // Never echoed back, not even to confirm. The reply travels through
        // WhatsApp and sits in somebody's chat history afterwards.
        log('pages.password', { chatKey: turn.chatKey, slug: action.slug, set: !clearing });
        await this.answer(action.id, 'page', {
          ok: true,
          items: [{
            title: action.slug,
            url: '',
            published: null,
            text: clearing
              ? 'Password removed — anyone with the link can read it again.'
              : 'Password set. Visitors are asked for it before the page loads. Do not repeat it back to anyone in writing; send it the way you would any other password.',
          }],
        });
        break;
      }

      case 'page': {
        if (!mayChange(this.deps.config, action.slug, turn.chatKey, this.deps.chats.get(turn.chatKey))) {
          log('pages.refused', { chatKey: turn.chatKey, slug: action.slug, verb: 'page' });
          await this.answer(action.id, 'page', { ok: false, error: NOT_YOURS });
          break;
        }
        // The address comes back as an ordinary result item, so the answer file
        // keeps one shape. A page has no text to carry — the point is the URL.
        const published = publishPage(action.slug);
        // Published either way: a page that opted out of the house style is a
        // choice the agent is allowed to make, and refusing would turn a look
        // into a gate. Saying so is enough, and it is said where it will be
        // read rather than in a log nobody opens.
        // The same goes for a database the page cannot actually read.
        const notes = published.ok
          ? [
            ...(usesKit(action.slug) ? [] : ['this page does not use the house style — link /_kit/kit.css unless you meant to']),
            ...databaseNotes(action.slug),
          ]
          : [];
        const note = notes.length > 0 ? ` (${notes.join('; ')})` : '';
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

      /**
       * Issue a chat key for a number an operator gave the agent.
       *
       * The whole control is the first line. Not a switch an operator can leave
       * on and forget, and not a check on who the agent *says* asked — the turn
       * itself has to be an operator writing directly, which the dispatcher
       * decided from the envelope before the agent saw anything.
       *
       * So the worst a stranger can do by asking for this is get a refusal. A
       * stranger who takes over the agent entirely gets the same refusal, from
       * every turn they can reach.
       */
      /**
       * What actually left, from the bridge's own record.
       *
       * Outbound only — see the schema. The agent's own words are its to read
       * back; anybody else's are not, and this must never become a way to read
       * a conversation it is not in.
       *
       * `answer` is used rather than the feed's own shape so it arrives in the
       * vocabulary the agent already has from `chats` and `search`.
       */
      case 'sent': {
        const key = action.chatKey ?? turn.chatKey;
        if (action.chatKey !== null && this.crossChatTarget(action.chatKey) === null) {
          await this.answer(action.id, 'sent', {
            ok: false,
            error: 'that is not a chat you may look at — `tulip-wa chats` lists the ones you can',
          });
          break;
        }
        const rows = feed
          .recent(4000)
          .filter((e) => e.kind === 'out' && e.chatKey === key)
          .slice(-action.n);
        // `published` carries the correctable position rather than a date —
        // the shared answer shape has no field for it, and inventing a second
        // shape for one caller costs more than borrowing this one. Null means
        // the message is past WhatsApp's window, which is worth showing.
        const slots = sent.positions(key);
        await this.answer(action.id, 'sent', {
          ok: true,
          items: rows.map((e) => ({
            title: new Date(e.ts).toISOString(),
            url: e.detail ?? 'text',
            published: e.uid !== undefined && slots.has(e.uid) ? String(slots.get(e.uid)) : null,
            text: (e.text ?? '').slice(0, 200),
          })),
        });
        break;
      }

      case 'history': {
        // The one action that reads inward. The gate is a shared function
        // rather than three conditions written here, because "who may read
        // whose conversation" is the sort of rule that ends up subtly different
        // in its second copy — and it is tested on its own.
        //
        // `isGroup` is read from the chat record for the chat that *asked*, not
        // the one being read. `fromOperator` is already false in a group, so
        // this is a second lock on the same door — kept because it is the
        // condition this capability most depends on, and because that rule has
        // been reversed once already.
        const verdict = canRecall({
          enabled: this.deps.config.agent.recall,
          fromOperator: turn.fromOperator,
          askedInGroup: this.deps.chats.get(turn.chatKey)?.isGroup === true,
        });
        if (!verdict.allowed) {
          log('outbox.recallRefused', { chatKey: turn.chatKey, reason: verdict.reason.slice(0, 60) });
          feed.event('recall.refused', 'a chat asked to read another conversation and was refused');
          await this.answer(action.id, 'history', { ok: false, error: verdict.reason });
          break;
        }

        const target = this.deps.chats.get(action.chatKey);
        if (target === undefined || target === null) {
          await this.answer(action.id, 'history', {
            ok: false,
            error: 'No conversation with that key. Use `tulip-wa chats` to see the keys you can name.',
          });
          break;
        }

        const messages = recentMessages(action.chatKey, action.limit);
        const refused = messages.filter((m) => m.refused !== null).length;
        // Loud on success too, not only on refusal. A capability that reads
        // private messages should leave a trail an operator scrolls past even
        // when it worked, which is the same argument memory.ts makes for notes.
        // The refused count is part of that trail: it is the difference between
        // reading a conversation and reading a room that was never answered.
        log('recall.read', {
          asked: turn.chatKey,
          read: action.chatKey,
          messages: messages.length,
          refused,
        });
        feed.event(
          'recall.read',
          `an operator asked to read ${target?.name ?? 'a conversation'} ` +
            `(${messages.length} messages, ${refused} never answered)`,
        );

        await this.answer(action.id, 'history', {
          ok: true,
          items: messages.map((m) => ({
            title: m.from,
            url: m.at,
            // The refusal reason rides `published`: it is the one free slot in
            // the shared item shape, and a recalled message has no publication
            // date competing for it. Null means the message was delivered.
            published: m.refused === null ? null : m.refused.slice(0, 40),
            text: m.text.slice(0, 400),
          })),
        });
        break;
      }

      case 'contact': {
        if (!turn.fromOperator) {
          log('outbox.contactRefused', { chatKey: turn.chatKey, note: 'not an operator turn' });
          feed.event('contact.refused', 'a number was offered from a chat that is not an operator');
          await this.answer(action.id, 'contact', {
            ok: false,
            error:
              'Only an operator can add somebody, and only by writing to you directly. ' +
              'Ask them to send you the number themselves, or to add it in the panel.',
          });
          break;
        }
        const added = addContact({ config: this.deps.config, chats: this.deps.chats }, action.number, action.label);
        if (!added.ok) {
          log('outbox.contactFailed', { reason: added.error });
          await this.answer(action.id, 'contact', { ok: false, error: added.error });
          break;
        }
        log('contacts.issued', { chatKey: added.chatKey, already: added.already });
        // Recorded for the operator, without the number: the feed is read in
        // the panel and shown beside message text, and a phone number written
        // into it is a phone number in a screenshot.
        feed.event(
          'contact.added',
          added.already
            ? `${action.label} was already a contact`
            : `${action.label} can now be messaged`,
        );
        await this.answer(action.id, 'contact', {
          ok: true,
          items: [
            {
              title: action.label,
              url: added.chatKey,
              published: null,
              // The same word `chats` uses for a listed destination, so the
              // agent reads one vocabulary rather than two.
              text: 'contact',
            },
          ],
        });
        break;
      }

      /**
       * Leave a group, because an operator asked.
       *
       * The same gate as `contact`, in the same place: the first check is the
       * turn's provenance, which the dispatcher decided from the sender's jid
       * before the agent saw anything. `carriesOperatorAuthority` never grants a
       * room that authority, whoever spoke in it, so today the path that works is
       * an operator in their own direct message naming the group by key. The
       * refusal names `!stopjuan` because that is what a member who wants Juan
       * quiet actually needs, and it needs nobody's permission.
       *
       * Charged as a tool, like `contact`: leaving delivers nothing. The goodbye
       * does, so it is charged separately and exactly as a send would be — to
       * the turn's send allowance and to the group's outbound rate.
       *
       * Every refusal is answered and does nothing. The goodbye is never sent
       * unless the leave is about to be attempted, and a leave WhatsApp refused
       * is never reported as done: the agent would otherwise tell an operator it
       * had gone from a room it is still in. The chat record is left alone — if
       * somebody adds Juan back, that is their decision, and a block would
       * quietly overrule it.
       */
      case 'leaveGroup': {
        if (!turn.fromOperator) {
          log('outbox.leaveRefused', { chatKey: turn.chatKey, note: 'not an operator turn' });
          feed.event('group.leaveRefused', 'the agent was asked to leave a group by somebody who is not an operator');
          await this.answer(action.id, 'leaveGroup', {
            ok: false,
            error: 'Only an operator can ask me to leave a group. In the room, !stopjuan silences me straight away.',
          });
          break;
        }

        const record = this.deps.chats.get(action.chatKey ?? turn.chatKey);
        const jid = record === null ? null : this.deps.chats.jidFor(record.chatKey);
        if (record === null || jid === null) {
          log('outbox.leaveUnknown', { chatKey: action.chatKey ?? turn.chatKey });
          await this.answer(action.id, 'leaveGroup', {
            ok: false,
            error: 'There is no chat with that key, so nothing was done. Group keys come from the chats listing.',
          });
          break;
        }
        if (!record.isGroup) {
          log('outbox.leaveNotGroup', { chatKey: record.chatKey });
          await this.answer(action.id, 'leaveGroup', {
            ok: false,
            error:
              'That is a direct chat, not a group, so there is nothing to leave and nothing was done. ' +
              'From a direct message, name the group by its key.',
          });
          break;
        }
        const name = record.name ?? 'the group';

        if (action.goodbye !== null) {
          // `resolve` above only checked the tool allowance. Asked again here
          // for the send one, which is the question a normal send would have
          // been asked — and refused *before* leaving rather than after, because
          // a goodbye that could not be sent cannot be sent later either.
          const allowance = this.deps.turns.resolve(action.turnId, now, 'send');
          const rate = allowance.ok ? this.deps.limiter.admitOutbound(record.chatKey, now) : null;
          if (!allowance.ok || rate === null || !rate.ok) {
            log('outbox.throttled', {
              chatKey: record.chatKey,
              reason: allowance.ok ? rate?.ok === false ? rate.reason : 'unknown' : allowance.reason,
              note: 'a goodbye before leaving',
            });
            await this.answer(action.id, 'leaveGroup', {
              ok: false,
              error:
                'I have used up the messages I may send right now, so the goodbye could not go out — and I have ' +
                'not left, because afterwards I could not say it. Ask again later, or without a goodbye.',
            });
            break;
          }
          this.deps.turns.countSend(action.turnId);
          try {
            await this.sayText(record.chatKey, jid, action.goodbye);
          } catch (err) {
            log('outbox.goodbyeFailed', { chatKey: record.chatKey, err: String((err as Error).message) });
            await this.answer(action.id, 'leaveGroup', {
              ok: false,
              error: `The goodbye could not be sent (${String((err as Error).message).slice(0, 80)}), so I have not left.`,
            });
            break;
          }
        }

        try {
          await this.deps.wa.leaveGroup(jid);
        } catch (err) {
          const why = String((err as Error).message).slice(0, 80);
          log('outbox.leaveFailed', { chatKey: record.chatKey, err: why });
          feed.event('group.leaveFailed', `could not leave ${name}: ${why}`);
          await this.answer(action.id, 'leaveGroup', {
            ok: false,
            error:
              `WhatsApp would not let me leave ${name} (${why}), so I am still in it.` +
              (action.goodbye === null ? '' : ' The goodbye had already gone out.'),
          });
          break;
        }

        log('group.left', { chatKey: record.chatKey, askedFrom: turn.chatKey, goodbye: action.goodbye !== null });
        this.deps.chats.setLeft(record.chatKey, Date.now());
        this.deps.chats.flush();
        // Loud, like `recall.read`: something an operator should scroll past in
        // the panel even if they were not the one who asked.
        feed.event('group.left', `left ${name} because an operator asked`);
        await this.answer(action.id, 'leaveGroup', {
          ok: true,
          items: [
            {
              title: name,
              url: record.chatKey,
              published: null,
              text:
                `Left ${name}.` +
                (action.goodbye === null ? '' : ' The goodbye went out first.') +
                ' Only somebody in the group can add me back.',
            },
          ],
        });
        break;
      }

      /**
       * Callable plugins — services on the host the agent may ask things of.
       *
       * Both are tools: they put nothing in front of anybody, so they spend the
       * turn's tool allowance, charged above. Every rule about which plugin,
       * which action, which arguments and whose turn lives in pluginCalls.ts,
       * so there is one copy of it; `fromOperator` is read from the turn, which
       * the dispatcher decided from the envelope and a group never carries.
       */
      case 'pluginList': {
        await this.answer(action.id, 'plugin', listCallable(this.deps.config, turn.fromOperator, this.deps.pluginsDir));
        break;
      }
      case 'peerAsk': {
        /**
         * Asking another agent, with both gates that bound it.
         *
         * Operator only, because text from a stranger becoming a second
         * agent's input is the laundering path worth refusing by default; and
         * never from inside an exchange with a peer, because that is how three
         * agents end up in a conversation nobody is reading.
         */
        if (!turn.fromOperator) {
          log('peers.refused', { chatKey: turn.chatKey, peer: action.peer, why: 'not an operator' });
          await this.answer(action.id, 'peer', { ok: false, error: NOT_OPERATOR });
          break;
        }
        if (peerOf(this.deps.config, this.deps.chats.get(turn.chatKey)) !== null) {
          log('peers.refused', { chatKey: turn.chatKey, peer: action.peer, why: 'already a peer turn' });
          await this.answer(action.id, 'peer', { ok: false, error: NO_CHAINING });
          break;
        }
        const target = peerByHandle(this.deps.config, action.peer);
        if (target === null) {
          await this.answer(action.id, 'peer', { ok: false, error: NO_SUCH_PEER });
          break;
        }
        // The id is the bridge's, so an answer can be recognised as one. The
        // marker is added here and never by the agent.
        const askId = randomBytes(4).toString('hex');
        const jid = `${target.number}@s.whatsapp.net`;
        await this.deps.wa.sendText(jid, withMark('ask', askId, action.text));
        log('peers.asked', { peer: target.handle, askId, chars: action.text.length });
        feed.event('peer.asked', `${target.label}: ${action.text.slice(0, 120)}`);
        await this.answer(action.id, 'peer', {
          ok: true,
          items: [{
            title: target.label,
            url: target.handle,
            published: null,
            text: `Asked ${target.label}. Their answer will arrive as a message from them, in its own turn — ` +
              `nothing more is needed from you until then.`,
          }],
        });
        break;
      }

      case 'appLabel': {
        // The same grant as working on it, for the same reason a page's delete
        // shares its page's grant: naming somebody's app is a smaller act than
        // running commands in it, and anyone who may do the second may do this.
        if (!mayUse(this.deps.config, action.workspace, turn.chatKey, this.deps.chats.get(turn.chatKey), turn.fromOperator)) {
          log('apps.refused', { chatKey: turn.chatKey, workspace: action.workspace, verb: 'appLabel' });
          await this.answer(action.id, 'app', { ok: false, error: NOT_YOUR_APP });
          break;
        }
        const named = setLabel(action.workspace, action.label, turn.chatKey);
        if (!named.ok) {
          await this.answer(action.id, 'app', { ok: false, error: named.error ?? 'the label was refused' });
          break;
        }
        const said = action.label.trim().length === 0
          ? `${action.workspace} has no name now.`
          : `${action.workspace} is called “${action.label.trim()}” here.`;
        feed.event('app.labelled', said);
        await this.answer(action.id, 'app', {
          ok: true,
          items: [{ title: action.workspace, url: action.workspace, published: null, text: said }],
        });
        break;
      }

      case 'pluginCall': {
        // Whose app is it? Every rule about which plugin, which action and
        // whose turn lives in pluginCalls.ts — except this one, which cannot:
        // only this side knows that `workspace` names an app on the hfs2s box
        // and that `apps.grants` says who may have it worked on. Checked
        // before the call is written, because the drop-box has no undo.
        //
        // A call that names no workspace — `status`, `box` — is not about one
        // app and is governed by `operatorOnly` alone, as before.
        if (action.plugin === APPS_PLUGIN) {
          const workspace = action.args[WORKSPACE_ARG];
          if (typeof workspace === 'string' && workspace.length > 0) {
            if (!mayUse(this.deps.config, workspace, turn.chatKey, this.deps.chats.get(turn.chatKey), turn.fromOperator)) {
              log('apps.refused', { chatKey: turn.chatKey, workspace, verb: action.action });
              await this.answer(action.id, 'plugin', { ok: false, error: NOT_YOUR_APP });
              break;
            }
          } else if (!turn.fromOperator) {
            // Names no workspace, so it is about the box: the listing of every
            // client's app, or the machine's disk and memory. A grant cannot
            // scope those, and granting one app is not consent to see the rest
            // — so they stay with the operator even where `operatorOnly` is off.
            log('apps.refused', { chatKey: turn.chatKey, workspace: '(none)', verb: action.action });
            await this.answer(action.id, 'plugin', { ok: false, error: NOT_THE_BOX });
            break;
          }
        }
        // Not awaited, for the reason `fetch` is not: `drain` performs actions
        // one at a time, and a plugin may take minutes to answer. Awaited here
        // it would hold every other chat's reply behind one call. `callPlugin`
        // never throws and neither does `answer`.
        void callPlugin({
          config: this.deps.config,
          plugin: action.plugin,
          action: action.action,
          args: action.args,
          fromOperator: turn.fromOperator,
          ...(this.deps.pluginsDir === undefined ? {} : { root: this.deps.pluginsDir }),
        }).then((outcome) => this.answer(action.id, 'plugin', outcome));
        break;
      }

      case 'image': {
        if (!this.deps.config.agent.images) return this.refuse('images', dest, action.caption);
        // Claimed before the request, so a slow provider cannot let two through
        // the same last unit of the day's allowance.
        if (!claim('images', this.deps.config.limits.imagesPerDay)) {
          log('outbox.imageCapped', { perDay: this.deps.config.limits.imagesPerDay });
          feed.event('image.capped', "today's picture allowance is spent");
          await this.sayText(
            dest.key, dest.jid,
            'I have made as many pictures as I can today — ask me again tomorrow.',
            'picture allowance spent',
          );
          return;
        }
        // Which provider, and why it can be decided here rather than configured.
        //
        // References are the whole point of the second one: MiniMax takes a
        // prompt and nothing else, so a request that works from a photo can
        // only go to APIMart. With no references either will do, and the
        // operator's preference is an environment variable like every other
        // provider choice in this file.
        const named = action.refs ?? [];
        const { paths: refs, refused } = named.length === 0
          ? { paths: [] as string[], refused: 0 }
          : referencePaths(MEDIA_ROOT, turn.chatKey, named);
        if (refused > 0) {
          log('outbox.imageRefsRefused', { chatKey: turn.chatKey, refused, named: named.length });
        }
        if (named.length > 0 && refs.length === 0) {
          await this.sayText(
            dest.key, dest.jid,
            'I could not find those pictures in this conversation, so I have not made anything.',
            'image references refused',
          );
          return;
        }

        const useApimart = refs.length > 0 || preferApimart();
        if (refs.length > 0 && !apimartReady()) {
          await this.sayText(
            dest.key, dest.jid,
            'I can only work from a picture when the image service that accepts one is configured, and it is not.',
            'no reference-capable image provider',
          );
          return;
        }
        const image = useApimart
          ? await apimartImage(action.prompt, refs)
          : await generateImage(action.prompt);
        if (!image.ok) {
          log('outbox.imageFailed', { reason: image.error });
          feed.event('image.failed', image.error);
          return;
        }
        const pictured = await this.deps.wa.sendImage(dest.jid, image.data, action.caption);
        retainOutbound(dest.key, 'image', image.data);
        sent.record(
          dest.key, pictured, 'image', action.caption,
          feed.outbound(dest.key, 'image', action.caption ?? '[image]').uid,
        );
        break;
      }

      case 'voice': {
        if (!this.deps.config.agent.voice) return this.refuse('voice', dest, action.text);

        // Which mouth reads this, decided before anything is spent — the whole
        // resolution is pure, and one of its answers is "none".
        //
        // The message's own language wins over the deployment's, so the agent
        // can answer a Barcelona group and a Filipino one in the same evening
        // without an operator flipping a setting between them. Empty is the
        // ordinary case and means "whatever the operator chose".
        //
        // Resolved here rather than in the agent, because the row decides two
        // things and only one of them is the agent's business: which boost the
        // request carries, and which voice reads it. The second is an
        // operator's choice and the agent should not be able to name a voice.
        //
        // Resolved by `voice.ts` rather than here, so the panel's test bench
        // and this line cannot disagree about which mouth a language gets. A
        // bench that plays a different voice from the one an actual note uses
        // is worse than no bench.
        const chosen = resolveVoice(this.deps.config, action.language);

        // Some languages the provider will *pronounce* and cannot *speak*.
        // Swedish has a boost and not one voice, so a Swedish voice note was a
        // Spanish mouth sounding out Swedish words — an impression rather than
        // an accent, and worse than not speaking at all.
        //
        // So it goes as text, which is the same fallback a synthesis failure
        // and a spent allowance already take: the words always arrive, and only
        // the audio is lost. Checked before `claim`, deliberately — nothing was
        // synthesised, so nothing should be billed against the day.
        if (voiceless(chosen)) {
          log('outbox.voiceless', { language: chosen.spoken?.name ?? '', note: 'sent as text; no voice exists for it' });
          feed.event(
            'voice.noMouth',
            `${chosen.spoken?.name ?? 'that language'} has no voice, so it was sent as a message instead`,
          );
          await this.sayText(dest.key, dest.jid, action.text);
          break;
        }

        // Metered like pictures, and for the same reason: synthesis is billed
        // per call. This was unmetered while voice could only ever answer the
        // person in front of it, which bounded it by the conversation; a voice
        // note that can be aimed at another chat has no such bound.
        //
        // Claimed before the request, so a slow provider cannot let two through
        // the same last unit of the day's allowance.
        if (!claim('voice', this.deps.config.limits.voicePerDay)) {
          log('outbox.voiceCapped', { perDay: this.deps.config.limits.voicePerDay });
          feed.event('voice.capped', "today's voice allowance is spent");
          // Said in text rather than swallowed. The daily cap is our problem,
          // not the listener's, and silence is the one outcome that reads as a
          // fault on their end.
          await this.sayText(dest.key, dest.jid, action.text);
          break;
        }
        const audio = await synthesise(action.text, chosen.voiceId, chosen.boost);
        if (!audio.ok) {
          // Never drop the message: say it in text rather than stay silent.
          log('outbox.voiceFallback', { reason: audio.error });
          await this.sayText(dest.key, dest.jid, action.text);
          return;
        }
        const spoken = await this.deps.wa.sendVoice(dest.jid, audio.data);
        // Keep the script. `action.text` is exactly what the voice says — it was
        // synthesised from it a line ago — so the Media page can show the words
        // instead of a play button and the phrase "Play to hear it".
        retainOutbound(dest.key, 'voice', audio.data, undefined, action.text);
        sent.record(dest.key, spoken, 'voice', action.text, feed.outbound(dest.key, 'voice', action.text).uid);
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
      /**
       * Correct or retract something already said, in this chat only.
       *
       * `action.nth` is a position in Juan's own recent messages, never an id —
       * see shared/src/handoff.ts. Resolution happens here, against a store on
       * the state volume the agent cannot read, so the worst a hostile message
       * can talk the agent into is amending one of its own recent replies in
       * the conversation it is already answering.
       */
      case 'edit': {
        const target = sent.nth(turn.chatKey, action.nth);
        if (target === null) {
          await this.answer(action.id, 'edit', {
            ok: false,
            error: `you have not said ${String(action.nth)} things here recently — \`tulip-wa sent\` lists them`,
          });
          break;
        }
        if (target.kind !== 'text') {
          // WhatsApp edits text. A picture cannot become a different picture.
          await this.answer(action.id, 'edit', {
            ok: false,
            error: `that one was a ${target.kind}, and WhatsApp only edits text. \`tulip-wa unsend\` can take it back.`,
          });
          break;
        }
        try {
          await this.deps.wa.editText(turn.chatJid, target.id, action.text);
        } catch (err) {
          // Almost always the fifteen-minute window having closed. Say so
          // plainly: the agent may otherwise tell somebody it fixed something.
          await this.answer(action.id, 'edit', {
            ok: false,
            error:
              'WhatsApp refused the edit — usually because it is more than about fifteen minutes old. '
              + `Say what you meant in a new message instead. (${String((err as Error).message)})`,
          });
          break;
        }
        sent.edited(turn.chatKey, target.id, action.text);
        feed.edited(turn.chatKey, target.text, action.text, 'agent');
        await this.answer(action.id, 'edit', { ok: true, items: [] });
        break;
      }

      case 'unsend': {
        const target = sent.nth(turn.chatKey, action.nth);
        if (target === null) {
          await this.answer(action.id, 'unsend', {
            ok: false,
            error: `you have not said ${String(action.nth)} things here recently — \`tulip-wa sent\` lists them`,
          });
          break;
        }
        try {
          await this.deps.wa.unsend(turn.chatJid, target.id);
        } catch (err) {
          await this.answer(action.id, 'unsend', {
            ok: false,
            error:
              'WhatsApp refused the deletion — usually because it is too old to retract. '
              + `(${String((err as Error).message)})`,
          });
          break;
        }
        sent.retracted(turn.chatKey, target.id);
        feed.unsent(turn.chatKey, target.text, 'agent');
        await this.answer(action.id, 'unsend', { ok: true, items: [] });
        break;
      }

      case 'typing': {
        await this.deps.wa.typing(turn.chatJid, action.on);
        break;
      }
    }

    // `dest.key`, not `turn.chatKey`: the panel, the feed and the log should
    // all name the conversation this landed in.
    if (dest.crossed) {
      // Recorded against both chats, so a message that crossed conversations
      // is visible from the one it came from as well as the one it went to.
      // Emitted here rather than in each verb, so it can only be written on a
      // path that actually reached `sendX` — a refusal returns before this.
      feed.event('crossChat.sent', `${turn.chatKey} -> ${dest.key} (${action.kind})`);
    }
    this.emit('sent', { chatKey: dest.key, kind: action.kind });
    log('outbox.sent', { chatKey: dest.key, kind: action.kind, crossed: dest.crossed });
  }
}
