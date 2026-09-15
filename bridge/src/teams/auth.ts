/**
 * Both directions of Bot Framework authentication, over plain HTTPS.
 *
 * Microsoft's own guidance is that a bot written without the SDK "must
 * implement all security procedures correctly", and then lists them. This
 * file is that list, and follows the shape `access.ts` already uses for
 * Cloudflare: RS256 pinned, keys fetched from the published metadata and
 * cached, an unknown `kid` refetched once, claims checked strictly after the
 * signature and never before. No library: the codebase verifies one JWT
 * already with `node:crypto`, and a second verifier is a smaller surface than
 * a dependency.
 *
 * **Inbound** — the connector calling us. The token must:
 *   1. arrive as `Authorization: Bearer …`;
 *   2. carry `iss` of exactly `https://api.botframework.com`;
 *   3. carry `aud` equal to our app id — without this a token minted for any
 *      other bot on the service would open this one;
 *   4. be inside `nbf`…`exp`, with the industry five minutes of skew;
 *   5. verify under a key from the JWKS the OpenID metadata names, with the
 *      algorithm pinned to RS256 rather than read from the header;
 *   6. carry a `serviceurl` claim matching the activity's `serviceUrl`. The
 *      listener does that last comparison, because it needs the body; this
 *      file hands the claim back for it.
 *
 * Channel endorsements (step 6 in Microsoft's list) are not checked: Tulip
 * accepts one channel, `msteams`, and a token that verifies under the
 * connector's keys can only have come from the connector.
 *
 * The emulator's separate verification path is deliberately absent. It would
 * accept tokens minted with our own credentials, which is a second door for a
 * tool this deployment does not use.
 *
 * **Outbound** — us calling the connector. A client-credentials token from the
 * Entra login endpoint, scoped to `https://api.botframework.com/.default`,
 * cached until five minutes before it expires and fetched once at a time. The
 * app secret is read once, at construction, and appears in no log line.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { log } from '../log.js';

export const OPENID_METADATA = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const ISSUER = 'https://api.botframework.com';
export const CONNECTOR_SCOPE = 'https://api.botframework.com/.default';

/** Microsoft asks for a refresh at least daily; keys are otherwise stable. */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
/** An unknown `kid` refetches, but not on every hostile request. */
const FORCED_REFETCH_MIN_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
/** Industry-standard clock skew, per the connector authentication guide. */
const SKEW_S = 300;
/** Refreshed this long before the login service says it expires. */
const TOKEN_MARGIN_S = 300;

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
}

export type Verdict =
  | { readonly ok: true; readonly serviceUrl: string | null }
  | { readonly ok: false; readonly reason: string };

const decode = (segment: string): Buffer => Buffer.from(segment, 'base64url');

/** Verifies tokens the connector presents to us. One per bridge; caches keys. */
export class BotTokenVerifier {
  private keys: { at: number; byKid: Map<string, KeyObject> } | null = null;
  private lastForcedAt = 0;

