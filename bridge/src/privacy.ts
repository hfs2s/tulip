/**
 * Who may see which conversation in the panel.
 *
 * The panel has always been all-or-nothing: holding the token, or passing
 * Cloudflare Access, got you every message in every chat. That is right for one
 * operator and wrong the moment a second person is let in — the operator's own
 * conversation with the agent is in the same list as everybody else's.
 *
 * Three things about this are worth stating plainly, because each is a limit
 * rather than a detail:
 *
 * **It can only work under Access.** The bearer token is a secret, not an
 * identity: everyone holding it is the same anonymous caller, and there is
 * nothing to filter on. Anyone given the token bypasses this entirely, which is
 * a deliberate trade — the token is the operator's own way in over an SSH
 * tunnel and the way back in when Access is down.
 *
 * **It is a display rule, not containment.** Every message is still on the same
 * disk, in the same files, readable by anyone with a shell on the host. This
 * hides a conversation from a colleague looking at a web page; it does not hide
 * it from someone who can `docker exec`.
 *
 * **The terminal cannot be filtered at all.** Since Tulip moved to one shared
 * Claude Code session, the live pane carries every conversation at once. There
 * is no per-chat view of a pty, so the page is owner-only rather than filtered.
 * That is why `isOwner` exists separately from `canSee`.
 */

/** Who is looking. `who` is an Access email, or null for the bearer token. */
export interface Viewer {
  readonly who: string | null;
}

export interface Privacy {
  /** The Access email whose chats are private. Null switches the whole thing off. */
  readonly owner: string | null;
  /** Chat keys only the owner may see. */
  readonly chats: readonly string[];
}

const normalise = (email: string): string => email.trim().toLowerCase();

/**
 * Does this viewer get the unrestricted panel?
 *
 * True when the feature is off, when the caller holds the token, and for the
 * owner. Everyone else is a moderator with a narrower view.
 *
 * Note the direction of the default: an unconfigured deployment, an unreadable
 * config, or an owner nobody matches all resolve to "show everything", exactly
 * as the panel behaved before this existed. A privacy rule that fails *closed*
 * would lock an operator out of their own panel on a typo.
 */
export function isOwner(privacy: Privacy, viewer: Viewer): boolean {
  if (privacy.owner === null || privacy.owner.trim().length === 0) return true;
  if (viewer.who === null) return true;
  return normalise(viewer.who) === normalise(privacy.owner);
}

/** May this viewer see this conversation? */
export function canSee(privacy: Privacy, viewer: Viewer, chatKey: string): boolean {
  if (isOwner(privacy, viewer)) return true;
  return !privacy.chats.some((key) => key === chatKey);
}

/**
 * Filter a list of things that each name a chat.
 *
 * One helper rather than the same `.filter` written at each of the seven read
 * paths, because the failure mode of that is one path quietly not being
 * filtered — and a single surface that still shows the chat makes the other six
 * pointless.
 */
export function onlyVisible<T>(
  privacy: Privacy,
  viewer: Viewer,
  items: readonly T[],
  keyOf: (item: T) => string | null,
): T[] {
  if (isOwner(privacy, viewer)) return [...items];
  return items.filter((item) => {
    const key = keyOf(item);
    // An item that names no chat cannot be attributed to one, so it stays.
    return key === null || canSee(privacy, viewer, key);
  });
}
