/**
 * What goes over the wire to the Bot Connector, for each thing the transport
 * sends — and what never does: a request to a service URL that failed the
 * rule, or a token in an error message.
 */
import { describe, expect, it } from 'vitest';
import { TokenSource } from '../src/teams/auth.js';
import {
  Connector,
  MAX_INLINE_IMAGE_BYTES,
  imageActivity,
  imageMimetype,
  textActivity,
  toTeamsMarkdown,
  typingActivity,
} from '../src/teams/connector.js';
import type { ConversationReference } from '../src/teams/references.js';

const REF: ConversationReference = {
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  conversationId: '19:abc@thread.tacv2;messageid=1111111111111',
  tenantId: 't-1',
  botId: '28:app',
  lastActivityId: null,
  updatedAt: 0,
};

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that mints tokens and records connector calls. */
function wire(answer: (seen: Seen) => Response = () => new Response('{"id":"sent-1"}', { status: 200 })) {
  const seen: Seen[] = [];
  let logins = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/')) {
      logins += 1;
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const record: Seen = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(record);
    return answer(record);
  }) as unknown as typeof fetch;
  const tokens = new TokenSource({ appId: 'app', appSecret: 's', tenantId: null }, fetcher);
  return { connector: new Connector(tokens, fetcher), seen, logins: () => logins };
}

describe('markdown', () => {
  it("converts WhatsApp's bold and strike, leaves markdown alone", () => {
    expect(toTeamsMarkdown('*Tulip*')).toBe('**Tulip**');
    expect(toTeamsMarkdown('whatsapp *disconnected* now')).toBe('whatsapp **disconnected** now');
    expect(toTeamsMarkdown('**already bold**')).toBe('**already bold**');
    expect(toTeamsMarkdown('~gone~')).toBe('~~gone~~');
    expect(toTeamsMarkdown('_italic_ and `code`')).toBe('_italic_ and `code`');
    expect(toTeamsMarkdown('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('makes a single newline a paragraph break, and collapses runs', () => {
    expect(toTeamsMarkdown('one\ntwo')).toBe('one\n\ntwo');
    expect(toTeamsMarkdown('one\n\ntwo')).toBe('one\n\ntwo');
    expect(toTeamsMarkdown('one\n\n\n\ntwo')).toBe('one\n\ntwo');
  });
});

describe('the payload for each kind', () => {
  it('text is a markdown message', () => {
    expect(textActivity('*hi*\nthere')).toEqual({ type: 'message', textFormat: 'markdown', text: '**hi**\n\nthere' });
  });

  it('typing is a typing activity', () => {
    expect(typingActivity()).toEqual({ type: 'typing' });
  });

  it('an image is inlined as a data url, with the caption as text', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const activity = imageActivity(png, 'image/png', 'a *cat*');
    expect(activity.text).toBe('a **cat**');
    expect(activity.attachments).toEqual([{ contentType: 'image/png', contentUrl: `data:image/png;base64,${png.toString('base64')}`, name: 'image' }]);
    expect(imageActivity(png, 'image/png', null).text).toBeUndefined();
  });

  it('sniffs the mimetype from the bytes', () => {
    expect(imageMimetype(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(imageMimetype(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageMimetype(Buffer.from([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(imageMimetype(Buffer.from('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(MAX_INLINE_IMAGE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe('the calls', () => {
  it('sends with POST to the conversation, bearer token on, from and conversation filled in', async () => {
    const { connector, seen } = wire();
    expect(await connector.send(REF, textActivity('hello'))).toBe('sent-1');
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(REF.conversationId)}/activities`);
    expect(call.headers['authorization']).toBe('Bearer tok');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toEqual({
      type: 'message',
      textFormat: 'markdown',
      text: 'hello',
      from: { id: '28:app' },
      conversation: { id: REF.conversationId },
    });
  });

  it('edits with PUT and unsends with DELETE on the activity', async () => {
    const { connector, seen } = wire(() => new Response('{}', { status: 200 }));
    await connector.update(REF, 'act-9', textActivity('fixed'));
    await connector.remove(REF, 'act-9');
    expect(seen.map((s) => [s.method, s.url.slice(s.url.lastIndexOf('/activities'))])).toEqual([
      ['PUT', '/activities/act-9'],
      ['DELETE', '/activities/act-9'],
    ]);
    expect(seen[0]?.body).toMatchObject({ text: 'fixed', from: { id: '28:app' } });
    expect(seen[1]?.body).toBeUndefined();
  });

  it('mints the token once across calls', async () => {
    const { connector, logins } = wire();
    await connector.send(REF, textActivity('a'));
    await connector.send(REF, textActivity('b'));
    expect(logins()).toBe(1);
  });

  it('returns null rather than throwing when the service gives no id', async () => {
    const { connector } = wire(() => new Response('', { status: 201 }));
    expect(await connector.send(REF, textActivity('a'))).toBeNull();
  });

  it('refuses to dial a stored service url that fails the rule, without a request', async () => {
    const { connector, seen } = wire();
    await expect(connector.send({ ...REF, serviceUrl: 'http://internal/' }, textActivity('a'))).rejects.toThrow(/refusing to send/);
    await expect(connector.send({ ...REF, serviceUrl: 'https://smba.trafficmanager.net/emea' }, textActivity('a'))).rejects.toThrow(/refusing to send/);
    expect(seen).toEqual([]);
  });

  it('reports a refusal by status and a little of the body, never the token', async () => {
    const { connector } = wire(() => new Response('{"error":{"code":"MessageSizeTooBig"}}', { status: 413 }));
    await expect(connector.send(REF, textActivity('a'))).rejects.toThrow('Teams returned 413: {"error":{"code":"MessageSizeTooBig"}}');
  });
});

describe('fetching what a person attached', () => {
  it('sends the token only when asked to, refuses redirects, and caps the size', async () => {
    const { connector, seen } = wire((s) => {
      if (s.url.endsWith('/redirect')) return new Response('', { status: 302, headers: { location: 'https://elsewhere/' } });
      if (s.url.endsWith('/big')) return new Response('x'.repeat(50), { status: 200, headers: { 'content-length': '50' } });
      return new Response('bytes', { status: 200 });
    });
    const withAuth = await connector.fetchAttachment(new URL('https://smba.trafficmanager.net/emea/v3/attachments/a'), true, 100);
    expect(withAuth).toEqual({ ok: true, data: Buffer.from('bytes') });
    expect(seen[0]?.headers['authorization']).toBe('Bearer tok');

    const without = await connector.fetchAttachment(new URL('https://contoso.sharepoint.com/f'), false, 100);
    expect(without.ok).toBe(true);
    expect(seen[1]?.headers['authorization']).toBeUndefined();

    expect(await connector.fetchAttachment(new URL('https://contoso.sharepoint.com/redirect'), false, 100)).toMatchObject({ ok: false, error: 'attachment fetch returned 302' });
    expect(await connector.fetchAttachment(new URL('https://contoso.sharepoint.com/big'), false, 10)).toMatchObject({ ok: false, error: 'attachment is larger than the 10 byte limit' });
  });
});
