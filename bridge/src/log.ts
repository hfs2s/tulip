/**
 * Structured logging.
 *
 * One JSON object per line to a daily file, and a readable line to stdout for
 * `docker compose logs`. Logging is best-effort in both directions: a full disk
 * or a read-only mount must degrade observability, never delivery.
 *
 * Note `redact`. This process handles other people's private messages and holds
 * a WhatsApp auth store; a log line is the easiest way for either to end up
 * somewhere it should not be. Phone numbers are truncated and anything that
 * looks like a credential is masked, at the point of writing rather than by
 * remembering to be careful at each call site.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';

export type LogValue = string | number | boolean | null | undefined | readonly string[];
export type LogFields = Record<string, LogValue>;

/**
 * Anything shaped like a credential, wherever it appears in a logged string.
 *
 * The last alternative is an Entra client secret — the Teams bot's password —
 * which Microsoft issues as three characters, `8Q~` (older ones `7Q~`), and
 * thirty-odd more. It is matched by that shape rather than by entropy so a
 * hex chat key can never trip it.
 */
const CREDENTIAL =
  /\b(sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9~._-]{3}[78]Q~[A-Za-z0-9~._-]{30,})/g;

/**
 * Reduce a phone number to something that identifies a conversation in a log
 * without writing down someone's number: country prefix, then the last two.
 *
 * Only a number is a number. A Teams identifier — an object id GUID, or the
 * opaque `29:` form — is not personal data in the way a phone number is, and
 * reducing it to its digits would leave nothing an operator could copy into an
 * allowlist, which is the one reason denials record identifiers at all.
 */
export function redactNumber(value: string): string {
  if (!/^\+?[0-9]+(?::[0-9]+)?(?:@[a-z.]+)?$/i.test(value)) return value;
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 7) return '***';
  return `${digits.slice(0, 3)}…${digits.slice(-2)}`;
}

function redact(value: LogValue): LogValue {
  if (typeof value !== 'string') return value;
  return value.replace(CREDENTIAL, '«redacted»');
}

function file(): string {
  return join(paths.logs, `tulip-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

export function log(event: string, fields: LogFields = {}): void {
  const clean: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) clean[key] = redact(value);
  }
  const line = { at: new Date().toISOString(), event, ...clean };

  try {
    mkdirSync(paths.logs, { recursive: true });
    appendFileSync(file(), `${JSON.stringify(line)}\n`);
  } catch {
    /* observability must never break delivery */
  }

  const rest = Object.entries(clean)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  process.stdout.write(`[${line.at.slice(11, 19)}] ${event.padEnd(22)} ${rest}\n`);
}
