/**
 * What Juan has said, and how to take it back.
 *
 * WhatsApp can edit a message and can retract one, but both need the message's
 * *key* — and every send path here threw it away, because `sendMessage`'s
 * return value was awaited and discarded. So this is not a lookup that was
 * missing; the handle never existed. This module is where it lives now.
 *
 * ─── Why the agent never sees a message id ───────────────────────────────────
 *
 * The obvious design hands the agent the WhatsApp id and takes it back on the
 * way in. That would be a mistake of the same shape as letting it name an
 * arbitrary URL: an id is an opaque string, the agent reads text written by
 * strangers, and "edit message 3A8B…" is a sentence anybody can type into
 * WhatsApp. Instead the agent counts backwards through its *own* recent
 * messages — `edit 1` is the last thing it said here — and the bridge resolves
 * that position against this store. The set of things reachable that way is
 * exactly "messages Juan sent, in the chat Juan is answering", which is the
 * bound we actually want, enforced on the trusted side.
 *
 * Persisted, unlike the `lastInbound` map that `react` uses. That one is
 * deliberately memory-only because a reaction to a pre-restart message is not
 * worth state. This is the opposite case: a correction is most wanted for
 * something said minutes ago, turns are separate processes, and a restart in
 * between is ordinary rather than exceptional.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '@2lp/shared';
import { z } from 'zod';
import { log } from './log.js';
import { paths } from './paths.js';

/**
 * How far back a correction can reach.
 *
 * WhatsApp enforces its own windows server-side — roughly a quarter of an hour
 * to edit, a couple of days to retract — and refuses anything older whatever we
 * keep. Holding keys a little past the longer of those means the failure an
 * operator sees is WhatsApp's real answer rather than our own forgetfulness.
 */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;

/** Per chat, so one busy conversation cannot crowd out every other. */
const KEEP_PER_CHAT = 20;

export interface SentRecord {
  /** The WhatsApp message id. Never leaves the bridge. */
  readonly id: string;
  /** `text`, `image`, `voice` … — what kind of thing was sent. */
  readonly kind: string;
  /** The words, where there were any. Kept so a correction can show both. */
  readonly text: string | null;
  readonly at: number;
  /** Set once retracted, so the record survives the message. */
  readonly unsent?: boolean;
  /** What it said before the most recent edit, oldest first. */
  readonly wasText?: readonly string[];
  /**
   * The uid of this message's row in the feed.
   *
   * Carried so `tulip-wa sent` can number its rows with the exact positions
   * `edit -n` will resolve. Matching the two lists on text and timestamp
   * instead would be a guess, and a guess here edits the wrong message.
   */
  readonly feedUid?: string;
}

const SentRow = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.string().min(1).max(32),
    text: z.string().max(8000).nullable(),
    at: z.number().int(),
    unsent: z.boolean().optional(),
    wasText: z.array(z.string().max(8000)).max(10).optional(),
    feedUid: z.string().max(64).optional(),
  })
  .strict();

const Persisted = z.record(z.string(), z.array(SentRow)).default({});

type Store = Record<string, SentRecord[]>;

export class Sent {
  private data: Store = {};
  private loaded = false;

