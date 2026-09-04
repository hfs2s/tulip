/**
 * Cloudflare Access assertion verification.
 *
 * This is authentication code on a surface where holding the credential is
 * equivalent to holding the deployment, so the tests that matter are the ones
 * that must *fail*. Each rejection below is a door somebody could otherwise
 * walk through: an unsigned token, a token signed by the wrong key, a token
 * minted for a different application on the same Cloudflare account, one from
 * another tenant, an expired one, and the `alg` confusion attacks that turn a
 * public key into a shared secret.
 *
 * No network: a keypair is generated here and the JWKS endpoint is stubbed.
 */
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessConfig, resetKeyCacheForTests, verifiedEmail } from '../src/access.js';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const KID = 'test-key-1';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

function sign(
  claims: Record<string, unknown>,
  opts: { key?: KeyObject; alg?: string; kid?: string } = {},
): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' };
  const body = `${b64(header)}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(body).sign(opts.key ?? privateKey);
  return `${body}.${signature.toString('base64url')}`;
}

const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  exp: Math.floor(Date.now() / 1000) + 3600,
  nbf: Math.floor(Date.now() / 1000) - 10,
  email: 'someone@example.com',
  ...over,
});

/** The JWKS endpoint, stubbed. Counts calls so key-rotation behaviour is visible. */
let fetched = 0;
const jwks = (async () => {
  fetched += 1;
  return {
    ok: true,
    json: async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, kty: 'RSA' }] }),
  };
}) as unknown as typeof fetch;

const config = { teamDomain: TEAM, aud: AUD };

beforeEach(() => { resetKeyCacheForTests(); fetched = 0; });
afterEach(() => {
  delete process.env['TULIP_ACCESS_TEAM_DOMAIN'];
  delete process.env['TULIP_ACCESS_AUD'];
});

describe('a genuine assertion', () => {
  it('returns the email Cloudflare authenticated', async () => {
    expect(await verifiedEmail(sign(valid()), config, jwks)).toBe('someone@example.com');
  });

  it('caches the signing keys rather than refetching per request', async () => {
    await verifiedEmail(sign(valid()), config, jwks);
    await verifiedEmail(sign(valid()), config, jwks);
    expect(fetched).toBe(1);
  });

  it('refetches once when it sees a kid it does not know, which is what rotation looks like', async () => {
    await verifiedEmail(sign(valid()), config, jwks);
    fetched = 0;
    await verifiedEmail(sign(valid(), { kid: 'rotated' }), config, jwks);
    expect(fetched).toBe(1);
  });
});

describe('assertions that must be refused', () => {
  it('refuses one signed by a key that is not Cloudflare’s', async () => {
    expect(await verifiedEmail(sign(valid(), { key: other.privateKey }), config, jwks)).toBeNull();
  });

  it('refuses alg=none, which would otherwise authenticate everybody', async () => {
    const header = { alg: 'none', kid: KID, typ: 'JWT' };
    const token = `${b64(header)}.${b64(valid())}.`;
    expect(await verifiedEmail(token, config, jwks)).toBeNull();
  });

  it('refuses an HMAC alg signed with the public key, the classic confusion attack', async () => {
    // The public key is not secret, so if HS256 were honoured anyone holding it
    // — anyone at all — could mint a token.
    const header = { alg: 'HS256', kid: KID, typ: 'JWT' };
    const body = `${b64(header)}.${b64(valid())}`;
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const mac = createHmac('sha256', pem).update(body).digest('base64url');
    expect(await verifiedEmail(`${body}.${mac}`, config, jwks)).toBeNull();
  });

  it('refuses a token minted for another application on the same account', async () => {
    expect(await verifiedEmail(sign(valid({ aud: ['b'.repeat(64)] })), config, jwks)).toBeNull();
  });

  it('refuses a token from another Cloudflare tenant', async () => {
    expect(await verifiedEmail(sign(valid({ iss: 'https://someone-else.cloudflareaccess.com' })), config, jwks)).toBeNull();
  });

  it('refuses an expired token', async () => {
    expect(await verifiedEmail(sign(valid({ exp: Math.floor(Date.now() / 1000) - 3600 })), config, jwks)).toBeNull();
  });

  it('refuses one that is not valid yet', async () => {
    expect(await verifiedEmail(sign(valid({ nbf: Math.floor(Date.now() / 1000) + 3600 })), config, jwks)).toBeNull();
  });

  it('refuses a valid signature carrying no email', async () => {
    expect(await verifiedEmail(sign(valid({ email: undefined })), config, jwks)).toBeNull();
  });

  it('refuses absent, malformed and oversized input', async () => {
    expect(await verifiedEmail(undefined, config, jwks)).toBeNull();
    expect(await verifiedEmail('', config, jwks)).toBeNull();
    expect(await verifiedEmail('not.a.jwt', config, jwks)).toBeNull();
    expect(await verifiedEmail('x'.repeat(9000), config, jwks)).toBeNull();
  });

  it('denies rather than admits when the keys cannot be fetched', async () => {
    const broken = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await verifiedEmail(sign(valid()), config, broken)).toBeNull();
  });
});

describe('configuration', () => {
  it('is off unless both values are present', async () => {
    expect(accessConfig()).toBeNull();
    process.env['TULIP_ACCESS_TEAM_DOMAIN'] = TEAM;
    expect(accessConfig()).toBeNull(); // team domain alone must not enable it
    process.env['TULIP_ACCESS_AUD'] = AUD;
    expect(accessConfig()).toEqual({ teamDomain: TEAM, aud: AUD });
  });

  it('is off when either value is malformed rather than trusting it', async () => {
    process.env['TULIP_ACCESS_TEAM_DOMAIN'] = 'evil.example.com';
    process.env['TULIP_ACCESS_AUD'] = AUD;
    expect(accessConfig()).toBeNull();

    process.env['TULIP_ACCESS_TEAM_DOMAIN'] = TEAM;
    process.env['TULIP_ACCESS_AUD'] = 'not-a-tag';
    expect(accessConfig()).toBeNull();
  });

  it('tolerates a team domain pasted with its scheme', async () => {
    process.env['TULIP_ACCESS_TEAM_DOMAIN'] = `https://${TEAM}/`;
    process.env['TULIP_ACCESS_AUD'] = AUD;
    expect(accessConfig()?.teamDomain).toBe(TEAM);
  });
});
