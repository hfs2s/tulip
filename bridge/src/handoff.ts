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
import { AgentStatus, InboxBatch, CurrentTurn, UsageReport, inPaths, outPaths, writeJsonAtomic } from '@tulip/shared';
import type {
  CurrentTurn as CurrentTurnType,
  InboxBatch as InboxBatchType,
  AgentStatus as AgentStatusType,
  UsageReport as UsageReportType,
} from '@tulip/shared';
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
export function publishTurn(
  batch: InboxBatchType,
  can?: CurrentTurnType['can'],
  generation = 0,
): void {
  const validated = InboxBatch.parse(batch);
  writeJsonAtomic(inPaths.batch(validated.turnId), validated, 0o644);

  const current = CurrentTurn.parse({
    turnId: validated.turnId,
    chatKey: validated.chatKey,
    chatName: validated.chatName,
    isGroup: validated.isGroup,
    batch: `batches/${validated.turnId}.json`,
    startedAt: new Date().toISOString(),
    generation,
    // Omitted rather than guessed when the caller does not say: every field
    // defaults to on, and the bridge refuses for real regardless.
    ...(can === undefined ? {} : { can }),
  });
  writeJsonAtomic(inPaths.current, current, 0o644);
}

/**
 * The turn that was open when this process last stopped, if there is one.
 *
 * The turn registry is in memory, so a restart forgets every open turn — and an
 * action written by the agent a second later resolves to nothing and is
 * discarded as unroutable. That is not theoretical: it happened twice in one
 * day, and the second time it silently dropped a voice note and a message the
 * operator had asked for. The agent reported success both times, because from
 * inside the container "the file I wrote disappeared" is indistinguishable from
 * "the bridge sent it".
 *
 * `current.json` is written before injection and is exactly the missing piece,
 * so the registry can be rebuilt from it. This is safe in a way that inventing
 * a turn would not be: the file is on the inbound volume, which the agent
 * mounts read-only, so the id it names is one this bridge issued and not one an
 * agent chose for itself.
 *
 * Null when there is no pointer, when it is unreadable, or when the turn it
 * names is older than the timeout — a stale pointer from days ago should not
 * resurrect a turn that everybody has forgotten.
 */
export function readCurrentTurn(maxAgeMs: number, now = Date.now()): CurrentTurnType | null {
  let parsed: CurrentTurnType;
  try {
    parsed = CurrentTurn.parse(JSON.parse(readFileSync(inPaths.current, 'utf8')));
  } catch {
    return null;
  }
  const startedAt = Date.parse(parsed.startedAt);
  if (!Number.isFinite(startedAt) || now - startedAt > maxAgeMs) return null;
  return parsed;
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

/**
 * Token spend, as reported by the agent.
 *
 * Validated exactly like the status file and for the same reason: it is written
 * by the container this design assumes an attacker owns. Nothing reads it but
 * the panel — no limit, no gate and no delivery decision depends on it — so the
 * worst a fabricated number can do is show an operator the wrong figure. It is
 * still schema-checked, because "only displayed" is not a reason to hand
 * unvalidated JSON to a renderer.
 */
export function readUsage(): UsageReportType | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outPaths.usage, 'utf8'));
  } catch {
    return null; // not reported yet
  }

  const result = UsageReport.safeParse(parsed);
  if (!result.success) {
    log('handoff.usageInvalid', { issues: result.error.issues.length });
    return null;
  }
  return result.data;
}
