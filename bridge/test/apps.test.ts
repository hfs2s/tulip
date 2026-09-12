/**
 * The hfs2s apps page: reading the box's listing, and who may work on an app.
 *
 * The sample below is the box's real `status` output, trimmed. It is fixed
 * width text rather than JSON, so the parse is the part worth testing: a
 * changed column or a name with spaces in it must cost one row, never a
 * half-read one, and never a grant filed under the wrong id.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { parseConfig } from '../src/config.js';
import { forgetApps, listApps, mayUse, parseStatus } from '../src/apps.js';

const STATUS = [
  "32 workspaces. owner 'you' = the operator's account; 'client' = somebody else's.",
  '4fd619f7  (unnamed)                                 sleeping  client handed-over  hfs2s.app/app/4fd619f7/',
  '01cce381  (unnamed)                                 sleeping  client handed-over  hfs2s.app/app/01cce381/, protocol.hfs2s.app',
  '28c21d3c  OkayGets                                  ready     you  hfs2s.app/app/28c21d3c/, okaygets.hfs2s.app, okgets.ph',
  '0fec90c0  Juan More Chance LA                       sleeping  you  hfs2s.app/app/0fec90c0/, juaninlosangeles.hfs2s.app',
  '3f5c57a8  QSMI Philippines                          working   client handed-over  hfs2s.app/app/3f5c57a8/, qsmi.hfs2s.app',
].join('\n');

const config = (apps: Record<string, unknown>) =>
  parseConfig({ audience: { everyone: true }, apps });

const CHAT = { jid: '34600000042@s.whatsapp.net', altJid: null, isGroup: false };
const ROOM = { jid: '120363@g.us', altJid: null, isGroup: true };

describe('reading the box’s listing', () => {
  it('keeps the id, the state, whose it is and every address', () => {
    const apps = parseStatus(STATUS);
    expect(apps).toHaveLength(5);
    expect(apps[1]).toEqual({
      id: '01cce381',
      name: null,
      state: 'sleeping',
      mine: false,
      handedOver: true,
      addresses: ['hfs2s.app/app/01cce381/', 'protocol.hfs2s.app'],
    });
  });

  it('keeps a name that has spaces in it', () => {
    expect(parseStatus(STATUS)[3]).toMatchObject({ id: '0fec90c0', name: 'Juan More Chance LA', mine: true });
  });

  it('reads `(unnamed)` as no name rather than as a name', () => {
    expect(parseStatus(STATUS)[0]?.name).toBeNull();
  });

  it('tells the operator’s own from a client’s, and notices handed-over', () => {
    const apps = parseStatus(STATUS);
    expect(apps.find((a) => a.id === '28c21d3c')).toMatchObject({ mine: true, handedOver: false, state: 'ready' });
    expect(apps.find((a) => a.id === '3f5c57a8')).toMatchObject({ mine: false, handedOver: true, state: 'working' });
  });

  it('drops the header and anything else it cannot read, rather than half-reading it', () => {
    expect(parseStatus('32 workspaces. owner ...\nnonsense\n\nzzzz  nope  x  you  a').map((a) => a.id)).toEqual([]);
  });

  it('keeps the first of two rows sharing an id, so a grant is never ambiguous', () => {
    const twice = [
      'aaaaaaaa  First                                     ready     you  a.hfs2s.app',
      'aaaaaaaa  Second                                    ready     you  b.hfs2s.app',
    ].join('\n');
    expect(parseStatus(twice).map((a) => a.name)).toEqual(['First']);
  });
});

describe('who may work on an app', () => {
  it('never refuses an operator, whatever the grants say', () => {
    const c = config({ grants: { '28c21d3c': [] } });
    expect(mayUse(c, '28c21d3c', 'ffff0000ffff0000', CHAT, true)).toBe(true);
  });

  it('refuses an ungranted app to everybody else — the opposite of a page', () => {
    expect(mayUse(config({}), '28c21d3c', 'ffff0000ffff0000', CHAT, false)).toBe(false);
  });

  it('has no standing rule that could open the ungranted ones', () => {
    // The config is strict, so this is not a setting that quietly does nothing:
    // a deployment that tries to open its apps is told there is no such switch.
    expect(() => config({ open: true })).toThrow(/apps/);
  });

  it('allows exactly the chat that was granted it', () => {
    const c = config({ grants: { '28c21d3c': ['ffff0000ffff0000'] } });
    expect(mayUse(c, '28c21d3c', 'ffff0000ffff0000', CHAT, false)).toBe(true);
    expect(mayUse(c, '28c21d3c', 'aaaa1111aaaa1111', CHAT, false)).toBe(false);
    // A grant on one app is not a grant on another.
    expect(mayUse(c, '3f5c57a8', 'ffff0000ffff0000', CHAT, false)).toBe(false);
  });

  it('grants a number to the person, and never to a room they are in', () => {
    const c = config({ grants: { '28c21d3c': ['34600000042'] } });
    expect(mayUse(c, '28c21d3c', 'ffff0000ffff0000', CHAT, false)).toBe(true);
    expect(mayUse(c, '28c21d3c', 'ffff0000ffff0000', ROOM, false)).toBe(false);
  });

  it('answers the same for granted-to-nobody as for never granted', () => {
    const frozen = config({ grants: { '28c21d3c': [] } });
    expect(mayUse(frozen, '28c21d3c', 'ffff0000ffff0000', CHAT, false)).toBe(false);
    expect(mayUse(frozen, '3f5c57a8', 'ffff0000ffff0000', CHAT, false)).toBe(false);
  });
});

describe('asking the box', () => {
  beforeEach(() => { forgetApps(); });

  it('asks once and serves the rest from the cache', async () => {
    let calls = 0;
    const ask = async () => { calls += 1; return { ok: true as const, text: STATUS }; };
    const deps = { config: config({}), ask };
    expect((await listApps(deps)).apps).toHaveLength(5);
    expect((await listApps(deps)).apps).toHaveLength(5);
    expect(calls).toBe(1);
  });

  it('keeps the last good listing when the box stops answering, and says so', async () => {
    const deps = { config: config({}), ask: async () => ({ ok: true as const, text: STATUS }) };
    await listApps(deps, 1_000);
    const failed = await listApps(
      { config: config({}), ask: async () => ({ ok: false as const, error: 'the hfs2s box did not answer within 140s' }) },
      1_000_000,
    );
    expect(failed.apps).toHaveLength(5);
    expect(failed.error).toContain('did not answer');
  });
});