  constructor(
    private readonly appId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async publicKeys(force: boolean): Promise<Map<string, KeyObject>> {
    const now = this.now();
    if (!force && this.keys !== null && now - this.keys.at < JWKS_TTL_MS) return this.keys.byKid;
    if (force && now - this.lastForcedAt < FORCED_REFETCH_MIN_MS) return this.keys?.byKid ?? new Map();
    if (force) this.lastForcedAt = now;

    const byKid = new Map<string, KeyObject>();
    try {
      const meta = await this.fetcher(OPENID_METADATA, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!meta.ok) throw new Error(`metadata endpoint returned ${String(meta.status)}`);
      const document = (await meta.json()) as { jwks_uri?: unknown };
      if (typeof document.jwks_uri !== 'string' || !document.jwks_uri.startsWith('https://')) {
        throw new Error('metadata names no https jwks_uri');
      }
      const response = await this.fetcher(document.jwks_uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`keys endpoint returned ${String(response.status)}`);
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
      log('teams.jwksFailed', { err: String((err as Error).message) });
      // Deliberately not cached: a failed fetch must not become a lasting empty
      // key set that refuses Microsoft until the TTL expires.
      return this.keys?.byKid ?? new Map();
    }
    this.keys = { at: now, byKid };
    return byKid;
  }

  /**
   * Check one `Authorization` header value.
   *
   * The reasons are for the log, which an operator reads to find out why a
   * message never arrived. They are never sent back to the caller: a 401 with
   * no body is the whole answer, because a detailed one is a probing oracle.
   */
  async verify(authorization: string | undefined): Promise<Verdict> {
    if (typeof authorization !== 'string') return { ok: false, reason: 'no authorization header' };
    const match = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(authorization.trim());
    if (match === null || match[1] === undefined) return { ok: false, reason: 'not a bearer token' };
    const token = match[1];
    if (token.length > 8192) return { ok: false, reason: 'token too long' };

    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

    let header: { alg?: unknown; kid?: unknown };
    let claims: { aud?: unknown; iss?: unknown; exp?: unknown; nbf?: unknown; serviceurl?: unknown };
    try {
      header = JSON.parse(decode(rawHeader).toString('utf8')) as typeof header;
      claims = JSON.parse(decode(rawPayload).toString('utf8')) as typeof claims;
    } catch {
      return { ok: false, reason: 'malformed token' };
    }

    // Pinned, not read. Honouring the token's own `alg` is the classic
    // confusion attack: `none` authenticates everybody, and an HMAC alg turns
    // the public key into the shared secret an attacker already has.
    if (header.alg !== 'RS256') return { ok: false, reason: 'algorithm is not RS256' };
    if (typeof header.kid !== 'string') return { ok: false, reason: 'no kid' };

    let byKid = await this.publicKeys(false);
    let key = byKid.get(header.kid);
    if (key === undefined) {
      // An unknown kid is what a key rotation looks like from here.
      byKid = await this.publicKeys(true);
      key = byKid.get(header.kid);
    }
    if (key === undefined) return { ok: false, reason: 'unknown kid' };

    let signatureOk = false;
    try {
      signatureOk = createVerify('RSA-SHA256').update(`${rawHeader}.${rawPayload}`).verify(key, decode(rawSignature));
    } catch {
      return { ok: false, reason: 'bad signature' };
    }
    if (!signatureOk) return { ok: false, reason: 'bad signature' };

    // Claims are only meaningful once the signature holds, so they are checked
    // strictly after it and never before.
    if (claims.iss !== ISSUER) return { ok: false, reason: 'wrong issuer' };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const mine = this.appId.toLowerCase();
    if (!audiences.some((a) => typeof a === 'string' && a.toLowerCase() === mine)) {
      return { ok: false, reason: 'wrong audience' };
    }
    const now = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== 'number' || now > claims.exp + SKEW_S) return { ok: false, reason: 'expired' };
    if (typeof claims.nbf === 'number' && now + SKEW_S < claims.nbf) return { ok: false, reason: 'not yet valid' };

    return { ok: true, serviceUrl: typeof claims.serviceurl === 'string' ? claims.serviceurl : null };
  }
}

/**
 * Whether the token's `serviceurl` claim names the activity's `serviceUrl`.
 *
 * Compared without regard to case or a trailing slash, which is the latitude
 * Microsoft's own libraries allow, and no more. A token with no claim at all
 * fails: the claim is what stops a valid token for one service being replayed
 * with a body that points at another.
 */
export function serviceUrlMatches(claim: string | null, activityServiceUrl: string): boolean {
  if (claim === null) return false;
  const norm = (u: string): string => u.trim().toLowerCase().replace(/\/+$/, '');
  return norm(claim) === norm(activityServiceUrl);
}

export interface BotCredentials {
  readonly appId: string;
  readonly appSecret: string;
  /** A single-tenant app's tenant; null means the multi-tenant `botframework.com` authority. */
  readonly tenantId: string | null;
}

/** The token we present to the connector. Cached, refreshed early, fetched once at a time. */
export class TokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly credentials: BotCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The login endpoint this app mints against. */
  get tokenUrl(): string {
    const authority = this.credentials.tenantId ?? 'botframework.com';
    return `https://login.microsoftonline.com/${encodeURIComponent(authority)}/oauth2/v2.0/token`;
  }

  async bearer(): Promise<string> {
    const now = this.now();
    if (this.cached !== null && now < this.cached.expiresAt) return this.cached.token;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.mint().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async mint(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.credentials.appId,
      client_secret: this.credentials.appSecret,
      scope: CONNECTOR_SCOPE,
    });
    const response = await this.fetcher(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // The status and nothing else. The body can quote the request back,
      // and the request carries the secret.
      throw new Error(`login service returned ${String(response.status)}`);
    }
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new Error('login service returned no access token');
    }
    const ttl = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600;
    this.cached = { token: payload.access_token, expiresAt: this.now() + Math.max(0, ttl - TOKEN_MARGIN_S) * 1000 };
    log('teams.token', { expiresInS: ttl });
    return payload.access_token;
  }

  /** Test seam. */
  forget(): void {
    this.cached = null;
  }
}
