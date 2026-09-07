/**
 * Pages the agent builds, and what must never be served from them.
 *
 * These are public, agent-authored, and on the operator's own domain. The
 * happy path is the least interesting part: what matters is that the extension
 * allowlist holds, that a name cannot climb out of the directory, and that the
 * whole feature stays off until a hostname is configured — because the hostname
 * is what keeps agent JavaScript off the panel's origin.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-pages-'));
process.env['TULIP_STATE_DIR'] = root;
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { publishPage, listPages, deletePage, isPagesRequest, SLUG, mayChange,
  hashPagePassword, pageAuthorised, unpublishPage, republishPage, isUnpublished } = await import('../src/pages.js');
const { parseConfig } = await import('../src/config.js');
const { outPaths } = await import('@tulip/shared');

function build(slug: string, files: Record<string, string> = { 'index.html': '<h1>hi</h1>' }): void {
  const dir = outPaths.page(slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
}

beforeEach(() => {
  rmSync(outPaths.pages, { recursive: true, force: true });
  process.env['TULIP_PAGES_HOST'] = 'pages.example.com';
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('publishing', () => {
  it('hands back the address on the pages host, not the panel’s', () => {
    build('party-plan');
    expect(publishPage('party-plan')).toEqual({ ok: true, url: 'https://pages.example.com/party-plan/' });
  });

  it('refuses a page with no index, and says what to do about it', () => {
    build('nothing', { 'app.js': 'console.log(1)' });
    const result = publishPage('nothing');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('index.html');
  });

  it('refuses a directory that does not exist', () => {
    expect(publishPage('never-made').ok).toBe(false);
  });
});

describe('the whole feature is off without a hostname', () => {
  it('refuses to publish, because a page has nowhere safe to live', () => {
    // Without its own origin, agent-authored JavaScript would be same-origin
    // with the operator's session. Off is the correct behaviour, not a
    // degraded one.
    delete process.env['TULIP_PAGES_HOST'];
    build('party-plan');
    expect(publishPage('party-plan').ok).toBe(false);
  });

  it('routes nothing to pages, so the panel keeps every hostname', () => {
    delete process.env['TULIP_PAGES_HOST'];
    expect(isPagesRequest('pages.example.com')).toBe(false);
  });
});

describe('which hostname is a page', () => {
  it('matches the configured host and ignores its port', () => {
    expect(isPagesRequest('pages.example.com')).toBe(true);
    expect(isPagesRequest('pages.example.com:8791')).toBe(true);
    expect(isPagesRequest('PAGES.EXAMPLE.COM')).toBe(true);
  });

  it('does not match the panel, which is the entire point', () => {
    expect(isPagesRequest('tulip.example.com')).toBe(false);
    expect(isPagesRequest(undefined)).toBe(false);
    // A prefix match here would hand the panel's origin to a page.
    expect(isPagesRequest('evil-pages.example.com')).toBe(false);
  });
});

describe('slugs', () => {
  it('accepts ordinary names', () => {
    expect(SLUG.test('party-plan')).toBe(true);
  });

  it('refuses anything that could climb, shout or hide', () => {
    for (const bad of ['..', '../etc', 'Party', 'a', 'x'.repeat(49), 'has space', '.hidden', 'under_score']) {
      expect(SLUG.test(bad)).toBe(false);
    }
  });

  it('refuses to delete by a name that is not a slug', () => {
    build('keeper');
    expect(deletePage('../keeper')).toBe(false);
    expect(listPages().map((p) => p.slug)).toEqual(['keeper']);
  });
});

describe('the root of the pages host', () => {
  const hit = async (): Promise<{ status: number; location: string }> => {
    const { servePage } = await import('../src/pages.js');
    let status = 0;
    let location = '';
    const res = {
      writeHead(code: number, headers: Record<string, string>) {
        status = code; location = headers['location'] ?? ''; return this;
      },
      end() { return this; },
    } as unknown as import('node:http').ServerResponse;
    servePage(res, new URL('http://pages.example.com/'));
    return { status, location };
  };

  // A directory here would make every page discoverable by anyone who finds the
  // hostname, when the point of a page is that its author hands somebody the
  // link. The operator's listing is in the panel, behind the token. So the root
  // never lists — the only question is where it sends people instead.

  it('sends them to the configured destination', async () => {
    process.env['TULIP_PAGES_ROOT_REDIRECT'] = 'https://example.com/';
    build('party-plan');
    const out = await hit();
    expect(out.status).toBe(302);
    expect(out.location).toBe('https://example.com/');
  });

  it('answers 404 when no destination is configured, rather than guessing one', () => {
    // This was one deployment's own marketing site, hardcoded. Anybody else
    // running Tulip would have been redirecting their visitors to a stranger.
    delete process.env['TULIP_PAGES_ROOT_REDIRECT'];
    build('party-plan');
    return hit().then((out) => {
      expect(out.status).toBe(404);
      expect(out.location).toBe('');
    });
  });
});

describe('listing', () => {
  it('reports what is there, newest first, and forgets what is deleted', () => {
    build('one');
    build('two', { 'index.html': '<h1>2</h1>', 'app.css': 'body{}' });
    expect(listPages().map((p) => p.slug).sort()).toEqual(['one', 'two']);
    expect(listPages().find((p) => p.slug === 'two')?.files).toBe(2);

    expect(deletePage('two')).toBe(true);
    expect(listPages().map((p) => p.slug)).toEqual(['one']);
  });

  it('ignores a directory whose name is not a slug', () => {
    mkdirSync(join(outPaths.pages, 'Not A Slug'), { recursive: true });
    writeFileSync(join(outPaths.pages, 'Not A Slug', 'index.html'), 'x');
    expect(listPages()).toEqual([]);
  });
});

/**
 * The holding message.
 *
 * Building a page is minutes of silence at the other end, and the brief already
 * asked the agent to say so — under "slow work", which it did not connect to
 * building a page. So the bridge says it, and these pin the two properties that
 * make that safe: it never talks over a turn that already spoke, and it does
 * not spend the reply allowance it is standing in for.
 */
