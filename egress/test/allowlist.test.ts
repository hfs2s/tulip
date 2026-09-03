import { describe, expect, it } from 'vitest';
import { decide, normaliseHost, parseAllowlist, parseAuthority } from '../src/allowlist.js';

const ALLOW = parseAllowlist('api.anthropic.com,*.example.net');

/** Convenience: was this authority permitted? */
const allowed = (authority: string): boolean => decide(authority, ALLOW).allowed;

describe('normaliseHost', () => {
  it('lowercases', () => {
    expect(normaliseHost('API.Anthropic.COM')).toBe('api.anthropic.com');
  });

  it('strips exactly one trailing root dot', () => {
    expect(normaliseHost('api.anthropic.com.')).toBe('api.anthropic.com');
    expect(normaliseHost('api.anthropic.com..')).toBeNull();
  });

  it.each([
    ['userinfo', 'api.anthropic.com@evil.test'],
    ['path', 'evil.test/api.anthropic.com'],
    ['backslash path', 'evil.test\\api.anthropic.com'],
    ['fragment', 'evil.test#api.anthropic.com'],
    ['query', 'evil.test?api.anthropic.com'],
    ['embedded colon', 'api.anthropic.com:443'],
    ['percent encoding', 'api.anthropic%2ecom'],
    ['whitespace', 'api.anthropic.com '],
    ['underscore', 'api_anthropic.com'],
    ['bracketed IPv6', '[::1]'],
    ['single label', 'localhost'],
    ['empty', ''],
    ['leading hyphen label', '-api.anthropic.com'],
    ['trailing hyphen label', 'api-.anthropic.com'],
    ['double dot', 'api..anthropic.com'],
    ['non-ascii homograph', 'аpi.anthropic.com'],
  ])('rejects %s', (_label, input) => {
    expect(normaliseHost(input)).toBeNull();
  });

  it('rejects a name longer than the DNS limit', () => {
    expect(normaliseHost(`${'a'.repeat(60)}.`.repeat(5) + 'com')).toBeNull();
  });
});

describe('parseAuthority', () => {
  it('splits host and port', () => {
    expect(parseAuthority('api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 });
  });

  it.each([
    ['no port', 'api.anthropic.com'],
    ['empty port', 'api.anthropic.com:'],
    ['non-numeric port', 'api.anthropic.com:https'],
    ['port zero', 'api.anthropic.com:0'],
    ['port out of range', 'api.anthropic.com:65536'],
    ['negative port', 'api.anthropic.com:-1'],
    ['leading colon', ':443'],
    ['IPv6 literal', '[::1]:443'],
    ['double colon host', 'a:b:443'],
  ])('rejects %s', (_label, input) => {
    expect(parseAuthority(input)).toBeNull();
  });

  it('rejects an over-long authority without evaluating it', () => {
    expect(parseAuthority(`${'a'.repeat(400)}.com:443`)).toBeNull();
  });
});

describe('decide — hostname confusion', () => {
  it('permits an exact allowlisted host on 443', () => {
    expect(allowed('api.anthropic.com:443')).toBe(true);
  });

  it('permits regardless of case and trailing dot', () => {
    expect(allowed('API.ANTHROPIC.COM:443')).toBe(true);
    expect(allowed('api.anthropic.com.:443')).toBe(true);
  });

  it.each([
    ['suffix confusion', 'api.anthropic.com.evil.test:443'],
    ['prefix confusion', 'evil-api.anthropic.com.attacker.test:443'],
    ['substring, not a label', 'notapi.anthropic.com:443'],
    ['parent domain', 'anthropic.com:443'],
    ['sibling subdomain', 'evil.anthropic.com:443'],
    ['userinfo trick', 'api.anthropic.com@evil.test:443'],
    ['unrelated host', 'evil.test:443'],
  ])('refuses %s', (_label, authority) => {
    expect(allowed(authority)).toBe(false);
  });

  it('refuses an allowlisted host on any port but 443', () => {
    expect(allowed('api.anthropic.com:80')).toBe(false);
    expect(allowed('api.anthropic.com:22')).toBe(false);
    expect(allowed('api.anthropic.com:8080')).toBe(false);
  });

  it('explains the refusal', () => {
    const verdict = decide('evil.test:443', ALLOW);
    expect(verdict).toMatchObject({ allowed: false });
    if (!verdict.allowed) expect(verdict.reason).toBe('host is not on the allowlist');
  });
});

describe('decide — wildcards', () => {
  it('permits a direct subdomain', () => {
    expect(allowed('cdn.example.net:443')).toBe(true);
  });

  it('permits a deeper subdomain', () => {
    expect(allowed('a.b.example.net:443')).toBe(true);
  });

  it('permits the apex itself', () => {
    expect(allowed('example.net:443')).toBe(true);
  });

  it('does not permit a name that merely ends with the same letters', () => {
    expect(allowed('notexample.net:443')).toBe(false);
    expect(allowed('evil-example.net:443')).toBe(false);
  });

  it('does not permit the wildcard base as a suffix of another domain', () => {
    expect(allowed('example.net.evil.test:443')).toBe(false);
  });
});

describe('parseAllowlist', () => {
  it('is empty, and therefore refuses everything, when unset', () => {
    const none = parseAllowlist(undefined);
    expect(none.exact.size).toBe(0);
    expect(none.suffixes).toEqual([]);
    expect(decide('api.anthropic.com:443', none).allowed).toBe(false);
  });

  it('ignores blank entries and surrounding whitespace', () => {
    const list = parseAllowlist(' api.anthropic.com , , ');
    expect(list.exact.has('api.anthropic.com')).toBe(true);
    expect(list.exact.size).toBe(1);
  });

  it('throws on a malformed entry rather than silently dropping it', () => {
    expect(() => parseAllowlist('not a host')).toThrow(/invalid allowlist entry/);
    expect(() => parseAllowlist('*.not a host')).toThrow(/invalid wildcard allowlist entry/);
  });
});
