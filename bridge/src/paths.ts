/**
 * The bridge's own state volume.
 *
 * Everything here is mounted in `tulip-bridge` and **nowhere else**. The first
 * entry is the reason the container split exists at all: in the single-process
 * design Tulip is forked from, the WhatsApp auth store sits in the same home
 * directory the agent can read with `cat`, so any successful prompt injection
 * ends with the attacker owning the phone number. Here there is no mount, no
 * network path and no Docker socket between the agent and these files.
 */
import { join } from 'node:path';

export const STATE_DIR = process.env['TULIP_STATE_DIR'] ?? '/state';

export const paths = {
  root: STATE_DIR,

  /** Baileys multi-file auth store. Full account access; never leaves this container. */
  session: join(STATE_DIR, 'session'),

  /** The HMAC key that makes chat identifiers opaque to the agent. */
  salt: join(STATE_DIR, 'salt'),

  /** The authoritative chatKey → WhatsApp id map. The agent never sees this. */
  chats: join(STATE_DIR, 'chats.json'),

  /** Durable per-chat counters: allowance, budgets, first contact. */
  senders: join(STATE_DIR, 'senders.json'),

  /** Operator-maintained deny list, consulted before anything else. */
  blocklist: join(STATE_DIR, 'blocklist.json'),

  /** Accepted but not yet delivered. One file per message so a restart loses none. */
  queue: join(STATE_DIR, 'queue'),

  /** Every message in and out, gated or not. The record of what actually happened. */
  feed: join(STATE_DIR, 'feed.jsonl'),

  /** Structured event log, one file per day. */
  logs: join(STATE_DIR, 'logs'),

  /** Today's count of the capabilities that are billed per use. */
  spend: join(STATE_DIR, 'spend.json'),

  /**
   * Copies of what the agent sent out: generated pictures, voice notes, GIFs.
   *
   * Deliberately under `state` rather than beside the inbound media in
   * `handoff-in`. That volume is mounted into the agent — read-only, but
   * readable — and `state` is mounted in the bridge and nowhere else. Keeping
   * outbound copies here means the agent cannot read back anything it ever
   * produced, which is the difference between an audit trail and a memory it
   * can be talked into consulting.
   */
  mediaOut: join(STATE_DIR, 'media-out'),

  /** Hold flag, session generations, and other small persistent flags. */
  state: join(STATE_DIR, 'state.json'),

  /**
   * Keys of messages Juan has sent, so they can be edited or unsent later.
   *
   * On the state volume, which the agent has no mount for. That is what makes
   * `tulip-wa edit 2` safe to expose: the agent names a position in its own
   * recent history and the bridge resolves it here, so nothing the agent can
   * say — or be talked into saying — reaches a message it did not send, in a
   * chat it is not answering.
   */
  sent: join(STATE_DIR, 'sent.json'),

  /** Bearer token for the control panel. Generated on first run, mode 0600. */
  panelToken: join(STATE_DIR, 'panel-token'),

  /**
   * Where each Teams conversation lives — service URL, conversation id, our
   * own id there — so a proactive send has an address. The Teams counterpart
   * of `chats.json`, kept here for the same reason: it turns the agent's
   * opaque keys back into real destinations, and the agent has no mount.
   */
  teamsReferences: join(STATE_DIR, 'teams-references.json'),

  /**
   * Messages promised to somebody for later, and the rules that repeat them.
   *
   * On *this* volume, which the agent has no mount for at all — not even the
   * read-only one it gets for `memory.json`. The asymmetry is the point. A
   * scheduled send is a message that leaves with nobody watching, hours or
   * weeks after the conversation that caused it, so the three things a
   * compromised agent must not be able to do to this file are forge an entry,
   * edit one it already asked for, and replay an old one. None of them is
   * detected and rejected here; all three are unrepresentable, because there is
   * no path from that container to this file.
   *
   * So the agent asks, exactly as it asks for `remember`, and the bridge writes
   * — with the destination taken from the turn rather than from the request.
   */
  schedule: join(STATE_DIR, 'schedule.json'),

  /**
   * What the agent calls each hfs2s app.
   *
   * Here rather than in config.json, and the distinction is the same one
   * `memory.json` turns on: the agent can cause this to change, and config is
   * the authorisation channel it must never reach. `apps.grants` decides who
   * may work on an app and lives in the config; a label decides nothing and
   * lives here. A compromised agent renaming every app is a mess an operator
   * can see and undo, not a grant it awarded itself.
   *
   * The box has names of its own, which this does not touch — twenty-two of the
   * thirty-two are `(unnamed)` there, and naming one from a chat is the point.
   */
  appLabels: join(STATE_DIR, 'app-labels.json'),
} as const;
