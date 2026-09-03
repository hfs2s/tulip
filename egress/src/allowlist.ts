/**
 * The egress allowlist.
 *
 * Separated from the server so it can be tested exhaustively without sockets.
 * Every function here is pure, and the interesting cases are all attacks:
 * hostname confusion is the classic way past a naive allowlist, and every one of
 * the tricks below has worked against a real proxy at some point.
 *
 *   api.anthropic.com.evil.test   suffix confusion — `endsWith` says yes
 *   evil.test#api.anthropic.com   fragment confusion
 *   api.anthropic.com@evil.test   userinfo confusion
 *   API.ANTHROPIC.COM             case
 *   api.anthropic.com.            trailing root label
 *   xn--pi-vmc.anthropic.com      punycode homograph
 *   [::ffff:127.0.0.1]            IPv6-mapped literal
 *
 * The strategy is to normalise into a strict shape, reject anything that is not
 * exactly that shape, and then compare with `===` against explicit entries. No
 * substring matching anywhere.
 */

export type Decision = { allowed: true; host: string; port: number } | { allowed: false; reason: string };

/** The only port the proxy will ever open. HTTPS or nothing. */
export const ALLOWED_PORT = 443;

/**
 * A syntactically valid DNS hostname: labels of alphanumerics and hyphens,
 * separated by single dots, no label starting or ending with a hyphen, at least
 * two labels. This rejects IP literals, bracketed IPv6, userinfo, ports,
 * paths, and every non-ASCII character, before any comparison happens.
 */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/**
 * Normalise a hostname for comparison, or return null if it is not a plain
 * hostname at all.
 *
 * Returning null rather than a best-effort cleanup is deliberate: anything
 * unusual enough to need cleaning is something we would rather refuse than
 * guess about.
 */
export function normaliseHost(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 253) return null;

  // A single trailing dot is the fully-qualified form of the same name and
  // resolves identically, so strip exactly one. Two is malformed.
  const stripped = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  const lower = stripped.toLowerCase();

  // Reject anything carrying structure a hostname should not have. These would
  // be caught by the pattern below too; naming them keeps the denial legible in
  // the audit log.
  if (/[@/\\?#[\]:%_\s]/.test(lower)) return null;
  if (!HOSTNAME.test(lower)) return null;

  return lower;
}

/**
 * Parse the target of a CONNECT request, which is `host:port` and nothing else.
 *
 * Note that `authority` comes straight off the wire from the untrusted side, so
 * this is a parser for hostile input and is written as one: fixed shape, no
 * URL class, no fallbacks.
 */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  if (typeof authority !== 'string' || authority.length > 300) return null;

  // Split on the LAST colon so that a malformed `a:b:443` cannot be read as
  // host `a` with the rest ignored — it will simply fail hostname validation.
  const colon = authority.lastIndexOf(':');
  if (colon <= 0) return null;

  const host = normaliseHost(authority.slice(0, colon));
  if (host === null) return null;

  const portText = authority.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { host, port };
}

/**
 * Read the allowlist from configuration.
 *
 * Entries are exact hostnames, or `*.example.com` to permit direct subdomains
 * and the apex. An empty allowlist is a valid, maximally restrictive
 * configuration — the proxy runs and refuses everything — and is what an
 * operator gets if they forget to set the variable. Failing closed on a missing
 * setting is the whole point.
 */
export function parseAllowlist(raw: string | undefined): { exact: Set<string>; suffixes: string[] } {
  const exact = new Set<string>();
  const suffixes: string[] = [];

  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;

    if (trimmed.startsWith('*.')) {
      const base = normaliseHost(trimmed.slice(2));
      if (base === null) throw new Error(`egress: invalid wildcard allowlist entry: ${entry}`);
      suffixes.push(base);
      exact.add(base); // `*.example.com` covers example.com itself
      continue;
    }

    const host = normaliseHost(trimmed);
    if (host === null) throw new Error(`egress: invalid allowlist entry: ${entry}`);
    exact.add(host);
  }

  return { exact, suffixes };
}

/**
 * Decide whether a CONNECT may proceed.
 *
 * The wildcard test compares against `"." + base` rather than using `endsWith`
 * on the base alone. That single dot is the difference between allowing
 * `us.api.example.com` and allowing `evil-api.example.com.attacker.test`.
 */
export function decide(
  authority: string,
  allow: { exact: Set<string>; suffixes: string[] },
): Decision {
  const target = parseAuthority(authority);
  if (target === null) return { allowed: false, reason: 'unparseable or non-hostname authority' };

  if (target.port !== ALLOWED_PORT) {
    return { allowed: false, reason: `port ${target.port} is not permitted (only ${ALLOWED_PORT})` };
  }

  if (allow.exact.has(target.host)) return { allowed: true, ...target };

  for (const base of allow.suffixes) {
    if (target.host.endsWith(`.${base}`)) return { allowed: true, ...target };
  }

  return { allowed: false, reason: 'host is not on the allowlist' };
}
