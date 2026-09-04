/**
 * Cloudflare Access as a second way to authenticate to the panel.
 *
 * The panel's own credential is one bearer token, which is fine for one
 * operator and the wrong shape for two: the same secret is shared by everyone
 * who holds it, the log cannot tell them apart, and revoking one person means
 * rotating for all of them — including whoever is mid-session. Access already
 * identifies each person by email; this is what makes the panel listen.
 *
 * With it configured, adding somebody is a policy change in Cloudflare and
 * nothing else. No secret is handed out, removal is immediate and per-person,
 * and the structured log records who acted rather than "the token holder".
 *
 * **The identity comes from the signed assertion, never from a header.**
 * Cloudflare also sets `Cf-Access-Authenticated-User-Email`, and trusting it
 * would be an authentication bypass rather than a shortcut: this panel is
 * published on the host's tailnet address, so a request can reach it without
 * passing through Cloudflare at all, and anything on that network could simply
 * claim to be anyone. Only `Cf-Access-Jwt-Assertion` is consulted, and only
 * after its RS256 signature verifies against Cloudflare's published keys.
 *
 * Three things are checked beyond the signature, and each closes a real door:
 *
 *   - **`aud`** must equal this application's tag. Without it, a token minted
 *     for any *other* application in the same Cloudflare team would be accepted
 *     here — and there are others on this account.
 *   - **`iss`** must be the configured team domain, so a token from somebody
 *     else's Cloudflare tenant is not merely a valid signature from the wrong
 *     issuer.
 *   - **`exp` and `nbf`**, so an old assertion cannot be replayed.
 *
 * It fails closed everywhere. Unset configuration disables it entirely rather
 * than defaulting to something permissive, an unreachable JWKS endpoint denies
 * rather than admits, and any parse failure is a denial. The bearer token
 * remains the way in over an SSH tunnel or on loopback, where there is no
 * Access in front to ask.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { log } from './log.js';

/** Long enough that a normal page load never refetches; short enough to follow a rotation. */
const JWKS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
/** A little slack for clock skew between Cloudflare and this box. */
const SKEW_S = 60;

export interface AccessConfig {
  /** e.g. `example.cloudflareaccess.com` — the team domain, without a scheme. */
  readonly teamDomain: string;
  /** The application's AUD tag, from its page in the Zero Trust dashboard. */
  readonly aud: string;
}

/**
 * Read the configuration, or null when it is absent.
 *
 * Null disables Access authentication rather than relaxing it. Both values are
 * required precisely because `aud` is what binds an assertion to *this*
 * application; a deployment that set only the team domain would accept every
 * app on the account.
 */
export function accessConfig(): AccessConfig | null {
  const teamDomain = (process.env['TULIP_ACCESS_TEAM_DOMAIN'] ?? '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const aud = (process.env['TULIP_ACCESS_AUD'] ?? '').trim();
  if (teamDomain.length === 0 || aud.length === 0) return null;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain)) {
    log('access.badTeamDomain', { note: 'expected <team>.cloudflareaccess.com; Access auth is off' });
    return null;
  }
  if (!/^[a-f0-9]{64}$/i.test(aud)) {
    log('access.badAud', { note: 'expected a 64-character hex AUD tag; Access auth is off' });
    return null;
  }
  return { teamDomain, aud };
}

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
}

let keys: { at: number; byKid: Map<string, KeyObject> } | null = null;

/** Cloudflare's signing keys, cached, refetched when a `kid` is unknown to us. */
async function publicKeys(
  config: AccessConfig,
  fetcher: typeof fetch,
  force: boolean,
): Promise<Map<string, KeyObject>> {
  if (!force && keys !== null && Date.now() - keys.at < JWKS_TTL_MS) return keys.byKid;

  const byKid = new Map<string, KeyObject>();
  try {
    const response = await fetcher(`https://${config.teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`certs endpoint returned ${String(response.status)}`);
    const payload = (await response.json()) as { keys?: readonly Jwk[] };
    for (const jwk of payload.keys ?? []) {
      // RSA only. Accepting whatever the endpoint offers is how an unexpected
      // key type becomes an unexpected verification path.
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      try {
        byKid.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
      } catch {
        /* a key we cannot import is a key we will not verify against */
      }
    }
  } catch (err) {
    log('access.jwksFailed', { err: String((err as Error).message) });
    // Deliberately not cached: a failed fetch must not become a lasting empty
    // key set that denies everybody until the TTL expires.
    return keys?.byKid ?? new Map();
  }

  keys = { at: Date.now(), byKid };
  return byKid;
}

const decode = (segment: string): Buffer => Buffer.from(segment, 'base64url');

/**
 * The email of the person Cloudflare authenticated, or null.
 *
 * Null is the only failure mode — every reason to reject collapses to "not
 * authenticated", because the caller's next move is identical for all of them
 * and a detailed error here would be a probing oracle.
 */
export async function verifiedEmail(
  assertion: string | undefined,
  config: AccessConfig,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  if (typeof assertion !== 'string' || assertion.length === 0 || assertion.length > 8192) return null;

  const parts = assertion.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown };
  let claims: { aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; email?: unknown };
  try {
    header = JSON.parse(decode(rawHeader).toString('utf8')) as typeof header;
    claims = JSON.parse(decode(rawPayload).toString('utf8')) as typeof claims;
  } catch {
    return null;
  }

  // Pinned, not read. Honouring the token's own `alg` is the classic confusion
  // attack: `none` authenticates everybody, and an HMAC alg turns the public
  // key into the shared secret an attacker already has.
  if (header.alg !== 'RS256') return null;
  if (typeof header.kid !== 'string') return null;

  const signed = `${rawHeader}.${rawPayload}`;
  const signature = decode(rawSignature);

  let byKid = await publicKeys(config, fetcher, false);
  let key = byKid.get(header.kid);
  if (key === undefined) {
    // An unknown kid is what a key rotation looks like from here.
    byKid = await publicKeys(config, fetcher, true);
    key = byKid.get(header.kid);
  }
  if (key === undefined) return null;

  let signatureOk = false;
  try {
    signatureOk = createVerify('RSA-SHA256').update(signed).verify(key, signature);
  } catch {
    return null;
  }
  if (!signatureOk) return null;

  // Claims are only meaningful once the signature holds, so they are checked
  // strictly after it and never before.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.some((a) => typeof a === 'string' && a === config.aud)) return null;
  if (claims.iss !== `https://${config.teamDomain}`) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || now > claims.exp + SKEW_S) return null;
  if (typeof claims.nbf === 'number' && now + SKEW_S < claims.nbf) return null;

  return typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null;
}

/** Test seam: the key cache is process-wide, and a test must not inherit another's. */
export function resetKeyCacheForTests(): void {
  keys = null;
}
