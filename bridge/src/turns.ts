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
  /**
   * Tool requests performed for this turn, against `limits.toolsPerTurn`.
   *
   * Counted separately from `sends` because the two bound different things and
   * sharing one number made both wrong. A search, a page publish and a memory
   * write deliver nothing to anybody, so spending the reply allowance on them
   * meant the workflow the persona actually recommends — a page with five
   * pictures — cost exactly the eight sends a turn is allowed, and the reply
   * carrying the link was refused as "send limit reached".
   *
   * They still need a ceiling of their own: they leave the deployment or spend
   * money, and nothing else bounds a loop of them. The comment in `outbox.ts`
   * claimed for a long time that they were "rate-limited by turn instead",
   * which was not true of any code — this is that limit, written.
   */
  tools: number;
  closedAt: number | null;
}

export type Resolution =
  | { ok: true; turn: Turn }
  | { ok: false; reason: 'unknown' | 'expired' | 'send limit reached' | 'tool limit reached' };

/**
 * Which of a turn's two budgets an action spends.
 *
 * `send` reaches a person; `tool` leaves the deployment or spends money but
 * delivers nothing; `free` does neither.
 */
export type Cost = 'send' | 'tool' | 'free';

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
    /** Tool requests permitted per turn, counted separately from sends. */
    private readonly maxTools: number = 24,
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
      tools: 0,
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
  resolve(turnId: unknown, now: number, cost: Cost = 'send'): Resolution {
    if (typeof turnId !== 'string') return { ok: false, reason: 'unknown' };
    const turn = this.turns.get(turnId);
    if (!turn) return { ok: false, reason: 'unknown' };
    if (now - turn.openedAt > this.ttlMs) return { ok: false, reason: 'expired' };
    // Which budget applies is a property of the action, so the caller says.
    // `free` is for actions that deliver nothing and cost nothing — the typing
    // indicator — which must stay resolvable after either budget is spent, or
    // the indicator sticks on for the rest of the turn.
    if (cost === 'send' && turn.sends >= this.maxSends) return { ok: false, reason: 'send limit reached' };
    if (cost === 'tool' && turn.tools >= this.maxTools) return { ok: false, reason: 'tool limit reached' };
    return { ok: true, turn };
  }

  /** Count a performed send against this turn's allowance. */
  countSend(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn) turn.sends += 1;
  }

  /** Count a performed tool request against this turn's separate allowance. */
  countTool(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (turn) turn.tools += 1;
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
