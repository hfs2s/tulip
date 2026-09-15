/**
 * Both halves of Bot Framework authentication, against a key pair minted here.
 *
 * The inbound verifier is the whole of the Teams endpoint's trust, so each of
 * Microsoft's requirements gets a token that fails exactly one of them. The
 * outbound token source is tested for the two things that would cost money or
 * availability if wrong: the request shape, and that the token is cached.
 */
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BotTokenVerifier,
  CONNECTOR_SCOPE,
  ISSUER,
  OPENID_METADATA,
  TokenSource,
  serviceUrlMatches,
} from '../src/teams/auth.js';

const APP_ID = '11111111-2222-3333-4444-555555555555';
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const KEYS_URL = 'https://login.botframework.com/v1/.well-known/keys';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...(key.export({ format: 'jwk' }) as Record<string, unknown>), kid, use: 'sig', alg: 'RS256' };
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function sign(
  claims: Record<string, unknown>,
  { key = privateKey, kid = 'k1', alg = 'RS256' }: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const header = b64({ typ: 'JWT', alg, kid });
  const payload = b64(claims);
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const NOW_S = 1_800_000_000;
const now = (): number => NOW_S * 1000;

function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, aud: APP_ID, nbf: NOW_S - 60, exp: NOW_S + 600, serviceurl: SERVICE, ...overrides };
}

