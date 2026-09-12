/**
 * The record of what actually happened to every message.
 *
 * The structured log records *events*; this records *messages*, including the
 * ones that were refused and why. Both exist because a silently dropped message
 * is indistinguishable from one that never arrived — which is how half of
 * Iris's traffic went unnoticed for weeks, and the single most useful thing
 * that codebase learned.
 *
 * Written before any gating decision, so the feed answers "did it arrive?"
 * separately from "was it answered?".
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { paths } from './paths.js';

/** Rotate once the file passes this, keeping the newer half. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface FeedEntry {
  ts: number;
  uid: string;
  kind: 'in' | 'out' | 'delivered' | 'event' | 'edited' | 'unsent';
  chatKey?: string;
  chatName?: string | null;
  isGroup?: boolean;
  /** Sender display name. Never a phone number: the feed is shown in a browser. */
  from?: string | null;
  text?: string | null;
  accepted?: boolean;
  reason?: string | null;
  /**
   * The WhatsApp message id, on inbound rows only.
   *
   * Recorded so an operator can react to something further back than the last
   * message. It was never kept before, which is why reacting could only ever
   * reach the most recent thing said — the bridge simply had no handle on
   * anything older, and none of the messages already on screen when this
   * shipped will have one.
   *
   * Never sent to the agent. `sent.ts` argues that at length for outbound ids
   * and the reasoning is identical here: an id is an opaque string, the agent
   * reads text written by strangers, and "react to message 3A8B…" is a sentence
   * anybody can type. The panel is the trusted side and may hold one; the
   * container may not.
   */
  waId?: string | null;
  /** Whose message it was, in a group. WhatsApp needs it to place a reaction. */
  participant?: string | null;
  media?: Array<{ kind: string; bytes: number | null }>;
  count?: number;
  event?: string;
  detail?: string | null;
  /**
   * What a message said before it was edited or retracted.
   *
   * The whole point of recording a correction. WhatsApp shows the recipient the
   * new text — or nothing at all — so if the feed simply overwrote its own row
   * there would be no surviving account of what was actually delivered. These
   * are appended rather than applied, and the original is never dropped.
   */
  was?: string | null;
  /** Who made the correction: the agent, or an operator in the panel. */
  by?: 'agent' | 'operator';
}

class Feed extends EventEmitter {
  private append(entry: Omit<FeedEntry, 'ts' | 'uid'>): FeedEntry {
    const row: FeedEntry = { ts: Date.now(), uid: randomUUID(), ...entry };
    try {
      mkdirSync(paths.root, { recursive: true });
      this.rotate();
      appendFileSync(paths.feed, `${JSON.stringify(row)}\n`);
    } catch {
      /* observability must never break delivery */
    }
    this.emit('entry', row);
    return row;
  }

  private rotate(): void {
    try {
      if (statSync(paths.feed).size < MAX_BYTES) return;
      const lines = readFileSync(paths.feed, 'utf8').split('\n');
      const kept = lines.slice(Math.floor(lines.length / 2)).join('\n');
      // Via a temporary, so a crash mid-rotation cannot leave an empty feed.
      const tmp = `${paths.feed}.rotating`;
      writeFileSync(tmp, kept, { mode: 0o600 });
      renameSync(tmp, paths.feed);
    } catch {
      /* nothing to rotate, or no room to do it */
    }
  }

  /** Every inbound message, before the gate sees it. */
  inbound(row: {
    chatKey: string;
    chatName: string | null;
    isGroup: boolean;
    from: string | null;
    text: string;
    media: Array<{ kind: string; bytes: number | null }>;
    accepted: boolean;
    reason: string | null;
    waId?: string | null;
    participant?: string | null;
  }): FeedEntry {
    return this.append({ kind: 'in', ...row });
  }

  /** Handed to the agent as a turn. */
  delivered(chatKey: string, count: number): FeedEntry {
    return this.append({ kind: 'delivered', chatKey, count });
  }

  /** Sent back to WhatsApp. */
  outbound(chatKey: string, kind: string, text: string | null): FeedEntry {
    return this.append({ kind: 'out', chatKey, text, detail: kind });
  }

  /**
   * A message's words replaced after delivery.
   *
   * Appended beside the original `out` row rather than modifying it, so the
   * feed reads as a history: what was sent, then what it became. An operator
   * scrolling back can always see what a recipient first saw.
   */
  edited(chatKey: string, was: string | null, now: string, by: 'agent' | 'operator'): FeedEntry {
    return this.append({ kind: 'edited', chatKey, was, text: now, by });
  }

  /** A message retracted for everyone. The words it carried are kept here. */
  unsent(chatKey: string, was: string | null, by: 'agent' | 'operator'): FeedEntry {
    return this.append({ kind: 'unsent', chatKey, was, text: null, by });
  }

  /** Anything an operator should see: fatal states, restarts, refusals in bulk. */
  event(event: string, detail?: string): FeedEntry {
    return this.append({ kind: 'event', event, detail: detail ?? null });
  }

  /** Most recent `n` entries, oldest first. */
  recent(n = 200): FeedEntry[] {
    try {
      return readFileSync(paths.feed, 'utf8')
        .trimEnd()
        .split('\n')
        .slice(-n)
        .map((line): FeedEntry | null => {
          try {
            return JSON.parse(line) as FeedEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is FeedEntry => e !== null);
    } catch {
      return [];
    }
  }
}

export const feed = new Feed();
