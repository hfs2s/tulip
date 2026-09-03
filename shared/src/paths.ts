/**
 * The on-disk layout of the two handoff volumes.
 *
 * Named in one place because the permissions are asymmetric and getting a path
 * on the wrong side is a security bug rather than a bug. The mounts are:
 *
 *   IN   bridge: read-write     agent: READ-ONLY
 *   OUT  bridge: read-write     agent: read-write
 *
 * The read-only inbound mount is doing real work. It means a compromised agent
 * cannot forge a batch, rewrite the current-turn pointer to name a different
 * chat, replay an old turn, or tamper with the media it was given. Those
 * attacks are not detected and rejected — they are unrepresentable, because the
 * kernel refuses the write.
 */

/** Default mount points inside both containers. Overridable for tests. */
export const IN_DIR = process.env['TULIP_IN_DIR'] ?? '/handoff/in';
export const OUT_DIR = process.env['TULIP_OUT_DIR'] ?? '/handoff/out';

/** Inbound: written by the bridge only. */
export const inPaths = {
  root: IN_DIR,
  /** One file per delivered batch, named by turn id. */
  batches: `${IN_DIR}/batches`,
  batch: (turnId: string) => `${IN_DIR}/batches/${turnId}.json`,
  /** Which turn is being answered right now. */
  current: `${IN_DIR}/current.json`,
  /** Received attachments, one directory per chat key. */
  media: `${IN_DIR}/media`,
  mediaFor: (chatKey: string) => `${IN_DIR}/media/${chatKey}`,

  /**
   * Answers to the agent's tool requests — a web search, a page fetch.
   *
   * On the *inbound* volume deliberately, which is the read-only side for the
   * agent. The agent asks by writing an action and reads the answer here; it
   * cannot forge a result, edit one, or replay an old one, because the mount
   * refuses the write. The bridge is the only writer of anything the agent
   * treats as having come from outside.
   */
  results: `${IN_DIR}/results`,
  result: (actionId: string) => `${IN_DIR}/results/${actionId}.json`,
} as const;

/** Outbound: written by the agent, consumed and deleted by the bridge. */
export const outPaths = {
  root: OUT_DIR,
  /** Queued actions. The bridge validates, performs, then unlinks. */
  actions: `${OUT_DIR}/actions`,
  action: (id: string) => `${OUT_DIR}/actions/${id}.json`,
  /**
   * Files the agent wants sent. The bridge opens files *only* from here, and
   * re-resolves every name against this directory before doing so.
   */
  files: `${OUT_DIR}/files`,
  file: (name: string) => `${OUT_DIR}/files/${name}`,
  /** The agent's self-report. Advisory; never used for a delivery decision. */
  status: `${OUT_DIR}/status.json`,
} as const;
