/**
 * The Teams endpoint end to end, over loopback: a real listener on a random
 * port, a real HTTP request, and a stubbed Microsoft on the other side of
 * `fetch`. Nothing leaves the machine.
 *
 * The property that matters most is the order of two things: the `200` goes
 * back *before* the message is handed to the dispatcher. Microsoft redelivers
 * on a timeout, and a redelivered message is a message answered twice — so the
 * test makes the handler hang and checks the response still arrives.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-teams-listener-'));
process.env['TULIP_STATE_DIR'] = root;

const { Teams } = await import('../src/teams/teams.js');
const { ISSUER, OPENID_METADATA } = await import('../src/teams/auth.js');
type TeamsInstance = InstanceType<typeof Teams>;

const APP_ID = '11111111-2222-3333-4444-555555555555';
const BOT = `28:${APP_ID}`;
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const KEYS_URL = 'https://login.botframework.com/v1/.well-known/keys';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ typ: 'JWT', alg: 'RS256', kid: 'k1' });
  const payload = b64({ iss: ISSUER, aud: APP_ID, nbf: now - 60, exp: now + 600, serviceurl: SERVICE, ...overrides });
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/** Microsoft, as far as this test is concerned. */
const outbound: Array<{ url: string; body: unknown }> = [];
const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === OPENID_METADATA) return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: KEYS_URL }), { status: 200 });
  if (url === KEYS_URL) {
    return new Response(JSON.stringify({ keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1', use: 'sig' }] }), { status: 200 });
  }
  if (url.startsWith('https://login.microsoftonline.com/')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  }
  outbound.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
  return new Response('{"id":"sent-1"}', { status: 200 });
}) as unknown as typeof fetch;

let teams: TeamsInstance;
let base = '';
const started: TeamsInstance[] = [];

async function listener(): Promise<{ teams: TeamsInstance; base: string }> {
  const instance = new Teams(
    { appId: APP_ID, appSecret: 's', tenantId: null, bind: '127.0.0.1', port: 0 },
    { fetcher, referencesFile: join(mkdtempSync(join(tmpdir(), 'tulip-teams-refs-')), 'refs.json') },
  );
  await instance.start();
  started.push(instance);
  const port = instance.address()?.port;
  if (port === undefined) throw new Error('did not listen');
  return { teams: instance, base: `http://127.0.0.1:${String(port)}` };
}

beforeAll(async () => {
  ({ teams, base } = await listener());
});
afterEach(() => {
  outbound.length = 0;
  teams.removeAllListeners('message');
});
process.on('exit', () => {
  for (const t of started) t.stop();
  rmSync(root, { recursive: true, force: true });
});

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id: `m-${String(Math.random()).slice(2)}`,
    timestamp: new Date().toISOString(),
    serviceUrl: SERVICE,
    channelId: 'msteams',
    from: { id: '29:1abc', name: 'Ada', aadObjectId: 'eddfa9d4-346e-4cce-a18f-fa6261ad776b' },
    recipient: { id: BOT, name: 'Tulip' },
    conversation: { id: 'a:1personal', conversationType: 'personal', tenantId: 't-1' },
    text: 'hello',
    ...overrides,
  };
}

