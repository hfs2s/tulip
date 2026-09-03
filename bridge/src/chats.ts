/**
 * The chatKey ↔ WhatsApp-id map, and the salt that makes it one-way.
 *
 * This is the only place in the system where an opaque chat key can be turned
 * back into a phone number, and it lives in the bridge's own volume. The agent
 * has no mount, so from inside the container that actually handles hostile input
 * a chat key is just sixteen hex characters.
 *
 * The salt is generated once and then never changes. Rotating it would not
 * improve anything — the map beside it is the sensitive artefact, not the key
 * derivation — and it would orphan every agent session, since session ids are
 * derived from chat keys. If the salt is ever lost, all that is lost is
 * continuity: new keys are issued and conversations start fresh.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chatKeyFor, newSalt, writeFileAtomic, writeJsonAtomic } from '@tulip/shared';
import { z } from 'zod';
import { log } from './log.js';
import { paths } from './paths.js';

const ChatRecord = z
  .object({
    chatKey: z.string().regex(/^[0-9a-f]{16}$/),
    jid: z.string().min(3).max(128),
    isGroup: z.boolean(),
    /** Display name, from WhatsApp. Attacker-controlled; used for the panel only. */
    name: z.string().max(128).nullable().default(null),
    firstSeenAt: z.number().int(),
    lastSeenAt: z.number().int(),
    messages: z.number().int().nonnegative().default(0),
    /** Set by an operator via `!block`. Checked before every other gate. */
    blocked: z.boolean().default(false),
  })
  .strict();

export type ChatRecord = z.infer<typeof ChatRecord>;

const Persisted = z.object({ chats: z.array(ChatRecord).default([]) }).strict();

export class ChatRegistry {
  private readonly salt: string;
  private readonly byKey = new Map<string, ChatRecord>();
  private dirty = false;

  constructor(
    private readonly saltFile = paths.salt,
    private readonly chatsFile = paths.chats,
  ) {
    this.salt = this.loadSalt();
    this.load();
  }

  /**
   * Read the deployment salt, creating it on first run.
   *
   * Mode 0600 and written atomically. A half-written salt would silently change
   * every chat key on the next restart, which reads as every conversation
   * simultaneously losing its memory.
   */
  private loadSalt(): string {
    mkdirSync(paths.root, { recursive: true });
    if (existsSync(this.saltFile)) {
      const existing = readFileSync(this.saltFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(existing)) return existing;
      throw new Error(`${this.saltFile} exists but is not a 32-byte hex salt; refusing to overwrite it`);
    }
    const salt = newSalt();
    writeFileAtomic(this.saltFile, salt, 0o600);
    log('chats.saltCreated', { note: 'first run — chat keys are now stable for this deployment' });
    return salt;
  }

  private load(): void {
    if (!existsSync(this.chatsFile)) return;
    try {
      const parsed = Persisted.safeParse(JSON.parse(readFileSync(this.chatsFile, 'utf8')));
      if (!parsed.success) {
        log('chats.stateInvalid', { issues: parsed.error.issues.length, note: 'starting from empty' });
        return;
      }
      for (const record of parsed.data.chats) this.byKey.set(record.chatKey, record);
    } catch (err) {
      log('chats.loadFailed', { err: String((err as Error).message) });
    }
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      writeJsonAtomic(this.chatsFile, { chats: [...this.byKey.values()] });
      this.dirty = false;
    } catch (err) {
      log('chats.flushFailed', { err: String((err as Error).message) });
    }
  }

  /** The opaque key for a chat, registering it on first sight. */
  keyFor(jid: string, isGroup: boolean, now: number): string {
    const chatKey = chatKeyFor(jid, this.salt);
    if (!this.byKey.has(chatKey)) {
      this.byKey.set(chatKey, {
        chatKey,
        jid,
        isGroup,
        name: null,
        firstSeenAt: now,
        lastSeenAt: now,
        messages: 0,
        blocked: false,
      });
      this.dirty = true;
    }
    return chatKey;
  }

  /**
   * The WhatsApp id a key refers to, or null.
   *
   * Every outbound send resolves through here. A key that was never issued has
   * no destination, which is the property that makes a forged one useless.
   */
  jidFor(chatKey: string): string | null {
    return this.byKey.get(chatKey)?.jid ?? null;
  }

  get(chatKey: string): ChatRecord | null {
    return this.byKey.get(chatKey) ?? null;
  }

  touch(chatKey: string, patch: Partial<Pick<ChatRecord, 'name' | 'messages' | 'blocked'>>, now: number): void {
    const record = this.byKey.get(chatKey);
    if (!record) return;
    Object.assign(record, patch, { lastSeenAt: now });
    this.dirty = true;
  }

  isBlocked(chatKey: string): boolean {
    return this.byKey.get(chatKey)?.blocked === true;
  }

  setBlocked(chatKey: string, blocked: boolean): boolean {
    const record = this.byKey.get(chatKey);
    if (!record) return false;
    record.blocked = blocked;
    this.dirty = true;
    return true;
  }

  all(): ChatRecord[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }
}
