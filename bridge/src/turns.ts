/**
 * The turn registry — the control that makes cross-chat exfiltration
 * unrepresentable rather than merely discouraged.
 *
 * The attack it exists to stop: a stranger injects the agent and asks it to
 * forward another user's conversation, or its own instructions, to a number the
 * attacker controls. In the design Tulip is forked from this works, because the
 * agent's send command takes a `--to` argument and the bridge honours it.
 *
 * Here the agent cannot express the idea. Outbound actions carry a `turnId` and
 * nothing else; this registry is the only `turnId → chat` map, it lives in the
 * bridge, and the agent's mount of the volume the map would have to be written
 * to is read-only. So the worst a compromised agent can do is name a turn:
 *
 *   - a turn it was given          → its reply goes where that turn came from
 *   - a turn belonging to someone  → refused, the id is unguessable (a v4 UUID)
 *   - an expired turn              → refused
 *   - an invented id               → refused
 *
 * Expiry is the subtle one. Without it, an agent could sit on a turn id from an
 * hour ago and use it to push messages into a conversation the person had
 * moved on from. A turn is a short-lived capability to speak once, into one
 * place, and it goes stale on its own.
 */
import { randomUUID } from 'node:crypto';

export interface Turn {
  readonly turnId: string;
  readonly chatJid: string;
  readonly chatKey: string;
  readonly openedAt: number;
  /**
   * Whether this turn is an operator talking to Tulip directly.
   *
   * Established here, at the trusted boundary, from the envelope the dispatcher
   * parsed — never re-derived later from a chat record, and never anything the
   * agent can influence. Actions that must come from an operator read this and
   * nothing else.
   *
   * A group is never an operator turn even when an operator is in it: the point
   * of the flag is that one identified person chose to do this, and a room with
   * strangers in it cannot carry that.
   */
  readonly fromOperator: boolean;
  /** Sends already performed for this turn, against `limits.outboundPerTurn`. */
  sends: number;
  closedAt: number | null;
}

export type Resolution =
  | { ok: true; turn: Turn }
  | { ok: false; reason: 'unknown' | 'expired' | 'send limit reached' };

/**
 * Bounded, expiring store of open turns.
 *
 * A turn stays resolvable for a grace period after it closes: the agent's final
 * message is often queued microseconds after the Stop hook fires, and refusing
 * it would drop the actual reply.
 */
export class TurnRegistry {
  private readonly turns = new Map<string, Turn>();

  constructor(
    /** How long a turn may be used to send, from when it was opened. */
    private readonly ttlMs: number,
    /** Sends permitted per turn. */
    private readonly maxSends: number,
    /** Turns retained before the oldest is evicted. */
    private readonly capacity = 512,
  ) {}

  /** Begin a turn for a chat and return its unguessable id. */
  open(chatJid: string, chatKey: string, now: number, fromOperator = false): Turn {
    const turn: Turn = {
      turnId: randomUUID(),
      chatJid,
      chatKey,
      openedAt: now,
      fromOperator,
      sends: 0,
      closedAt: null,
    };
    this.turns.set(turn.turnId, turn);
    this.evict(now);
    return turn;
  }

  /** Mark a turn finished. It remains resolvable until it expires. */
  close(turnId: string, now: number): void {
    const turn = this.turns.get(turnId);
    if (turn && turn.closedAt === null) turn.closedAt = now;
  }

  /**
   * Resolve an id supplied by the agent to the chat it may send to.
   *
   * This is a trust boundary: `turnId` arrives from the untrusted side, so it is
   * looked up rather than parsed, and a miss is a refusal with no detail. The
   * caller sends only to `turn.chatJid`, never to anything in the action.
   */
  resolve(turnId: unknown, now: number): Resolution {
    if (typeof turnId !== 'string') return { ok: false, reason: 'unknown' };
    const turn = this.turns.get(turnId);
    if (!turn) return { ok: false, reason: 'unknown' };
    if (now - turn.openedAt > this.ttlMs) return { ok: false, reason: 'expired' };
    if (turn.sends >= this.maxSends) return { ok: false, reason: 'send limit reached' };
    return { ok: true, turn };
  }

  /** Count a performed send against this turn's allowance. */
  countSend(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn) turn.sends += 1;
  }

  /** The turn currently open for a chat, if any. Used by the typing indicator. */
  openFor(chatKey: string, now: number): Turn | null {
    for (const turn of this.turns.values()) {
      if (turn.chatKey === chatKey && turn.closedAt === null && now - turn.openedAt <= this.ttlMs) {
        return turn;
      }
    }
    return null;
  }

  /**
   * Drop expired turns, then oldest-first if still over capacity.
   *
   * Map iteration is insertion-ordered and turns are inserted in time order, so
   * the first key is always the oldest.
   */
  private evict(now: number): void {
    for (const [id, turn] of this.turns) {
      if (now - turn.openedAt > this.ttlMs) this.turns.delete(id);
    }
    while (this.turns.size > this.capacity) {
      const oldest = this.turns.keys().next();
      if (oldest.done) break;
      this.turns.delete(oldest.value);
    }
  }

  get size(): number {
    return this.turns.size;
  }
}
