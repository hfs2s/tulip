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

  /** Bearer token for the control panel. Generated on first run, mode 0600. */
  panelToken: join(STATE_DIR, 'panel-token'),
} as const;
