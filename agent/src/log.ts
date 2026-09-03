/**
 * Logging for the agent container.
 *
 * Straight to stdout for `docker compose logs`, with no file on disk. That is
 * deliberate: this container's log records what an untrusted process did, so it
 * belongs in the host's log driver where the agent cannot rewrite it, rather
 * than in a file on a volume the agent has write access to.
 *
 * **Message text is never logged here.** The pane carries other people's
 * conversations, and the agent's own log is the easiest place for a chat to
 * leak into an operator's terminal. Identifiers and counts only.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(event: string, fields: LogFields = {}): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) clean[key] = value;
  }
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...clean })}\n`);
}
