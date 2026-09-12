/**
 * Is he in a group? Decided from WhatsApp's own member list, for the panel's
 * "Still in?" check. Pure, so the matching can be tested without a socket.
 *
 * WhatsApp names one account several ways — `<number>@s.whatsapp.net`,
 * `<number>:<device>@s.whatsapp.net`, and an opaque `<id>@lid` — and which one
 * a member list uses is its choice, not ours. So every form we know for
 * ourselves is compared against every form a participant carries, on the part
 * before `@` and any `:` device suffix.
 */
export type Membership = 'member' | 'not-member' | 'unknown';

function userPart(jid: unknown): string | null {
  if (typeof jid !== 'string' || jid.length === 0) return null;
  const bare = (jid.split('@')[0] ?? '').split(':')[0] ?? '';
  return bare.length > 0 ? bare : null;
}

/** Whether any of our own identifiers appears among the participants. */
export function isParticipant(
  participants: ReadonlyArray<Readonly<Record<string, unknown>>>,
  me: ReadonlyArray<string | null | undefined>,
): boolean {
  const mine = new Set(me.map(userPart).filter((u): u is string => u !== null));
  if (mine.size === 0) return false;
  return participants.some((p) =>
    ['id', 'lid', 'jid', 'phoneNumber'].some((field) => {
      const u = userPart(p[field]);
      return u !== null && mine.has(u);
    }),
  );
}

/**
 * What a failed lookup means. WhatsApp refuses a group's metadata to anybody
 * who is not in it (403 forbidden, or 404 item-not-found once it is gone);
 * anything else — a dropped connection, a timeout — says nothing about
 * membership, and must not be reported as though it did.
 */
export function classifyLookupError(err: unknown): Membership {
  const status = (err as { output?: { statusCode?: unknown } } | null)?.output?.statusCode;
  const text = String((err as { message?: unknown } | null)?.message ?? '').toLowerCase();
  if (status === 403 || status === 404) return 'not-member';
  if (/forbidden|item-not-found|not-authorized/.test(text)) return 'not-member';
  return 'unknown';
}
