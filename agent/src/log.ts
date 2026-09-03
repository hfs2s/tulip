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
 *
 * **Credentials are masked on the way out.** Some lines quote a slice of the
 * terminal to explain why a session would not start, and the terminal is
 * exactly where a credential turns up: Claude Code prints the API key it found
 * in the environment when it asks whether to trust it. Left alone, a diagnostic
 * about a failed spawn puts most of that key into the container log, which then
 * goes wherever logs go. This was not hypothetical — it happened during
 * bring-up, which is why the masking is here rather than at each call site.
 */
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

/** Anything credential-shaped, wherever it appears in a logged string. */
const CREDENTIAL =
  /(sk-ant-[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

/**
 * Also catch the *elided* form.
 *
 * Claude Code prints `sk-ant-...` followed by the last twenty characters. The
 * prefix pattern above stops at the ellipsis, so without this the tail — which
 * is the secret part — survives into the log.
 */
const ELIDED_KEY = /sk-[a-z-]*\.\.\.[A-Za-z0-9_-]{8,}/g;

function redact(value: LogValue): LogValue {
  if (typeof value !== 'string') return value;
  return value.replace(ELIDED_KEY, '«redacted»').replace(CREDENTIAL, '«redacted»');
}

export function log(event: string, fields: LogFields = {}): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) clean[key] = redact(value);
  }
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...clean })}\n`);
}

export { redact };
