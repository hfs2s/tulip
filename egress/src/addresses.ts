/**
 * Refuse to connect to anything that is not a public internet address.
 *
 * The allowlist says *which names* may be reached. This says *which addresses*
 * those names may resolve to, and it is a separate control because a name can
 * resolve anywhere. Without it the proxy is a server-side request forgery
 * gadget: the one component that sits on both the internal and the external
 * network, dialling whatever an allowlisted DNS record points at.
 *
 * The range that matters most on this deployment is `100.64.0.0/10`. That is
 * carrier-grade NAT space, and it is also what Tailscale uses — the host Tulip
 * runs on is on a tailnet alongside a production machine. An allowlisted name
 * resolving into that range would hand the agent a route onto the private
 * network that every other control here exists to keep it off.
 */

/** Parse dotted-quad IPv4 into a 32-bit unsigned integer, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** CIDR blocks that must never be dialled. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT / Tailscale'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function blockedV4(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return 'unparseable IPv4 address';
  for (const [base, bits, label] of BLOCKED_V4) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return label;
  }
  return null;
}

function blockedV6(ip: string): string | null {
  const lower = ip.toLowerCase().split('%')[0] ?? '';

  // IPv4-mapped and IPv4-compatible forms carry a v4 address inside a v6
  // literal. Judge them by the address they actually reach, or a loopback
  // written as ::ffff:127.0.0.1 sails past every v6 rule below.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped?.[1]) return blockedV4(mapped[1]);

  if (lower === '::' ) return 'unspecified';
  if (lower === '::1') return 'loopback';
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'unique local';
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return 'link-local';
  if (/^ff[0-9a-f]{2}:/.test(lower)) return 'multicast';
  if (/^64:ff9b:/.test(lower)) return 'NAT64';
  return null;
}

/**
 * Why this address must not be dialled, or null if it is an ordinary public one.
 *
 * Returns a reason string rather than a boolean so the audit log can say what
 * was refused and why, which is the difference between a log an operator can
 * act on and one they learn to ignore.
 */
export function blockedReason(ip: string, family: 4 | 6): string | null {
  return family === 4 ? blockedV4(ip) : blockedV6(ip);
}
