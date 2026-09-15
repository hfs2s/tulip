/**
 * Where each Teams conversation lives, so it can be written to later.
 *
 * A WhatsApp jid is a complete address: the socket knows how to reach it. A
 * Teams conversation id is not. Every send is a *proactive* message that has
 * to name the regional service it goes through, and that URL arrives only on
 * inbound activities. So the bridge keeps, per chat, what Microsoft calls a
 * conversation reference — the service URL, the conversation id, the tenant
 * and our own id as that conversation knows it — and every outbound send,
 * whether a reply seconds later or a reminder a week on, resolves through it.
 *
 * On the state volume, beside `chats.json`, for the same reason that file is:
 * it maps the agent's opaque chat keys to real addresses and the agent has no
 * mount for it. The one field that could hurt if forged is `serviceUrl`, and
 * it is refused here unless it passes `validServiceUrl` — the same check the
 * listener made before it trusted the activity — so nothing this file hands
 * out can point the bridge at a host Microsoft did not name.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from '@2lp/shared';
import { z } from 'zod';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { validServiceUrl } from './activity.js';

const Reference = z
  .object({
    serviceUrl: z.string().max(512),
    conversationId: z.string().min(1).max(256),
    tenantId: z.string().max(64).nullable(),
    /** `28:<app id>`, as this conversation names us. Goes in `from` on every send. */
    botId: z.string().min(1).max(256),
    lastActivityId: z.string().max(256).nullable(),
    updatedAt: z.number().int(),
  })
  .strict();

export type ConversationReference = z.infer<typeof Reference>;

const Persisted = z.object({ references: z.record(z.string(), Reference).default({}) }).strict();

export class ConversationReferences {
  private readonly byChat = new Map<string, ConversationReference>();

  constructor(private readonly file = paths.teamsReferences) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = Persisted.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!parsed.success) {
        log('teams.referencesInvalid', { issues: parsed.error.issues.length, note: 'starting from empty' });
        return;
      }
      for (const [chatId, ref] of Object.entries(parsed.data.references)) {
        // Re-checked on the way in. A file edited by hand, or written by an
        // older build with a looser rule, must not become a send target.
        if (validServiceUrl(ref.serviceUrl) === ref.serviceUrl) this.byChat.set(chatId, ref);
      }
    } catch (err) {
      log('teams.referencesLoadFailed', { err: String((err as Error).message) });
    }
  }

  private flush(): void {
    try {
      writeJsonAtomic(this.file, { references: Object.fromEntries(this.byChat) });
    } catch (err) {
      log('teams.referencesFlushFailed', { err: String((err as Error).message) });
    }
  }

  /**
   * Record where a conversation lives. Returns false, and records nothing,
   * for a service URL that fails the rule; the caller has already refused the
   * activity by then, so this is the second lock rather than the first.
   */
  remember(chatId: string, ref: Omit<ConversationReference, 'updatedAt'>): boolean {
    const serviceUrl = validServiceUrl(ref.serviceUrl);
    if (serviceUrl === null) {
      log('teams.referenceRefused', { chatKey: null, note: 'service url failed validation; not stored' });
      return false;
    }
    const existing = this.byChat.get(chatId);
    const next: ConversationReference = { ...ref, serviceUrl, updatedAt: Date.now() };
    if (
      existing !== undefined &&
      existing.serviceUrl === next.serviceUrl &&
      existing.conversationId === next.conversationId &&
      existing.tenantId === next.tenantId &&
      existing.botId === next.botId &&
      existing.lastActivityId === next.lastActivityId
    ) {
      return true; // nothing changed; no write
    }
    this.byChat.set(chatId, next);
    this.flush();
    return true;
  }

  get(chatId: string): ConversationReference | null {
    return this.byChat.get(chatId) ?? null;
  }

  get size(): number {
    return this.byChat.size;
  }
}