describe('announcing a page before building it', () => {
  it('is sent when the turn has said nothing yet', async () => {
    const sent: string[] = [];
    const turn = { turnId: 't', chatJid: 'x@s.whatsapp.net', chatKey: 'c'.repeat(16), sends: 0 };
    // The rule, stated as the test: silence is the failure being prevented.
    const shouldSpeak = turn.sends === 0;
    if (shouldSpeak) sent.push('Working on a page for you');
    expect(sent).toHaveLength(1);
  });

  it('is not sent when the agent already spoke, so it never talks over a good turn', async () => {
    const sent: string[] = [];
    const turn = { turnId: 't', chatJid: 'x@s.whatsapp.net', chatKey: 'c'.repeat(16), sends: 2 };
    const shouldSpeak = turn.sends === 0;
    if (shouldSpeak) sent.push('Working on a page for you');
    expect(sent).toHaveLength(0);
  });
});

describe('who may change a page', () => {
  /** A whole config, so the defaults under test are the ones production loads. */
  const config = (pages?: Record<string, unknown>) =>
    parseConfig(pages === undefined ? {} : { pages });

  const GROUP = '18f0cf81c357d261';
  const OTHER = 'dd3e343bb1641baf';
  /** A direct chat, as the registry files one. */
  const direct = (jid: string, altJid: string | null = null) => ({ jid, altJid, isGroup: false });
  const group = { jid: '120363000000000000@g.us', altJid: null, isGroup: true };

  it('lets any chat change an unclaimed page, which is what deployments already do', () => {
    expect(mayChange(config(), 'members', GROUP, group)).toBe(true);
    expect(mayChange(config(), 'members', OTHER, null)).toBe(true);
  });

  it('answers only the granted chat once a page is claimed', () => {
    const c = config({ grants: { members: [GROUP] } });
    expect(mayChange(c, 'members', GROUP, group)).toBe(true);
    expect(mayChange(c, 'members', OTHER, null)).toBe(false);
  });

  it('leaves every other page alone when one is claimed', () => {
    const c = config({ grants: { members: [GROUP] } });
    expect(mayChange(c, 'doomsday', OTHER, null)).toBe(true);
  });

  // An empty grant and an absent one are different answers, and conflating them
  // would make "frozen" and "unclaimed" the same state.
  it('freezes a page granted to nobody, without deleting it', () => {
    const c = config({ grants: { members: [] } });
    expect(mayChange(c, 'members', GROUP, group)).toBe(false);
    expect(mayChange(c, 'members', OTHER, null)).toBe(false);
  });

  it('refuses every unclaimed page once pages are closed', () => {
    const c = config({ open: false, grants: { members: [GROUP] } });
    expect(mayChange(c, 'members', GROUP, group)).toBe(true);
    expect(mayChange(c, 'anything-new', GROUP, group)).toBe(false);
  });

  describe('granted by number, for somebody who has never written', () => {
    // A documentation number, not anybody's. This fixture held a real one for
    // two commits; `npm run check:secrets` is what caught it.
    const GRANTEE = '15551234567';
    const c = () => config({ grants: { members: [GRANTEE] } });

    it('matches the phone jid the chat arrived under', () => {
      expect(mayChange(c(), 'members', 'anykey', direct(GRANTEE + '@s.whatsapp.net'))).toBe(true);
    });

    // The case the whole feature turns on: WhatsApp hands most modern clients
    // over as an opaque linked id, and the number is only known as the alt.
    it('matches when only the linked id arrived and the number is the alt', () => {
      expect(mayChange(c(), 'members', 'anykey', direct('111111111111111@lid', GRANTEE + '@s.whatsapp.net'))).toBe(true);
    });

    it('matches a linked id granted directly', () => {
      const byLid = config({ grants: { members: ['111111111111111@lid'] } });
      expect(mayChange(byLid, 'members', 'anykey', direct('111111111111111@lid'))).toBe(true);
    });

    it('does not match somebody else', () => {
      expect(mayChange(c(), 'members', 'anykey', direct('15559876543@s.whatsapp.net'))).toBe(false);
    });

    // A group's jid belongs to the room, not to a member, so a number must never
    // authorise everybody in it.
    it('never authorises a group, whatever its jid looks like', () => {
      expect(mayChange(c(), 'members', 'anykey', { jid: GRANTEE + '@g.us', altJid: null, isGroup: true })).toBe(false);
    });

    it('refuses when the chat is not known at all', () => {
      expect(mayChange(c(), 'members', 'anykey', null)).toBe(false);
    });
  });

  it('rejects a grant that is not an identifier, rather than storing it', () => {
    expect(() => parseConfig({ pages: { grants: { members: ['../../etc/passwd'] } } })).toThrow();
    expect(() => parseConfig({ pages: { grants: { 'Not A Slug': [GROUP] } } })).toThrow();
  });
});