/** A fetch that answers the metadata and the keys and counts what it was asked. */
function jwks(keys: Record<string, unknown>[]): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === OPENID_METADATA) {
      return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: KEYS_URL, id_token_signing_alg_values_supported: ['RS256'] }), { status: 200 });
    }
    if (url === KEYS_URL) return new Response(JSON.stringify({ keys }), { status: 200 });
    throw new Error(`the test did not expect a fetch of ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe('the connector token', () => {
  it('verifies a good one and hands back the serviceurl claim', async () => {
    const { fetcher } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect(await verifier.verify(`Bearer ${sign(goodClaims())}`)).toEqual({ ok: true, serviceUrl: SERVICE });
  });

  it('is case-insensitive about the audience, as app ids are', async () => {
    const { fetcher } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect((await verifier.verify(`Bearer ${sign(goodClaims({ aud: APP_ID.toUpperCase() }))}`)).ok).toBe(true);
  });

  it.each([
    ['wrong audience', goodClaims({ aud: '99999999-2222-3333-4444-555555555555' })],
    ['wrong issuer', goodClaims({ iss: 'https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/' })],
    ['expired', goodClaims({ exp: NOW_S - 600 })],
    ['not yet valid', goodClaims({ nbf: NOW_S + 600 })],
  ])('refuses one that is %s', async (reason, claims) => {
    const { fetcher } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect(await verifier.verify(`Bearer ${sign(claims)}`)).toEqual({ ok: false, reason });
  });

  it('allows five minutes of skew on expiry and not a second more', async () => {
    const { fetcher } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect((await verifier.verify(`Bearer ${sign(goodClaims({ exp: NOW_S - 299 }))}`)).ok).toBe(true);
    expect((await verifier.verify(`Bearer ${sign(goodClaims({ exp: NOW_S - 301 }))}`)).ok).toBe(false);
  });

  it('refuses a signature from a key the metadata does not list', async () => {
    const { fetcher } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect(await verifier.verify(`Bearer ${sign(goodClaims(), { key: other.privateKey, kid: 'k1' })}`)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('refetches the keys once for an unknown kid, and refuses if it is still unknown', async () => {
    const { fetcher, calls } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect((await verifier.verify(`Bearer ${sign(goodClaims())}`)).ok).toBe(true);
    const fetchesAfterWarmUp = calls.length;
    expect(await verifier.verify(`Bearer ${sign(goodClaims(), { kid: 'k-rotated' })}`)).toEqual({ ok: false, reason: 'unknown kid' });
    expect(calls.length).toBe(fetchesAfterWarmUp + 2); // metadata + keys, once
    // A second unknown kid inside the minute does not refetch: that is how a
    // stranger would otherwise make us hammer Microsoft's key endpoint.
    expect(await verifier.verify(`Bearer ${sign(goodClaims(), { kid: 'k-other' })}`)).toEqual({ ok: false, reason: 'unknown kid' });
    expect(calls.length).toBe(fetchesAfterWarmUp + 2);
  });

  it('caches the keys across verifications', async () => {
    const { fetcher, calls } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    await verifier.verify(`Bearer ${sign(goodClaims())}`);
    await verifier.verify(`Bearer ${sign(goodClaims())}`);
    expect(calls).toEqual([OPENID_METADATA, KEYS_URL]);
  });

  it('pins RS256 rather than honouring the header', async () => {
    const { fetcher } = jwks([jwk(publicKey, 'k1')]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect(await verifier.verify(`Bearer ${sign(goodClaims(), { alg: 'none' })}`)).toEqual({ ok: false, reason: 'algorithm is not RS256' });
    expect(await verifier.verify(`Bearer ${sign(goodClaims(), { alg: 'HS256' })}`)).toEqual({ ok: false, reason: 'algorithm is not RS256' });
  });

  it('refuses everything that is not a bearer JWT, before touching the network', async () => {
    const { fetcher, calls } = jwks([]);
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect(await verifier.verify(undefined)).toEqual({ ok: false, reason: 'no authorization header' });
    expect(await verifier.verify('Basic abc')).toEqual({ ok: false, reason: 'not a bearer token' });
    expect(await verifier.verify('Bearer a.b')).toEqual({ ok: false, reason: 'malformed token' });
    expect(await verifier.verify('Bearer a.b.c')).toEqual({ ok: false, reason: 'malformed token' });
    expect(calls).toEqual([]);
  });

  it('does not admit anybody when the key endpoint is down', async () => {
    const fetcher = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const verifier = new BotTokenVerifier(APP_ID, fetcher, now);
    expect(await verifier.verify(`Bearer ${sign(goodClaims())}`)).toEqual({ ok: false, reason: 'unknown kid' });
  });
});

describe('the serviceurl claim', () => {
  it('must be present and must name the activity\'s service', () => {
    expect(serviceUrlMatches(SERVICE, SERVICE)).toBe(true);
    expect(serviceUrlMatches('https://SMBA.trafficmanager.net/emea', SERVICE)).toBe(true);
    expect(serviceUrlMatches('https://smba.trafficmanager.net/amer/', SERVICE)).toBe(false);
    expect(serviceUrlMatches(null, SERVICE)).toBe(false);
  });
});

describe('our own token', () => {
  function login(): { fetcher: typeof fetch; requests: Array<{ url: string; body: string }> } {
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ token_type: 'Bearer', expires_in: 3600, access_token: `tok-${requests.length}` }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetcher, requests };
  }

  it('is minted with client credentials against botframework.com for a multi-tenant app', async () => {
    const { fetcher, requests } = login();
    const source = new TokenSource({ appId: APP_ID, appSecret: 'shh-not-in-any-log', tenantId: null }, fetcher, now);
    expect(await source.bearer()).toBe('tok-1');
    expect(requests[0]?.url).toBe('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token');
    const form = new URLSearchParams(requests[0]?.body ?? '');
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe(APP_ID);
    expect(form.get('client_secret')).toBe('shh-not-in-any-log');
    expect(form.get('scope')).toBe(CONNECTOR_SCOPE);
  });

  it('is minted against the tenant for a single-tenant app', async () => {
    const { fetcher, requests } = login();
    const source = new TokenSource({ appId: APP_ID, appSecret: 's', tenantId: 'aaaabbbb-0000-cccc-1111-dddd2222eeee' }, fetcher, now);
    await source.bearer();
    expect(requests[0]?.url).toBe('https://login.microsoftonline.com/aaaabbbb-0000-cccc-1111-dddd2222eeee/oauth2/v2.0/token');
  });

  it('is cached until shortly before it expires, and fetched once even under concurrent asks', async () => {
    const { fetcher, requests } = login();
    let clock = now();
    const source = new TokenSource({ appId: APP_ID, appSecret: 's', tenantId: null }, fetcher, () => clock);
    const [a, b] = await Promise.all([source.bearer(), source.bearer()]);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(requests).toHaveLength(1);

    clock += (3600 - 301) * 1000; // inside the margin: still cached
    expect(await source.bearer()).toBe('tok-1');
    clock += 2 * 1000; // past it
    expect(await source.bearer()).toBe('tok-2');
    expect(requests).toHaveLength(2);
  });

  it('reports a refusal by status alone, never by echoing the request', async () => {
    const fetcher = (async () => new Response('{"error":"invalid_client","error_description":"secret was s"}', { status: 401 })) as unknown as typeof fetch;
    const source = new TokenSource({ appId: APP_ID, appSecret: 's', tenantId: null }, fetcher, now);
    await expect(source.bearer()).rejects.toThrow('login service returned 401');
  });
});
