/**
 * The bridge's side of the two handoff volumes.
 *
 * Writing is straightforward — the bridge owns the inbound volume. Reading is
 * where the care goes: `readStatus` parses a file written by the untrusted
 * container, so it is validated like anything else off the wire and a failure
 * returns null rather than throwing into the delivery loop.
 *
 * **How much the bridge believes the agent's status.** The agent reports when a
 * turn starts and finishes, and the dispatcher uses that to advance *early*. It
 * never uses it to wait longer: a turn is abandoned at `turnTimeoutMs` whatever
 * the status file says. So a lying agent can make itself receive the next batch
 * sooner — harmless, it is the same agent — or claim to be busy forever, which
 * the timer overrides. Neither is a way to affect another chat.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { AgentStatus, InboxBatch, CurrentTurn, inPaths, outPaths, writeJsonAtomic } from '@tulip/shared';
import type { InboxBatch as InboxBatchType, AgentStatus as AgentStatusType } from '@tulip/shared';
import { log } from './log.js';

/** Create the directory structure both containers expect. */
export function ensureHandoffDirs(): void {
  for (const dir of [inPaths.batches, inPaths.media, outPaths.actions, outPaths.files]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Write a batch and point the current-turn file at it.
 *
 * Order matters: the batch is written first, so the agent can never read a
 * pointer to a file that is not there yet. Both writes are atomic, so it can
 * never read half of either.
 */
export function publishTurn(batch: InboxBatchType): void {
  const validated = InboxBatch.parse(batch);
  writeJsonAtomic(inPaths.batch(validated.turnId), validated, 0o644);

  const current = CurrentTurn.parse({
    turnId: validated.turnId,
    chatKey: validated.chatKey,
    chatName: validated.chatName,
    isGroup: validated.isGroup,
    batch: `batches/${validated.turnId}.json`,
    startedAt: new Date().toISOString(),
  });
  writeJsonAtomic(inPaths.current, current, 0o644);
}

/** Remove a delivered batch once its turn is finished. */
export function retireBatch(turnId: string): void {
  try {
    rmSync(inPaths.batch(turnId), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Read the agent's self-report.
 *
 * Untrusted input: validated, never trusted for a security decision, and null
 * on any problem. A missing or malformed status simply means the dispatcher
 * falls back entirely to its own timers.
 */
export function readStatus(): AgentStatusType | null {
  let raw: string;
  try {
    raw = readFileSync(outPaths.status, 'utf8');
  } catch {
    return null; // the agent has not started, or has not reported yet
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = AgentStatus.safeParse(parsed);
  if (!result.success) {
    log('handoff.statusInvalid', { issues: result.error.issues.length });
    return null;
  }
  return result.data;
}
