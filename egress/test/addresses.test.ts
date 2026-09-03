import { describe, expect, it } from 'vitest';
import { blockedReason } from '../src/addresses.js';

describe('blockedReason — IPv4', () => {
  it.each([
    ['loopback', '127.0.0.1', 'loopback'],
    ['loopback, high in range', '127.255.255.254', 'loopback'],
    ['private 10/8', '10.0.0.1', 'private'],
    ['private 172.16/12 low', '172.16.0.1', 'private'],
    ['private 172.16/12 high', '172.31.255.254', 'private'],
    ['private 192.168/16', '192.168.1.1', 'private'],
    ['link-local / metadata', '169.254.169.254', 'link-local / cloud metadata'],
    ['this network', '0.0.0.0', 'this network'],
    ['multicast', '239.1.2.3', 'multicast'],
    ['reserved', '255.255.255.255', 'reserved'],
    ['benchmarking', '198.19.0.1', 'benchmarking'],
    ['protocol assignments', '192.0.0.8', 'IETF protocol assignments'],
  ])('blocks %s', (_label, ip, reason) => {
    expect(blockedReason(ip, 4)).toBe(reason);
  });

  // The reason this range is called out specially: the host runs on a tailnet
  // that also carries a production machine.
  it.each(['100.64.0.1', '100.82.12.44', '100.127.255.254'])('blocks the Tailscale/CGNAT range (%s)', (ip) => {
    expect(blockedReason(ip, 4)).toBe('carrier-grade NAT / Tailscale');
  });

  it('permits ordinary public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '160.79.104.10', '99.255.255.255', '100.63.255.255', '100.128.0.0']) {
      expect(blockedReason(ip, 4)).toBeNull();
    }
  });

  it('rejects an address it cannot parse rather than permitting it', () => {
    for (const bad of ['', 'nonsense', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4x']) {
      expect(blockedReason(bad, 4)).not.toBeNull();
    }
  });
});

describe('blockedReason — IPv6', () => {
  it.each([
    ['loopback', '::1', 'loopback'],
    ['unspecified', '::', 'unspecified'],
    ['unique local fc00::/7', 'fc00::1', 'unique local'],
    ['unique local fd00::/8', 'fd12:3456::1', 'unique local'],
    ['link-local', 'fe80::1', 'link-local'],
    ['multicast', 'ff02::1', 'multicast'],
    ['NAT64', '64:ff9b::1.2.3.4', 'NAT64'],
  ])('blocks %s', (_label, ip, reason) => {
    expect(blockedReason(ip, 6)).toBe(reason);
  });

  // The bypass this closes: a v6 literal that actually reaches a v4 loopback.
  it('judges IPv4-mapped addresses by the address they reach', () => {
    expect(blockedReason('::ffff:127.0.0.1', 6)).toBe('loopback');
    expect(blockedReason('::ffff:10.0.0.1', 6)).toBe('private');
    expect(blockedReason('::ffff:169.254.169.254', 6)).toBe('link-local / cloud metadata');
    expect(blockedReason('::ffff:8.8.8.8', 6)).toBeNull();
  });

  it('ignores a zone index when judging a link-local address', () => {
    expect(blockedReason('fe80::1%eth0', 6)).toBe('link-local');
  });

  it('is case-insensitive', () => {
    expect(blockedReason('FE80::1', 6)).toBe('link-local');
    expect(blockedReason('FD00::1', 6)).toBe('unique local');
  });

  it('permits ordinary public addresses', () => {
    expect(blockedReason('2606:4700:4700::1111', 6)).toBeNull();
    expect(blockedReason('2001:4860:4860::8888', 6)).toBeNull();
  });
});
