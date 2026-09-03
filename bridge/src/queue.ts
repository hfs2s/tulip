/**
 * Messages accepted but not yet handed to the agent, kept on disk.
 *
 * An in-memory queue is fine while the wait is three seconds. It stops being
 * fine once delivery can be held indefinitely on purpose, or once a serial
 * queue can back up behind a slow turn: losing an hour-old message to a restart
 * is worse than never having queued it.
 *
 * One file per message, named so that a lexical sort is chronological, written
 * atomically so a reader never sees a partial envelope.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '@tulip/shared';
import type { Envelope } from './envelope.js';
import { log } from './log.js';
import { paths } from './paths.js';

/** An envelope plus the chat key it was filed under. */
export interface QueuedMessage {
  chatKey: string;
  envelope: Envelope;
}

export class Queue {
  constructor(private readonly directory = paths.queue) {
    mkdirSync(this.directory, { recursive: true });
  }

  private fileFor(envelope: Envelope): string {
    const safeId = String(envelope.id).replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'msg';
    return join(this.directory, `${envelope.ts}-${safeId}.json`);
  }

  add(chatKey: string, envelope: Envelope): void {
    try {
      writeJsonAtomic(this.fileFor(envelope), { chatKey, envelope } satisfies QueuedMessage);
    } catch (err) {
      log('queue.writeFailed', { err: String((err as Error).message) });
    }
  }

  /** Forget these — they have been delivered. */
  remove(messages: readonly QueuedMessage[]): void {
    for (const message of messages) {
      try {
        rmSync(this.fileFor(message.envelope), { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  /** Everything still waiting, chronological. Unreadable files are dropped. */
  all(): QueuedMessage[] {
    let names: string[];
    try {
      names = readdirSync(this.directory).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }

    const out: QueuedMessage[] = [];
    for (const name of names) {
      const file = join(this.directory, name);
      try {
        out.push(JSON.parse(readFileSync(file, 'utf8')) as QueuedMessage);
      } catch {
        rmSync(file, { force: true });
      }
    }
    return out;
  }

  /** Grouped by chat, preserving arrival order — the shape the dispatcher wants. */
  byChat(): Map<string, QueuedMessage[]> {
    const map = new Map<string, QueuedMessage[]>();
    for (const message of this.all()) {
      const list = map.get(message.chatKey);
      if (list) list.push(message);
      else map.set(message.chatKey, [message]);
    }
    return map;
  }

  get size(): number {
    try {
      return readdirSync(this.directory).filter((n) => n.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}
