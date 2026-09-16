/**
 * The three ways to be refused, and the one thing each of them should say.
 *
 * The failure this guards is not a crash: it is a screen that tells someone to
 * sign in on a path where signing in cannot work, which is how an afternoon
 * goes. So the cases are pinned by what they offer, not by how they read.
 */
import { describe, expect, it } from 'vitest';
import { asPage, asText, hostname, refusal } from '../src/signin.js';

const ACCESS = { teamDomain: 'taste-lab.cloudflareaccess.com' };

describe('which refusal this is', () => {
  it('is off when no application issues assertions, whatever the request looks like', () => {
    expect(refusal(null, { host: 'maria.2lp.chat', ray: '8f2a-MAD' }, 'maria.2lp.chat').kind).toBe('off');
  });

  it('is bypassed when Cloudflare never forwarded it, even at the public name', () => {
    // A tailnet caller can send any Host it likes. What it cannot forge is
    // having been through Access, and cf-ray is where that shows.
    const state = refusal(ACCESS, { host: 'maria.2lp.chat', ray: undefined }, 'maria.2lp.chat');
    expect(state.kind).toBe('bypassed');
  });

  it('is expired only once the request has actually come through Access', () => {
    expect(refusal(ACCESS, { host: 'maria.2lp.chat', ray: '8f2a-MAD' }, null).kind).toBe('expired');
  });
});

describe('what each refusal offers', () => {
  it('never offers a sign-in to someone who went around the sign-on', () => {
    const text = asText(refusal(ACCESS, { host: '100.82.12.44:8792', ray: undefined }, null));
    expect(text).not.toMatch(/sign in/i);
    expect(text).toMatch(/goes around the sign-on/);
  });

  it('offers the public address instead, when it has been told one', () => {
    const text = asText(refusal(ACCESS, { host: '100.82.12.44:8792', ray: undefined }, 'maria.2lp.chat'));
    expect(text).toContain('https://maria.2lp.chat/');
  });

  it('sends an expired session to the login for the host it arrived at', () => {
    const text = asText(refusal(ACCESS, { host: 'nando.2lp.chat', ray: '8f2a-MAD' }, null));
    expect(text).toContain('https://taste-lab.cloudflareaccess.com/cdn-cgi/access/login/nando.2lp.chat');
  });

  it('names the token only where it is genuinely the only way in', () => {
    expect(asText({ kind: 'off' })).toContain('/state/panel-token');
    expect(asText(refusal(ACCESS, { host: 'nando.2lp.chat', ray: '8f2a-MAD' }, null))).not.toContain('panel-token');
  });
});

describe('the host it is handed', () => {
  it('refuses an address, a port and an empty header alike', () => {
    expect(hostname('100.82.12.44:8792')).toBeNull();
    expect(hostname(undefined)).toBeNull();
    expect(hostname('localhost')).toBeNull();
  });

  it('keeps a real name, without its port', () => {
    expect(hostname('Maria.2LP.chat:8792')).toBe('maria.2lp.chat');
  });

  it('does not let a written-in host escape the link it is put in', () => {
    // The Host header is the caller's, so it reaches the markup or it reaches
    // nothing. A name that could close an attribute is not a name.
    expect(hostname('a"onload=alert(1).com')).toBeNull();
    const page = asPage(refusal(ACCESS, { host: 'evil".com', ray: '8f2a-MAD' }, null));
    expect(page).not.toContain('evil"');
    expect(page).toContain('https://taste-lab.cloudflareaccess.com/');
  });
});

describe('the screen', () => {
  it('is written in the panel\'s own typefaces, which it can only load unauthenticated', () => {
    expect(asPage({ kind: 'off' })).toContain("url('/fonts/onest.woff2')");
  });

  it('carries no script, on a page shown to anyone who can reach the port', () => {
    expect(asPage({ kind: 'off' })).not.toMatch(/<script/i);
  });
});
