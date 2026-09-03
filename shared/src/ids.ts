/**
 * Identifier derivation.
 *
 * Two properties matter here, and they pull in opposite directions:
 *
 *   - The agent must be able to keep per-chat state across restarts, so a chat's
 *     identity has to be **stable**.
 *   - The agent must not learn who it is talking to, so that identity must not
 *     be **reversible** to a phone number.
 *
 * A keyed hash gives both. The salt lives in the bridge's own volume and is
 * never mounted into the agent, so `chatKey` is stable for the lifetime of the
 * deployment and opaque from inside the container that uses it.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

/** A fresh 32-byte salt, hex-encoded. Generated once per deployment. */
export function newSalt(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Derive the opaque handle for a chat.
 *
 * HMAC rather than a plain hash: WhatsApp identifiers are phone numbers, whose
 * search space is small enough to enumerate exhaustively. An unkeyed
 * `sha256(jid)` would be reversible in minutes by anyone who read this public
 * repository, which would defeat the entire point of the indirection.
 *
 * Truncated to 64 bits. Collision resistance is not the property being relied
 * on — the bridge holds the authoritative reverse map and never trusts a key it
 * did not issue — and a short key keeps tmux window names and directory names
 * readable.
 */
export function chatKeyFor(chatJid: string, salt: string): string {
  if (!salt) throw new Error('chatKeyFor: refusing to derive a chat key without a salt');
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(chatJid).digest('hex').slice(0, 16);
}

/** The fixed namespace for Tulip's derived session ids. Arbitrary, but constant. */
const SESSION_NAMESPACE = 'b7e4d1a0-3f28-4c96-8d5b-2a71e0c94f13';

/**
 * A deterministic UUIDv5, computed rather than imported so the agent container
 * needs no dependency for it.
 *
 * This is the whole resumability story, carried over from Iris: a Claude Code
 * session id is *derived* from the chat, never stored. Delete the container,
 * wipe the state file, reboot the host — the next message from that chat runs
 * `claude --resume <the same uuid>` and the conversation continues, because the
 * id is a pure function of inputs we still have.
 */
export function uuidV5(name: string): string {
  const ns = Buffer.from(SESSION_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  // Stamp version 5 and the RFC 4122 variant. `!` is safe: a 16-byte buffer.
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The Claude Code session id for one chat.
 *
 * `generation` lets an operator abandon a context deliberately — a fresh start
 * for a chat whose conversation has gone bad, or whose agent has been talked
 * into a corner — without losing the ability to go back to the old transcript,
 * which is still on disk under its own id.
 */
export function sessionUuidFor(chatKey: string, generation = 0): string {
  return uuidV5(generation > 0 ? `tulip:${chatKey}#${generation}` : `tulip:${chatKey}`);
}
