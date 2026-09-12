/**
 * Small persistent flags.
 *
 * Only two things live here, but both must survive a restart:
 *
 *   - **hold** — delivery is paused. Messages keep arriving, keep being
 *     recorded and keep queueing; they are simply not handed to the agent.
 *     Persisted because a restart quietly resuming delivery of messages an
 *     operator deliberately withheld is the opposite of what they asked for.
 *   - **generations** — a counter that, when bumped, changes the derived
 *     session id and so abandons the context. Stored per chat for history, but
 *     read as one number: see `sharedGeneration`. The old transcript is still
 *     on disk under its own id; this is a fresh start, not a deletion.
 *   - **stopped** — one room at a time, rather than the whole deployment. This
 *     is what `!stopjuan` writes, and it is deliberately *not* config: an
 *     operator's config file is their intent, and this is a runtime fact that
 *     anybody in the room can create. Keeping the two apart means a stop never
 *     rewrites the file an operator edits by hand, and a config reload never
 *     silently un-stops a room.
 *
 *     Persisted for the same reason `hold` is: a restart that quietly starts
 *     answering a room which asked for silence is the opposite of what was
 *     asked, and the people who asked are not watching the deployment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '@2lp/shared';
import { z } from 'zod';
import { log } from './log.js';
import { paths } from './paths.js';

const Persisted = z
  .object({
    hold: z
      .object({
        active: z.boolean().default(false),
        since: z.number().int().nullable().default(null),
        by: z.string().max(64).nullable().default(null),
      })
      .strict()
      .default({}),
    generations: z.record(z.string(), z.number().int().nonnegative()).default({}),
    stopped: z
      .record(
        z.string(),
        z
          .object({
            since: z.number().int(),
            /** Who asked, in words — this is shown to an operator, not matched on. */
            by: z.string().max(80),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

type Persisted = z.infer<typeof Persisted>;

const EMPTY: Persisted = { hold: { active: false, since: null, by: null }, generations: {}, stopped: {} };

class State {
  private data: Persisted = EMPTY;

  constructor(private readonly file = paths.state) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = Persisted.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) this.data = parsed.data;
      else log('state.invalid', { issues: parsed.error.issues.length, note: 'using defaults' });
    } catch (err) {
      log('state.loadFailed', { err: String((err as Error).message) });
    }
  }

  private flush(): void {
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      log('state.flushFailed', { err: String((err as Error).message) });
    }
  }

  isHeld(): boolean {
    return this.data.hold.active;
  }

  holdInfo(): Persisted['hold'] {
    return this.data.hold;
  }

  /**
   * Is this one chat stopped?
   *
   * Separate from `hold`, and both are checked: a hold silences everything, a
   * stop silences one room. Neither implies the other, and releasing the hold
   * must not start a room that asked to be left alone.
   */
  isStopped(chatKey: string): boolean {
    return this.data.stopped[chatKey] !== undefined;
  }

  stoppedInfo(chatKey: string): { since: number; by: string } | null {
    return this.data.stopped[chatKey] ?? null;
  }

  /** Every stopped chat, for the panel's Groups page. */
  stoppedAll(): Readonly<Record<string, { since: number; by: string }>> {
    return this.data.stopped;
  }

  setStopped(chatKey: string, by: string): void {
    this.data.stopped[chatKey] = { since: Date.now(), by: by.slice(0, 80) };
    this.flush();
  }

  clearStopped(chatKey: string): void {
    if (this.data.stopped[chatKey] === undefined) return;
    delete this.data.stopped[chatKey];
    this.flush();
  }

  setHold(active: boolean, by: string): void {
    this.data.hold = { active, since: active ? Date.now() : null, by };
    this.flush();
  }

  generation(chatKey: string): number {
    return this.data.generations[chatKey] ?? 0;
  }

  /**
   * The one session's generation: the highest any chat has reached.
   *
   * This was read per chat, and once a single session answered every chat that
   * was a live bug. The agent derives the shared session's id from the
   * generation of whichever chat is talking, so a chat reset once and a chat
   * never reset named two different sessions — and every switch between them
   * killed one and resumed the other. Two Juans taking turns, each missing what
   * the other had heard: a link delivered in a group was "never received" by
   * the Juan the operator then asked about it in a direct message.
   *
   * The highest wins so that no reset anybody already made is undone.
   */
  sharedGeneration(): number {
    return Math.max(0, ...Object.values(this.data.generations));
  }

  /**
   * Abandon the context — every chat's, since there is one session. Recorded
   * against the chat that asked, for the log. Returns the new generation.
   */
  newGeneration(chatKey: string): number {
    const next = this.sharedGeneration() + 1;
    this.data.generations[chatKey] = next;
    this.flush();
    return next;
  }
}

export const state = new State();
