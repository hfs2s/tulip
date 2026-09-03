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
import { dirname } from 'node:path';
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
    /**
     * Created from `agent.contacts` rather than by somebody messaging in.
     *
     * Two things depend on knowing the difference. The panel says which rows an
     * operator put there by hand, and the agent is told which destinations it
     * may approach unprompted — a contact is a standing invitation, a chat that
     * merely wrote in once is not. Defaulted, so records persisted before this
     * field existed load unchanged.
     */
    contact: z.boolean().default(false),
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
    // The directory this instance was actually given, not the global state
    // root. They are the same in production; injecting a path and then creating
    // a different one made the registry untestable without touching /state.
    mkdirSync(dirname(this.saltFile), { recursive: true });
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
        contact: false,
      });
      this.dirty = true;
    }
    return chatKey;
  }

  /**
   * Reconcile the operator's contact list into the registry.
   *
   * Called on boot and whenever the list is edited. Registering a contact is
   * the only way a chat record comes into being without somebody having sent a
   * message, which is the whole point: it gives the agent a destination for
   * somebody who has never written to it.
   *
   * Removal deliberately does *not* delete the record. A contact that has since
   * held a real conversation has history, a session and possibly a block on it,
   * and dropping a row would orphan all of that — plus reissue a different key
   * for the same person if they were ever added back, silently resetting their
   * conversation. So removal clears the flag and leaves the chat alone; a
   * contact who never wrote in simply stops being offered as a destination.
   */
  syncContacts(contacts: ReadonlyArray<{ label: string; number: string }>, now: number): void {
    const wanted = new Set<string>();

    for (const { label, number } of contacts) {
      const jid = `${number}@s.whatsapp.net`;
      const chatKey = chatKeyFor(jid, this.salt);
      wanted.add(chatKey);

      const existing = this.byKey.get(chatKey);
      if (existing) {
        // The operator's label wins over the WhatsApp display name, which is
        // supplied by the other end and is not trustworthy.
        if (existing.contact !== true || existing.name !== label) {
          existing.contact = true;
          existing.name = label;
          this.dirty = true;
        }
        continue;
      }

      this.byKey.set(chatKey, {
        chatKey,
        jid,
        isGroup: false,
        name: label,
        firstSeenAt: now,
        lastSeenAt: now,
        messages: 0,
        blocked: false,
        contact: true,
      });
      this.dirty = true;
    }

    for (const record of this.byKey.values()) {
      if (record.contact && !wanted.has(record.chatKey)) {
        record.contact = false;
        this.dirty = true;
      }
    }

    if (this.dirty) log('chats.contactsSynced', { count: wanted.size });
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
