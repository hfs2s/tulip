/**
 * WhatsApp identity normalisation.
 *
 * One human arrives under several identifiers, and an allowlist that matches
 * only one of them fails in the most dangerous direction available to it —
 * silently, and in whichever direction the caller was not thinking about:
 *
 *   15551234567@s.whatsapp.net       phone-number jid
 *   15551234567:12@s.whatsapp.net    ...with a device suffix
 *   111111111111111@lid              "linked id", used in groups and newer clients
 *   15551234567@g.us                 a group, not a person at all
 *
 * WhatsApp increasingly delivers senders as a bare `@lid` carrying no phone
 * number, which cannot be guessed from outside. That is why denials are
 * recorded with every identifier the gate actually saw: adding someone's phone
 * number to an allowlist otherwise looks correct and does nothing.
 */

/** Strip a device suffix: `15551234567:12@s.whatsapp.net` → `15551234567@s.whatsapp.net`. */
export function bare(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, domain] = String(jid).split('@');
  if (!user) return null;
  return `${user.split(':')[0]}@${domain ?? 's.whatsapp.net'}`;
}

/** The user part only: `15551234567:12@s.whatsapp.net` → `15551234567`. */
export function userPart(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user] = String(jid).split('@');
  const bareUser = user?.split(':')[0];
  return bareUser && bareUser.length > 0 ? bareUser : null;
}

export function isGroup(jid: string | null | undefined): boolean {
  return String(jid ?? '').endsWith('@g.us');
}

export function isLid(jid: string | null | undefined): boolean {
  return String(jid ?? '').endsWith('@lid');
}

/**
 * Every identifier we know for one sender, deduplicated.
 *
 * Allowlist and operator checks run against this whole set, so a person listed
 * by phone number still matches when WhatsApp hands us their linked id instead.
 */
export function identities(...jids: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const jid of jids) {
    if (!jid) continue;
    const b = bare(jid);
    const u = userPart(jid);
    if (b) out.add(b);
    if (u) out.add(u);
  }
  return [...out];
}

/**
 * Does any identifier of this sender appear in `numbers`?
 *
 * Comparison is against the bare user part only. An entry in a config file is a
 * phone number, and matching it against a full jid would depend on which domain
 * WhatsApp happened to use for that message.
 */
export function matchesNumbers(numbers: readonly string[], ids: readonly string[]): boolean {
  if (numbers.length === 0) return false;
  const wanted = new Set(numbers.map(String));
  return ids.some((id) => wanted.has(id));
}

/**
 * A filesystem-safe label for a chat.
 *
 * Not used for anything the agent sees — that is the opaque `chatKey` — but the
 * bridge writes per-chat files of its own, and a WhatsApp id contains `:` and
 * `.`, neither of which belongs in a path built by string concatenation.
 */
export function slug(chatJid: string): string {
  const user = userPart(chatJid) ?? 'unknown';
  const prefix = isGroup(chatJid) ? 'g-' : isLid(chatJid) ? 'l-' : '';
  return (prefix + user).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}
