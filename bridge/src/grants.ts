/**
 * Does a grant name this conversation?
 *
 * One matcher for every list of `GrantEntry` in config.ts — `apps.grants` and
 * a callable plugin's `grants` — so that "granted to this chat" means the same
 * thing wherever it is asked. The entries are the operator's; the chat is
 * whoever the agent is talking to, as the registry has it.
 */
import { identities, isGroup, matchesList } from './jid.js';

/** What the matcher needs of a chat record, or null where the registry has none. */
export type GrantChat = { readonly jid: string; readonly altJid: string | null; readonly isGroup: boolean } | null;

/**
 * True if any entry names this conversation.
 *
 * A chat key names it outright. Otherwise a direct chat is matched by phone
 * number or linked id — the only way to grant somebody who has never written,
 * because a chat key does not exist until they do — and a group is matched by
 * its own jid alone. A number never authorises a room: a group's jid is the
 * group's, not a member's, so the person-shaped entries are kept away from
 * group chats and the room-shaped one away from people.
 */
export function matchesGrant(granted: readonly string[], chatKey: string, chat: GrantChat): boolean {
  if (granted.includes(chatKey)) return true;
  if (chat === null) return false;
  if (chat.isGroup) {
    return matchesList({ jids: granted.filter((entry) => isGroup(entry)) }, identities(chat.jid));
  }
  return matchesList({ jids: granted.filter((entry) => !isGroup(entry)) }, identities(chat.jid, chat.altJid));
}
