/**
 * The Teams activity parser, which is a trust boundary and must be total.
 *
 * Everything here is what a person in a tenant — or anyone holding a valid
 * connector token — can put on the wire. The properties worth pinning are the
 * ones that decide something: which chat a message lands in, who is held to
 * have sent it, whether we were addressed, and which URLs the bridge will ever
 * fetch from.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  botWasAdded,
  isRoom,
  parseActivity,
  roomName,
  stripMentions,
  tenantOf,
  toEnvelope,
  validServiceUrl,
  type Activity,
} from '../src/teams/activity.js';

const BOT = '28:11111111-2222-3333-4444-555555555555';
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const ROOT_POST = '1111111111111';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<{ maxMediaBytes: number; maxMediaPerMessage: number; maxInboundChars: number }> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tulip-teams-act-'));
  roots.push(root);
  return {
    chatKey: 'abcdefabcdef0123',
    mediaRoot: join(root, 'media'),
    maxMediaBytes: 1024,
    maxMediaPerMessage: 4,
    maxInboundChars: 4000,
    ...overrides,
  };
}

function message(overrides: Record<string, unknown> = {}): Activity {
  const raw = {
    type: 'message',
    id: 'm-1',
    timestamp: '2026-09-15T10:00:00.000Z',
    serviceUrl: SERVICE,
    channelId: 'msteams',
    from: { id: '29:1abc', name: 'Ada', aadObjectId: 'eddfa9d4-346e-4cce-a18f-fa6261ad776b' },
    recipient: { id: BOT, name: 'Tulip' },
    conversation: { id: 'a:1personal', conversationType: 'personal', tenantId: 't-1' },
    text: 'hello there',
    ...overrides,
  };
  const parsed = parseActivity(raw);
  if (parsed === null) throw new Error('fixture did not parse');
  return parsed;
}

const noFetch = async () => ({ ok: false as const, error: 'the test did not expect a fetch' });

describe('parseActivity is total', () => {
  it('refuses what is not an activity, without throwing', () => {
    expect(parseActivity(null)).toBeNull();
    expect(parseActivity('text')).toBeNull();
    expect(parseActivity({})).toBeNull();
    expect(parseActivity({ type: 'message' })).toBeNull(); // no serviceUrl, no conversation
    expect(parseActivity({ type: 'message', serviceUrl: SERVICE })).toBeNull();
    expect(parseActivity({ type: 'message', serviceUrl: SERVICE, conversation: {} })).toBeNull();
  });

  it('accepts the minimum and drops what it does not read', () => {
    const parsed = parseActivity({ type: 'typing', serviceUrl: SERVICE, conversation: { id: 'c' }, somethingNew: 1 });
    expect(parsed).not.toBeNull();
    expect((parsed as unknown as Record<string, unknown>)['somethingNew']).toBeUndefined();
  });

  it('caps every field it iterates over', () => {
    const attachments = Array.from({ length: 33 }, () => ({ contentType: 'image/png', contentUrl: 'https://x/y' }));
    expect(parseActivity({ type: 'message', serviceUrl: SERVICE, conversation: { id: 'c' }, attachments })).toBeNull();
  });
});

describe('validServiceUrl', () => {
  it('accepts https and normalises the trailing slash', () => {
    expect(validServiceUrl('https://smba.trafficmanager.net/emea/')).toBe('https://smba.trafficmanager.net/emea/');
    expect(validServiceUrl('https://smba.trafficmanager.net/emea')).toBe('https://smba.trafficmanager.net/emea/');
  });

  it.each([
    ['http://smba.trafficmanager.net/emea/', 'plain http'],
    ['ftp://smba.trafficmanager.net/', 'another scheme'],
    ['https://user:pw@smba.trafficmanager.net/emea/', 'userinfo'],
    ['https://smba.trafficmanager.net/emea/?x=1', 'a query'],
    ['https://smba.trafficmanager.net/emea/#frag', 'a fragment'],
    ['https://10.0.0.5/emea/', 'a bare IP'],
    ['https://[::1]/emea/', 'an IPv6 literal'],
    ['https://localhost/emea/', 'localhost'],
    ['not a url', 'garbage'],
    ['', 'empty'],
  ])('refuses %s (%s)', (url) => {
    expect(validServiceUrl(url)).toBeNull();
  });
});

describe('what a chat is', () => {
  it('keys a personal chat and a group chat on the conversation id', () => {
    expect(isRoom(message())).toBe(false);
    expect(isRoom(message({ conversation: { id: '19:group@thread.v2', conversationType: 'groupChat' } }))).toBe(true);
  });

  it('keys a channel post on its thread — the id with ;messageid= kept whole', async () => {
    const thread = `19:abc@thread.tacv2;messageid=${ROOT_POST}`;
    const envelope = await toEnvelope(
      message({
        conversation: { id: thread, conversationType: 'channel' },
        channelData: { team: { id: '19:t@thread.tacv2', name: 'Ops' }, channel: { id: '19:abc@thread.tacv2', name: 'general' }, tenant: { id: 't-9' } },
      }),
      ctx(),
      { botId: BOT, fetchAttachment: noFetch },
    );
    expect(envelope.chatJid).toBe(thread);
    expect(envelope.isGroup).toBe(true);
    expect(envelope.groupName).toBe('Ops › general');
  });

  it('falls back to isGroup when the type is missing', () => {
    expect(isRoom(message({ conversation: { id: 'c', isGroup: true } }))).toBe(true);
    expect(isRoom(message({ conversation: { id: 'c' } }))).toBe(false);
  });

  it('reads the tenant from either place Teams puts it', () => {
    expect(tenantOf(message())).toBe('t-1');
    expect(tenantOf(message({ conversation: { id: 'c' }, channelData: { tenant: { id: 't-2' } } }))).toBe('t-2');
    expect(tenantOf(message({ conversation: { id: 'c' } }))).toBeNull();
  });

  it('names a room from whatever is known', () => {
    expect(roomName(message({ conversation: { id: 'c', name: 'Lunch' } }))).toBe('Lunch');
    expect(roomName(message({ conversation: { id: 'c' }, channelData: { channel: { name: 'random' } } }))).toBe('random');
    expect(roomName(message({ conversation: { id: 'c' } }))).toBeNull();
  });
});

describe('who spoke', () => {
  it('carries the object id first and the opaque id beside it, and never a phone number', async () => {
    const envelope = await toEnvelope(message(), ctx(), { botId: BOT, fetchAttachment: noFetch });
    expect(envelope.senderIds).toEqual(['eddfa9d4-346e-4cce-a18f-fa6261ad776b', '29:1abc']);
    expect(envelope.senderPn).toBeNull();
    expect(envelope.pushName).toBe('Ada');
  });

  it('copes with a sender that has no object id, or no sender at all', async () => {
    const one = await toEnvelope(message({ from: { id: '29:1abc' } }), ctx(), { botId: BOT, fetchAttachment: noFetch });
    expect(one.senderIds).toEqual(['29:1abc']);
    const none = await toEnvelope(message({ from: undefined }), ctx(), { botId: BOT, fetchAttachment: noFetch });
    expect(none.senderIds).toEqual([]);
    expect(none.pushName).toBeNull();
  });
});

describe('mentions', () => {
  it('is decided by the entity, and our own tag is stripped from the text', () => {
    const out = stripMentions('<at>Tulip</at> what time is it?', [
      { type: 'mention', text: '<at>Tulip</at>', mentioned: { id: BOT, name: 'Tulip' } },
    ], BOT);
    expect(out).toEqual({ text: 'what time is it?', mentionsMe: true });
  });

  it('is not decided by the text: a typed <at> is words, not a mention', () => {
    const out = stripMentions('<at>Tulip</at> are you there', [], BOT);
    expect(out.mentionsMe).toBe(false);
    expect(out.text).toBe('@Tulip are you there');
  });

  it("keeps somebody else's mention as @Name and does not count it as ours", () => {
    const out = stripMentions('<at>Ada</at> can you ask <at>Tulip</at>?', [
      { type: 'mention', text: '<at>Ada</at>', mentioned: { id: '29:1abc', name: 'Ada' } },
      { type: 'mention', text: '<at>Tulip</at>', mentioned: { id: BOT.toUpperCase(), name: 'Tulip' } },
    ], BOT);
    expect(out).toEqual({ text: '@Ada can you ask ?', mentionsMe: true });
  });

  it('ignores malformed entities rather than throwing', () => {
    const out = stripMentions('hi', [null, 42, { type: 'mention' }, { type: 'clientInfo', locale: 'en' }], BOT);
    expect(out).toEqual({ text: 'hi', mentionsMe: false });
  });

  it('flows through to the envelope', async () => {
    const envelope = await toEnvelope(
      message({
        conversation: { id: '19:g@thread.v2', conversationType: 'groupChat' },
        text: '<at>Tulip</at> ping',
        entities: [{ type: 'mention', text: '<at>Tulip</at>', mentioned: { id: BOT } }],
      }),
      ctx(),
      { botId: BOT, fetchAttachment: noFetch },
    );
    expect(envelope.mentionsMe).toBe(true);
    expect(envelope.text).toBe('ping');
  });
});

describe('other activity types', () => {
  it('records a reaction as one, so the gate refuses it rather than the parser dropping it', async () => {
    const envelope = await toEnvelope(
      message({ type: 'messageReaction', text: undefined, reactionsAdded: [{ type: 'like' }], replyToId: '1' }),
      ctx(),
      { botId: BOT, fetchAttachment: noFetch },
    );
    expect(envelope.isReaction).toBe(true);
    expect(envelope.text).toBe('[reaction] like');
  });

  it('knows when the bot itself was added', () => {
    const added = message({ type: 'conversationUpdate', text: undefined, membersAdded: [{ id: BOT }, { id: '29:1abc' }] });
    expect(botWasAdded(added, BOT)).toBe(true);
    expect(botWasAdded(message({ type: 'conversationUpdate', text: undefined, membersAdded: [{ id: '29:1abc' }] }), BOT)).toBe(false);
  });

  it('truncates rather than refuses a long message', async () => {
    const envelope = await toEnvelope(message({ text: 'x'.repeat(50) }), ctx({ maxInboundChars: 10 }), { botId: BOT, fetchAttachment: noFetch });
    expect(envelope.text).toBe(`${'x'.repeat(10)}\n[truncated]`);
  });
});

describe('attachments', () => {
  it('fetches an inline image from the service host, with auth, and files it under the chat', async () => {
    const calls: Array<{ url: string; withAuth: boolean }> = [];
    const c = ctx();
    const envelope = await toEnvelope(
      message({ attachments: [{ contentType: 'image/png', contentUrl: `${SERVICE}v3/attachments/abc/views/original`, name: 'shot.png' }] }),
      c,
      {
        botId: BOT,
        fetchAttachment: async (url, withAuth) => {
          calls.push({ url: url.toString(), withAuth });
          return { ok: true, data: Buffer.from('png-bytes') };
        },
      },
    );
    expect(calls).toEqual([{ url: `${SERVICE}v3/attachments/abc/views/original`, withAuth: true }]);
    expect(envelope.media).toHaveLength(1);
    const media = envelope.media[0]!;
    expect(media.kind).toBe('image');
    expect(media.error).toBeNull();
    expect(media.fileName).toBe('shot.png');
    expect(media.path).toMatch(/^media\/abcdefabcdef0123\/\d+-m1\.jpg$/);
    expect(readFileSync(join(c.mediaRoot, '..', media.path!)).toString()).toBe('png-bytes');
  });

  it('refuses an image on any other host without fetching, and records why', async () => {
    let fetched = 0;
    const envelope = await toEnvelope(
      message({ attachments: [{ contentType: 'image/png', contentUrl: 'https://evil.example/x.png' }] }),
      ctx(),
      { botId: BOT, fetchAttachment: async () => { fetched += 1; return { ok: true, data: Buffer.from('x') }; } },
    );
    expect(fetched).toBe(0);
    expect(envelope.media[0]).toMatchObject({ kind: 'image', path: null, error: 'image link is not on the service host' });
  });

  it('fetches a file card only from SharePoint, and never with our token', async () => {
    const calls: Array<{ host: string; withAuth: boolean }> = [];
    const fetchAttachment = async (url: URL, withAuth: boolean) => {
      calls.push({ host: url.hostname, withAuth });
      return { ok: true as const, data: Buffer.from('%PDF') };
    };
    const good = await toEnvelope(
      message({
        attachments: [{
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          name: 'report.pdf',
          content: { downloadUrl: 'https://contoso-my.sharepoint.com/personal/x/_layouts/download.aspx?id=1', fileType: 'pdf' },
        }],
      }),
      ctx(),
      { botId: BOT, fetchAttachment },
    );
    expect(calls).toEqual([{ host: 'contoso-my.sharepoint.com', withAuth: false }]);
    expect(good.media[0]).toMatchObject({ kind: 'document', fileName: 'report.pdf', error: null });

    const bad = await toEnvelope(
      message({
        attachments: [{
          contentType: 'application/vnd.microsoft.teams.file.download.info',
          content: { downloadUrl: 'https://sharepoint.com.evil.example/x', fileType: 'png' },
        }],
      }),
      ctx(),
      { botId: BOT, fetchAttachment },
    );
    expect(calls).toHaveLength(1);
    expect(bad.media[0]).toMatchObject({ kind: 'image', path: null, error: "download link is not on the tenant's SharePoint" });
  });

  it('records a failed or oversized fetch rather than losing the message', async () => {
    const c = ctx({ maxMediaBytes: 4 });
    const envelope = await toEnvelope(
      message({ attachments: [{ contentType: 'image/jpeg', contentUrl: `${SERVICE}v3/attachments/x` }] }),
      c,
      { botId: BOT, fetchAttachment: async () => ({ ok: true, data: Buffer.from('too many bytes') }) },
    );
    expect(envelope.media[0]?.error).toMatch(/larger than the 4 byte limit/);
    expect(existsSync(join(c.mediaRoot, c.chatKey))).toBe(false);
  });

  it('leaves cards and html renderings alone, and stops at the per-message cap', async () => {
    let fetched = 0;
    const envelope = await toEnvelope(
      message({
        attachments: [
          { contentType: 'text/html', content: '<p>hello</p>' },
          { contentType: 'application/vnd.microsoft.card.adaptive', content: {} },
          { contentType: 'image/png', contentUrl: `${SERVICE}a` },
          { contentType: 'image/png', contentUrl: `${SERVICE}b` },
        ],
      }),
      ctx({ maxMediaPerMessage: 1 }),
      { botId: BOT, fetchAttachment: async () => { fetched += 1; return { ok: true, data: Buffer.from('x') }; } },
    );
    expect(fetched).toBe(1);
    expect(envelope.media).toHaveLength(1);
  });
});
