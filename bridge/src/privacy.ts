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
 * **It can only work under Access, and the token is not a way in.** The bearer
 * token is a secret, not an identity: everyone holding it is the same anonymous
 * caller. It was briefly treated as the owner, so that the operator's SSH
 * tunnel kept working — but that made the token a bypass, and a secret that
 * three other people may hold is not a credential to hang this on. A private
 * chat is now shown to one verified address and to nothing else.
 *
 * The cost is real and is the operator's to accept: reaching the panel with
 * `?t=<token>` shows the *unprivileged* view, so the private chats are hidden
 * from the operator too, and so is the terminal. Recovery when Access is
 * unavailable is editing `privacy.owner` to null in `config/config.json` on the
 * host — deliberately a thing you do at the machine, because anything reachable
 * from the panel with the token would be the same bypass again.
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
 * The direction of the default still matters: an unconfigured deployment — no
 * owner, or a blank one — resolves to "show everything", exactly as the panel
 * behaved before this existed, so switching the feature on is the only thing
 * that can hide anything.
 *
 * Once an owner *is* set, though, this fails closed: an address that does not
 * match, and the token, both get the narrow view. That is the point of setting
 * it, and it is why the recovery path is at the machine rather than in the
 * panel.
 */
export function isOwner(privacy: Privacy, viewer: Viewer): boolean {
  if (privacy.owner === null || privacy.owner.trim().length === 0) return true;
  // No identity, so not the owner. The token says its holder knows a secret;
  // it cannot say which person that is, and this whole feature is about which
  // person it is.
  if (viewer.who === null) return false;
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