async function post(body: unknown, authorization: string | null = `Bearer ${token()}`): Promise<Response> {
  return fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const nextMessage = (): Promise<unknown> => new Promise((resolve) => teams.once('message', resolve));

describe('the route', () => {
  it('answers nothing but POST /api/messages', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/messages`)).status).toBe(405);
    expect((await fetch(`${base}/healthz`)).status).toBe(404);
  });

  it('is connected once listening, and knows who it is', () => {
    expect(teams.connected).toBe(true);
    expect(teams.kind).toBe('teams');
    expect(teams.me.id).toBe(BOT);
    expect(teams.directChatId()).toBeNull();
  });
});

describe('what it refuses', () => {
  it('a missing or bad token, with 401 and no body, and hands nothing on', async () => {
    let delivered = 0;
    teams.on('message', () => { delivered += 1; });
    const none = await post(activity(), null);
    expect(none.status).toBe(401);
    expect(await none.text()).toBe('');
    const wrongAud = await post(activity(), `Bearer ${token({ aud: '99999999-2222-3333-4444-555555555555' })}`);
    expect(wrongAud.status).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toBe(0);
  });

  it('a body whose service url the token did not vouch for', async () => {
    let delivered = 0;
    teams.on('message', () => { delivered += 1; });
    const other = await post(activity({ serviceUrl: 'https://smba.trafficmanager.net/amer/' }));
    expect(other.status).toBe(401);
    const hostile = await post(activity({ serviceUrl: 'http://10.0.0.1/' }), `Bearer ${token({ serviceurl: 'http://10.0.0.1/' })}`);
    expect(hostile.status).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toBe(0);
  });

  it('a body that is not JSON, or not an activity', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ type: 'message' })).status).toBe(400);
  });
});

describe('what it accepts', () => {
  it('answers 200 before the dispatcher has done anything, even if it never finishes', async () => {
    let sawIt = false;
    teams.on('message', () => {
      sawIt = true;
      return new Promise(() => {}); // a turn that never ends
    });
    const response = await post(activity());
    expect(response.status).toBe(200);
    // The handler runs on the tick after the response was written. By the time
    // the client has the response it has run — but the response did not wait.
    await new Promise((r) => setTimeout(r, 20));
    expect(sawIt).toBe(true);
  });

  it('hands over an Inbound keyed on the conversation, which parses to an envelope', async () => {
    const pending = nextMessage();
    await post(activity({ text: '<at>Tulip</at> ping', entities: [{ type: 'mention', text: '<at>Tulip</at>', mentioned: { id: BOT } }] }));
    const inbound = (await pending) as { chatId: string; isGroup: boolean; altChatId: string | null; parse: (ctx: unknown) => Promise<{ text: string; mentionsMe: boolean; chatJid: string } | null> };
    expect(inbound.chatId).toBe('a:1personal');
    expect(inbound.isGroup).toBe(false);
    expect(inbound.altChatId).toBeNull();
    const envelope = await inbound.parse({ chatKey: '0123456789abcdef', mediaRoot: join(root, 'media'), maxMediaBytes: 10, maxMediaPerMessage: 1, maxInboundChars: 100 });
    expect(envelope).toMatchObject({ text: 'ping', mentionsMe: true, chatJid: 'a:1personal' });
  });

  it('keys a channel post on its thread', async () => {
    const pending = nextMessage();
    const thread = '19:abc@thread.tacv2;messageid=1111111111111';
    await post(activity({ conversation: { id: thread, conversationType: 'channel' } }));
    expect(((await pending) as { chatId: string; isGroup: boolean }).chatId).toBe(thread);
  });

  it('drops a redelivery of the same activity id', async () => {
    let delivered = 0;
    teams.on('message', () => { delivered += 1; });
    const same = activity({ id: 'm-dup' });
    await post(same);
    await post(same);
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toBe(1);
  });

  it('acknowledges an invoke with an empty object and delivers nothing', async () => {
    let delivered = 0;
    teams.on('message', () => { delivered += 1; });
    const response = await post(activity({ type: 'invoke', name: 'whatever' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{}');
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toBe(0);
  });

  it('remembers where the bot was added without delivering a message, and can then write there', async () => {
    let delivered = 0;
    teams.on('message', () => { delivered += 1; });
    await post(activity({ type: 'conversationUpdate', text: undefined, membersAdded: [{ id: BOT }], conversation: { id: '19:newroom@thread.v2', conversationType: 'groupChat' } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(delivered).toBe(0);
    expect(await teams.sendText('19:newroom@thread.v2', 'hello room')).toBe('sent-1');
    expect(outbound[0]?.url).toBe(`${SERVICE}v3/conversations/${encodeURIComponent('19:newroom@thread.v2')}/activities`);
    expect(outbound[0]?.body).toMatchObject({ type: 'message', text: 'hello room', from: { id: BOT } });
  });

  it('refuses to send into a conversation nobody has written from', async () => {
    await expect(teams.sendText('a:never-seen', 'x')).rejects.toThrow(/no conversation reference/);
    expect(outbound).toEqual([]);
  });
});

describe('the sends', () => {
  beforeAll(async () => {
    const pending = nextMessage();
    await post(activity({ conversation: { id: 'a:sendy', conversationType: 'personal' } }));
    await pending;
  });

  it('typing is an activity when on and nothing when off', async () => {
    await teams.typing('a:sendy', true);
    await teams.typing('a:sendy', false);
    expect(outbound.map((o) => (o.body as { type: string }).type)).toEqual(['typing']);
  });

  it('a read receipt is a no-op', async () => {
    await teams.readReceipt('a:sendy', 'm-1');
    expect(outbound).toEqual([]);
  });

  it('an image goes inline, and an oversized one degrades to words', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    await teams.sendImage('a:sendy', png, 'look');
    expect(outbound[0]?.body).toMatchObject({ text: 'look', attachments: [{ contentType: 'image/png', contentUrl: `data:image/png;base64,${png.toString('base64')}` }] });
    await teams.sendImage('a:sendy', Buffer.alloc(5 * 1024 * 1024), 'big');
    const degraded = outbound[1]?.body as { text: string; attachments?: unknown };
    expect(degraded.attachments).toBeUndefined();
    expect(degraded.text).toMatch(/^big\n\n\(I made a picture, but it is too large/);
  });

  it('edit and unsend address the activity', async () => {
    await teams.editText('a:sendy', 'sent-1', 'better');
    await teams.unsend('a:sendy', 'sent-1');
    expect(outbound.map((o) => o.url.slice(o.url.lastIndexOf('/activities')))).toEqual(['/activities/sent-1', '/activities/sent-1']);
  });

  it('has no voice, reactions, files, or group controls to offer', () => {
    const t = teams as unknown as Record<string, unknown>;
    for (const absent of ['sendVoice', 'react', 'sendFile', 'groupMembership', 'isInGroup', 'leaveGroup']) {
      expect(t[absent]).toBeUndefined();
    }
  });
});