  constructor(private readonly file = paths.sent) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const parsed = Persisted.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) this.data = parsed.data as Store;
      else log('sent.invalid', { issues: parsed.error.issues.length, note: 'starting empty' });
    } catch (err) {
      log('sent.loadFailed', { err: String((err as Error).message) });
    }
  }

  private flush(): void {
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      log('sent.flushFailed', { err: String((err as Error).message) });
    }
  }

  /** Drop what WhatsApp would refuse anyway, and cap each chat. */
  private prune(chatKey: string, now: number): void {
    const list = (this.data[chatKey] ?? []).filter((r) => now - r.at < KEEP_MS);
    if (list.length > KEEP_PER_CHAT) list.splice(0, list.length - KEEP_PER_CHAT);
    if (list.length === 0) delete this.data[chatKey];
    else this.data[chatKey] = list;
  }

  /**
   * Remember a message that just went out.
   *
   * Called from the one place every outbound passes through, so a send that
   * forgets to record itself is a send that cannot be corrected — and the
   * failure is silent. `id` absent means WhatsApp did not tell us, which
   * happens; the message is simply not correctable and nothing else breaks.
   */
  record(chatKey: string, id: string | null, kind: string, text: string | null, feedUid?: string): void {
    // `typeof`, not `=== null`: the id arrives from Baileys through several
    // hands and undefined is as likely as null. Testing only for null and then
    // reading `.length` threw inside the send path — which is the one place a
    // failure is least acceptable, since the message has already gone out.
    if (typeof id !== 'string' || id.length === 0) return;
    if (!/^[0-9a-f]{16}$/.test(chatKey)) return;
    this.load();
    const now = Date.now();
    const list = this.data[chatKey] ?? [];
    list.push({ id, kind, text, at: now, ...(feedUid === undefined ? {} : { feedUid }) });
    this.data[chatKey] = list;
    this.prune(chatKey, now);
    this.flush();
  }

  /**
   * Messages still correctable in this chat, newest first.
   *
   * Retracted ones stay in the store — the audit trail needs them — but are not
   * offered again, so `edit 1` never means "edit the thing I just deleted".
   */
  recent(chatKey: string, limit = KEEP_PER_CHAT): SentRecord[] {
    this.load();
    const now = Date.now();
    return (this.data[chatKey] ?? [])
      .filter((r) => r.unsent !== true && now - r.at < KEEP_MS)
      .slice(-limit)
      .reverse();
  }

  /** The nth most recent, 1-based. `nth(key, 1)` is the last thing Juan said. */
  nth(chatKey: string, n: number): SentRecord | null {
    if (!Number.isInteger(n) || n < 1) return null;
    return this.recent(chatKey)[n - 1] ?? null;
  }

  /**
   * Feed-row uid to the position `edit -n` would resolve, for this chat.
   *
   * So the numbers an operator or the agent reads in a listing are the same
   * numbers the correction verbs take, rather than two independent countings
   * that agree until they do not.
   */
  positions(chatKey: string): Map<string, number> {
    const out = new Map<string, number>();
    this.recent(chatKey).forEach((row, i) => {
      if (row.feedUid !== undefined) out.set(row.feedUid, i + 1);
    });
    return out;
  }

  /**
   * Feed uids of messages retracted here.
   *
   * `recent` deliberately hides retracted rows, so that nothing can be edited
   * or taken back twice — which also means it is the wrong place to ask what
   * *was* taken back. The panel needs that: a deleted message keeps its words
   * on screen, struck through, because the words are gone from every phone in
   * the conversation and this is the only surviving record of them.
   */
  retractedUids(chatKey: string): Set<string> {
    this.load();
    const out = new Set<string>();
    for (const row of this.data[chatKey] ?? []) {
      if (row.unsent === true && row.feedUid !== undefined) out.add(row.feedUid);
    }
    return out;
  }

  /** Fold a new text into the record, keeping every earlier version. */
  edited(chatKey: string, id: string, text: string): void {
    this.load();
    const list = this.data[chatKey];
    if (!list) return;
    const at = list.findIndex((r) => r.id === id);
    if (at === -1) return;
    const row = list[at] as SentRecord;
    list[at] = {
      ...row,
      text,
      wasText: [...(row.wasText ?? []), row.text ?? ''].slice(-10),
    };
    this.flush();
  }

  /** Mark retracted. The row stays: the feed's account of it must still resolve. */
  retracted(chatKey: string, id: string): void {
    this.load();
    const list = this.data[chatKey];
    if (!list) return;
    const at = list.findIndex((r) => r.id === id);
    if (at === -1) return;
    list[at] = { ...(list[at] as SentRecord), unsent: true };
    this.flush();
  }

  /**
   * Forget everything held in memory.
   *
   * A testing seam, and the reason the class is exported: a suite can point an
   * instance at its own file rather than reaching for the module-level one.
   */
  reset(): void {
    this.data = {};
    this.loaded = true;
  }
}

export const sent = new Sent();