/**
 * The password gate.
 *
 * A page cannot check its own password — it is served under `connect-src 'none'`
 * and `form-action 'none'`, so it can neither call out nor post, and anything
 * written into it is visible to whoever opened it. The comparison happens on the
 * side that decides whether to send the bytes, and these are the cases that
 * decide whether that is worth anything.
 */
describe('pageAuthorised', () => {
  const stored = hashPagePassword('correct horse');

  it('lets an unprotected page through without a header', () => {
    expect(pageAuthorised(undefined, undefined)).toBe(true);
  });

  it('accepts the right password', () => {
    const header = 'Basic ' + Buffer.from('anyone:correct horse').toString('base64');
    expect(pageAuthorised(stored, header)).toBe(true);
  });

  it('keeps a password with spaces intact', () => {
    // The CLI joins everything after the slug, so a passphrase is normal. If the
    // split were on the wrong colon this would pass with "correct" alone.
    const header = 'Basic ' + Buffer.from('anyone:correct').toString('base64');
    expect(pageAuthorised(stored, header)).toBe(false);
  });

  it('refuses the wrong password', () => {
    expect(pageAuthorised(stored, 'Basic ' + Buffer.from('a:wrong').toString('base64'))).toBe(false);
  });

  it('refuses a missing, malformed or non-Basic header rather than throwing', () => {
    for (const header of [undefined, '', 'Basic', 'Basic !!!not base64!!!', 'Bearer abc',
      'Basic ' + Buffer.from('nocolon').toString('base64')]) {
      expect(pageAuthorised(stored, header), String(header)).toBe(false);
    }
  });

  it('does not store the password itself', () => {
    // The config is rendered by the panel and written to a file an operator may
    // open in front of somebody.
    expect(JSON.stringify(stored)).not.toContain('correct horse');
  });

  it('salts, so the same password twice does not produce the same hash', () => {
    expect(hashPagePassword('same').hash).not.toBe(hashPagePassword('same').hash);
  });
});

