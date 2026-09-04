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

  /**
   * The operator's terminal request: which window to show, and keys to type.
   *
   * A terminal is bytes in both directions, and the two halves of Tulip already
   * pass bytes in both directions — through these volumes. So the terminal uses
   * that rather than a socket. Docker will not publish a port into an
   * `internal: true` network (verified: an identical server answers on a normal
   * network and not on this one), and proxying ttyd through the bridge would
   * hand the bridge a route to the agent and the agent a route to the container
   * holding the WhatsApp credentials — which is the one thing the topology
   * exists to prevent.
   *
   * The request half: which window to show, and which keys to type. The reply
   * half is `pane.raw` on the outbound volume — the pane's own byte stream,
   * which is what makes this a terminal rather than a view of one.
   *
   * `window` is normally null, meaning "follow whichever chat is active". The
   * panel has no window picker: with a session per chat there is nothing useful
   * for an operator to choose between, and the thing worth watching is whatever
   * is answering someone right now.
   */
  terminal: `${IN_DIR}/terminal.json`,
} as const;

/**
 * A voice note's transcript, beside the recording it belongs to.
 *
 * A sidecar rather than an index, so the transcript shares the recording's
 * lifetime exactly: deleting the attachment deletes what was said in it, with
 * no second place to remember to clean up and no way for the two to disagree.
 *
 * Applies to both volumes, which is why it is a function of a path rather than
 * a member of either map.
 */
export const transcriptFor = (media: string): string => `${media}.txt`;

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

  /** The captured pane, written only while an operator is watching. */
  screen: `${OUT_DIR}/screen.json`,

  /**
   * The pane's live byte stream, appended by tmux `pipe-pane`.
   *
   * `screen.json` is a *snapshot*: what the pane looked like when the agent
   * last captured it, with the escape sequences stripped. That is the right
   * shape for the supervisor's parser and the wrong shape for anything meant to
   * look like the session — a TUI is a stream of cursor movements, not a
   * sequence of frames, so a poll of stripped text can only ever be a summary
   * of one. This file is the stream itself, the bytes the pane actually
   * emitted, which is what lets a terminal emulator in the browser render
   * exactly what tmux renders.
   *
   * Written only while somebody is watching, and truncated by the agent when it
   * grows past its cap or when the followed window changes. Truncation is the
   * signal as well as the cleanup: the bridge notices the file has shrunk below
   * its read offset and repaints from the top rather than resuming mid-escape.
   */
  pane: `${OUT_DIR}/pane.raw`,

  /**
   * Token spend, summarised by the agent from its own Claude Code transcripts.
   *
   * It has to be reported across this boundary rather than read directly: the
   * transcripts live in `CLAUDE_CONFIG_DIR` on a volume the bridge has no mount
   * for, which is the same disjointness that keeps the agent away from the
   * WhatsApp credentials. So the agent summarises and the bridge validates —
   * and, like `status.json`, this is a number written by the untrusted side. It
   * is displayed, never used for a decision.
   */
  usage: `${OUT_DIR}/usage.json`,
} as const;
