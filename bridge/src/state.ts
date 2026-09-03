/**
 * Small persistent flags.
 *
 * Only two things live here, but both must survive a restart:
 *
 *   - **hold** — delivery is paused. Messages keep arriving, keep being
 *     recorded and keep queueing; they are simply not handed to the agent.
 *     Persisted because a restart quietly resuming delivery of messages an
 *     operator deliberately withheld is the opposite of what they asked for.
 *   - **generations** — a per-chat counter that, when bumped, changes the
 *     derived session id and so abandons that conversation's context. The old
 *     transcript is still on disk under its own id; this is a fresh start, not
 *     a deletion.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '@tulip/shared';
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
  })
  .strict();

type Persisted = z.infer<typeof Persisted>;

const EMPTY: Persisted = { hold: { active: false, since: null, by: null }, generations: {} };

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

  setHold(active: boolean, by: string): void {
    this.data.hold = { active, since: active ? Date.now() : null, by };
    this.flush();
  }

  generation(chatKey: string): number {
    return this.data.generations[chatKey] ?? 0;
  }

  /** Abandon a chat's context. Returns the new generation. */
  newGeneration(chatKey: string): number {
    const next = this.generation(chatKey) + 1;
    this.data.generations[chatKey] = next;
    this.flush();
    return next;
  }
}

export const state = new State();