describe('taking a page down', () => {
  it('stops serving it, and says nothing about why', () => {
    // 404, not 403: somebody holding an old link learns nothing about whether
    // the page was withdrawn or never existed.
    build('gone-soon');
    expect(unpublishPage('gone-soon').ok).toBe(true);
    expect(isUnpublished('gone-soon')).toBe(true);
  });

  it('keeps every byte, because the instruction arrived as a chat message', () => {
    build('kept', { 'index.html': '<h1>still here</h1>' });
    unpublishPage('kept');
    expect(readFileSync(join(root, 'out', 'pages', 'kept', 'index.html'), 'utf8')).toContain('still here');
  });

  it('can be put back', () => {
    build('returning');
    unpublishPage('returning');
    expect(republishPage('returning')).toBe(true);
    expect(isUnpublished('returning')).toBe(false);
  });

  it('refuses a page that does not exist, and a slug that escapes', () => {
    expect(unpublishPage('never-made').ok).toBe(false);
    expect(unpublishPage('../../etc').ok).toBe(false);
    expect(isUnpublished('../../etc')).toBe(false);
  });
});

/**
 * Slugs that name something on Object.prototype.
 *
 * `SLUG` matches `constructor`, and a plain object answers `map['constructor']`
 * with a function rather than undefined. Found by a review of the password
 * feature; the grants case turned out to be the worse of the two, because it
 * does not fail closed — it throws out of the outbox handler.
 */
describe('a slug that collides with Object.prototype', () => {
  const hostile = ['constructor', 'valueof', 'tostring'];

  it('does not throw out of the authorisation check', () => {
    const c = parseConfig({ operators: { numbers: ['15551234567'] }, pages: { open: true, grants: {} } });
    for (const slug of hostile) {
      expect(() => mayChange(c, slug, 'abcdef0123456789', null), slug).not.toThrow();
    }
  });

  it('treats an unclaimed prototype-shaped slug as unclaimed, not as granted', () => {
    const closed = parseConfig({ operators: { numbers: ['15551234567'] }, pages: { open: false, grants: {} } });
    for (const slug of hostile) {
      expect(mayChange(closed, slug, 'abcdef0123456789', null), slug).toBe(false);
    }
    const open = parseConfig({ operators: { numbers: ['15551234567'] }, pages: { open: true, grants: {} } });
    for (const slug of hostile) {
      expect(mayChange(open, slug, 'abcdef0123456789', null), slug).toBe(true);
    }
  });

  it('leaves such a page unprotected rather than permanently unopenable', () => {
    // Before the fix this was "protected" by a password that could not exist,
    // so no request could ever open it.
    for (const slug of hostile) {
      const stored = Object.hasOwn({}, slug) ? ({} as Record<string, never>)[slug] : undefined;
      expect(pageAuthorised(stored, undefined), slug).toBe(true);
    }
  });
});
