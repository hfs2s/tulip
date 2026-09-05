/**
 * Adding a destination the agent may message.
 *
 * The agent's address space is *issued*, never chosen: it can name a `chatKey`
 * the bridge minted and nothing else. That is the property THREAT-MODEL.md §T4
 * rests on, and it is why a compromised agent cannot be aimed at a stranger.
 *
 * This module is the one door into that address space, and the whole design is
 * about who is allowed through it. The number does not come from the agent's
 * judgement — it comes from an operator, typed into an operator's own chat, and
 * the caller proves that before calling. `isOperator()` matches on the sender's
 * jid, which WhatsApp assigns; a stranger cannot reach this by setting their
 * display name to "Les".
 *
 * The new contact is written to `config.json`, not just to the chat registry.
 * That matters for a reason worth stating: `syncContacts()` treats the config
 * list as the truth and clears the `contact` flag on anything absent from it,
 * so a key minted only in memory would quietly stop being offered on the next
 * restart. Writing it through means the contact is durable, and — more
 * usefully — it appears in the panel's own contact list, where an operator can
 * see what the agent was given and take it away again.
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from '@tulip/shared';

import type { ChatRegistry } from './chats.js';
import type { Config } from './config.js';
import { log } from './log.js';

const CONFIG_FILE = process.env['TULIP_CONFIG'] ?? '/config/config.json';

/**
 * A ceiling on how many destinations can accumulate.
 *
 * The operator gate already bounds this — every entry costs a message from an
 * operator — but a cap turns "somebody pasted a list" from unbounded growth
 * into a refusal, and the config file is read on every settings save.
 */
const MAX_CONTACTS = 200;

/** Bare international digits, as WhatsApp and `config.ts` both store them. */
const DIGITS = /^[1-9][0-9]{6,17}$/;

export type AddContactResult =
  | { ok: true; chatKey: string; already: boolean; number: string }
  | { ok: false; error: string };

/**
 * Issue a chat key for a phone number, and remember it.
 *
 * Idempotent: adding a number that is already a contact returns the key it
 * already has rather than a second record. `already` says which happened, so a
 * caller can tell the operator "you already had them" instead of implying it
 * did something.
 */
export function addContact(
  deps: { config: Config; chats: ChatRegistry },
  rawNumber: string,
  rawLabel: string,
  now = Date.now(),
): AddContactResult {
  // A leading `+` is how a person writes a number and not how WhatsApp stores
  // one. Everything else has to be digits already: this deliberately does not
  // strip spaces, dashes or brackets, because a number that arrives in some
  // other shape is a number somebody typed carelessly, and guessing at it is
  // how a message reaches the wrong phone.
  const number = rawNumber.startsWith('+') ? rawNumber.slice(1) : rawNumber;
  if (!DIGITS.test(number)) {
    return { ok: false, error: 'That is not a phone number in international form — country code first, digits only.' };
  }

  const label = rawLabel.trim().slice(0, 60);
  if (label.length === 0) return { ok: false, error: 'A contact needs a name.' };

  const existing = deps.config.agent.contacts.find((c) => c.number === number);
  if (existing !== undefined) {
    const chatKey = deps.chats.keyForNumber(number);
    if (chatKey === null) {
      // The config says they are a contact but no record exists, which means
      // the registry and the file have drifted. Re-syncing is the repair.
      deps.chats.syncContacts(deps.config.agent.contacts, now);
      deps.chats.flush();
    }
    const repaired = deps.chats.keyForNumber(number);
    if (repaired === null) return { ok: false, error: 'That contact exists in the configuration but has no chat record.' };
    return { ok: true, chatKey: repaired, already: true, number };
  }

  if (deps.config.agent.contacts.length >= MAX_CONTACTS) {
    return { ok: false, error: `There are already ${String(MAX_CONTACTS)} contacts, which is the limit.` };
  }

  const next = [...deps.config.agent.contacts, { label, number }];

  // Read-modify-write against the file rather than serialising `config` back
  // out. The parsed config carries defaults for everything the operator never
  // set, so writing it whole would silently promote every default into an
  // explicit setting — and the panel's own save path avoids this the same way.
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    log('contacts.configUnreadable', { err: String((err as Error).message) });
    return { ok: false, error: 'The configuration file could not be read, so nothing was changed.' };
  }
  raw['agent'] = { ...(raw['agent'] as object | undefined), contacts: next };
  try {
    writeJsonAtomic(CONFIG_FILE, raw, 0o600);
  } catch (err) {
    log('contacts.writeFailed', { err: String((err as Error).message) });
    return { ok: false, error: 'The configuration file could not be written, so nothing was changed.' };
  }

  // In-memory config last, so a failed write leaves the process agreeing with
  // the file rather than believing in a contact that was never saved.
  deps.config.agent.contacts = next;
  deps.chats.syncContacts(next, now);
  deps.chats.flush();

  const chatKey = deps.chats.keyForNumber(number);
  if (chatKey === null) return { ok: false, error: 'The contact was saved but no chat key was issued.' };

  log('contacts.added', { label, chatKey });
  return { ok: true, chatKey, already: false, number };
}
