/**
 * Token spend, read from Claude Code's own transcripts.
 *
 * The agent is the only side that can measure this. The bridge never talks to
 * the model API, and the transcripts live under `CLAUDE_CONFIG_DIR` on a volume
 * the bridge has no mount for — the same disjointness that keeps the agent away
 * from the WhatsApp credentials. So the numbers are summarised here and handed
 * over the wall as `usage.json`, where the bridge validates them and shows them.
 *
 * **Read incrementally, never re-read.** A week of transcripts on a busy
 * deployment is tens of megabytes, and this runs on a Raspberry Pi that is also
 * running a model session. So each file is tailed from the byte offset last
 * seen, and only files touched inside the window are opened at all. The parsed
 * events are kept in memory, pruned to the longest window, and re-bucketed on
 * each report — which costs an array scan rather than a filesystem walk.
 *
 * Deduplicated by message uuid, because a resumed session rewrites lines that
 * were already counted, and a retried request can carry the same usage twice.
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageReport, UsageWindow } from '@tulip/shared';
import { WORKSPACE_ROOT } from './workspace.js';
import { log } from './log.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** One assistant reply's spend. */
interface Event {
  readonly ts: number;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

function projectsDir(): string {
  return join(process.env['CLAUDE_CONFIG_DIR'] ?? join(WORKSPACE_ROOT, '.claude'), 'projects');
}

export class UsageMeter {
  private readonly events: Event[] = [];
  private readonly seen = new Set<string>();
  /** Byte offset already consumed, per transcript. */
  private readonly offsets = new Map<string, number>();

  constructor(private readonly root = projectsDir()) {}

  /** Walk the transcripts, consume anything new, and summarise. */
  report(now = Date.now()): UsageReport {
    try {
      this.scan(now);
    } catch (err) {
      // Never let accounting break the agent: a report that is stale or empty
      // is a cosmetic problem, and this runs beside the turn loop.
      log('usage.scanFailed', { err: String((err as Error).message) });
    }
    this.prune(now);
    return this.summarise(now);
  }

  private scan(now: number): void {
    let dirs: string[];
    try {
      dirs = readdirSync(this.root);
    } catch {
      return; // no transcripts yet
    }

    for (const dir of dirs) {
      const full = join(this.root, dir);
      let files: string[];
      try {
        files = readdirSync(full).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(full, file);
        try {
          // Skip anything untouched since before the window — its contents
          // cannot contribute, and opening it is the expensive part.
          if (statSync(path).mtimeMs < now - WEEK) continue;
          this.consume(path);
        } catch {
          /* a transcript being written; the next pass catches it */
        }
      }
    }
  }

  /** Read only the bytes appended since last time. */
  private consume(path: string): void {
    const from = this.offsets.get(path) ?? 0;
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      // Truncated or replaced: start again rather than read from a stale offset
      // into the middle of a line.
      const start = size < from ? 0 : from;
      if (size === start) return;

      const buffer = Buffer.allocUnsafe(size - start);
      let read = 0;
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, start + read);
        if (n <= 0) break;
        read += n;
      }

      const text = buffer.subarray(0, read).toString('utf8');
      // A trailing partial line is left for the next pass, so a record that was
      // half-written is never parsed as truncated JSON.
      const lastBreak = text.lastIndexOf('\n');
      if (lastBreak === -1) return;
      this.offsets.set(path, start + Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf8'));

      for (const line of text.slice(0, lastBreak).split('\n')) {
        this.take(line);
      }
    } finally {
      closeSync(fd);
    }
  }

  private take(line: string): void {
    if (line.length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const root = asRecord(record);
    if (root?.['type'] !== 'assistant') return;

    const uuid = typeof root['uuid'] === 'string' ? root['uuid'] : null;
    if (uuid === null || this.seen.has(uuid)) return;

    const message = asRecord(root['message']);
    const usage = asRecord(message?.['usage']);
    if (usage === null) return;

    const ts = Date.parse(String(root['timestamp'] ?? ''));
    if (!Number.isFinite(ts)) return;

    this.seen.add(uuid);
    this.events.push({
      ts,
      model: typeof message?.['model'] === 'string' ? message['model'].slice(0, 64) : 'unknown',
      input: count(usage['input_tokens']),
      output: count(usage['output_tokens']),
      cacheWrite: count(usage['cache_creation_input_tokens']),
      cacheRead: count(usage['cache_read_input_tokens']),
    });
  }

  private prune(now: number): void {
    const cutoff = now - WEEK;
    let drop = 0;
    while (drop < this.events.length && (this.events[drop]?.ts ?? 0) < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);
    // `seen` would otherwise grow without bound over a long uptime. Cleared
    // wholesale rather than tracked per id: the only cost of forgetting is that
    // a line already past the offset could be recounted, and offsets mean it is
    // never read again anyway.
    if (this.seen.size > 20_000) this.seen.clear();
  }

  private summarise(now: number): UsageReport {
    const byModel = new Map<string, number>();
    for (const e of this.events) {
      if (e.ts < now - WEEK) continue;
      byModel.set(e.model, (byModel.get(e.model) ?? 0) + e.input + e.output + e.cacheWrite + e.cacheRead);
    }

    return {
      at: new Date(now).toISOString(),
      hour: this.window(now - HOUR),
      day: this.window(now - DAY),
      week: this.window(now - WEEK),
      models: [...byModel.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, tokens]) => ({ name, tokens })),
    };
  }

  private window(since: number): UsageWindow {
    const total: UsageWindow = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, replies: 0 };
    for (const e of this.events) {
      if (e.ts < since) continue;
      total.input += e.input;
      total.output += e.output;
      total.cacheWrite += e.cacheWrite;
      total.cacheRead += e.cacheRead;
      total.replies += 1;
    }
    return total;
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

/** Defensive: these come from a file, and a missing field must not be NaN. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
