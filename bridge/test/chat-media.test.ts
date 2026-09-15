/**
 * A voice note in the conversation it arrived in.
 *
 * Inbound audio was downloaded, kept and transcribed for as long as the bridge
 * has existed, and the Chat page drew it as an empty bubble: the row recorded
 * `{ kind, bytes }` and nothing that named the file. These pin the three parts
 * of the repair — what a row records, what the transcript view carries, and
 * how the panel gets the bytes — and, more than any of those, what the new
 * route refuses.
 *
 * The route is the one that matters. It is a second way to read a file out of
 * the inbound media root, addressed by a row id rather than a name, and the
 * argument for it is that the browser never holds a path. That argument is
 * only as good as the resolver's refusals, so most of what follows is a list
 * of things that must come back as "not found": the wrong chat, an id from
 * before names were recorded, a row whose name climbs, no credential at all.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-chat-media-'));
process.env['TULIP_STATE_DIR'] = join(root, 'state');
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');
// Nowhere, so the session half of the transcript is empty rather than read
// from a real mount on the machine running the suite.
process.env['TULIP_WORKSPACE_MOUNT'] = join(root, 'workspace');

const { chatMediaPath, chatTranscript } = await import('../src/panel-api.js');
const { feedMedia } = await import('../src/dispatcher.js');
const { feed } = await import('../src/feed.js');
const { startPanel } = await import('../src/panel.js');
const { paths } = await import('../src/paths.js');
const { inPaths, transcriptFor } = await import('@2lp/shared');

const CHAT = '0123456789abcdef';
const OTHER = 'fedcba9876543210';
// Leading zeros on purpose: a real thirteen-digit stamp reads to
// `check:secrets` as a phone number, and the digits are opaque here anyway.
const NOTE = '0000000001-3AAA5388682B.ogg';
const AUDIO = Buffer.from('OggS-pretend-opus-frames');

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(join(root, 'in'), { recursive: true, force: true });
  rmSync(join(root, 'state', 'feed.jsonl'), { force: true });
});

function keep(chatKey: string, name = NOTE, words: string | null = null): string {
  const dir = inPaths.mediaFor(chatKey);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, AUDIO);
  if (words !== null) writeFileSync(transcriptFor(file), words);
  return file;
}

/** An inbound row as the dispatcher now writes one for a voice note. */
function voiceRow(chatKey: string, name: string | null = NOTE, extra: Record<string, unknown> = {}): string {
  return feed.inbound({
    chatKey,
    chatName: 'Les',
    isGroup: false,
    from: 'Les',
    text: '',
    media: [{ kind: 'audio', bytes: AUDIO.length, name, mime: 'audio/ogg; codecs=opus', seconds: 7, voice: true, ...extra }],
    accepted: true,
    reason: null,
  }).uid;
}

const deps = {
  chats: {
    get: (k: string) =>
      k === CHAT || k === OTHER
        ? { chatKey: k, name: 'Les', isGroup: false, blocked: false, messages: 1, firstSeenAt: 0, lastSeenAt: 0 }
        : null,
  },
  limiter: { stats: () => ({}) },
  config: {
    panel: { enabled: true, host: '127.0.0.1', port: 0 },
    privacy: { owner: null, chats: [] },
    pages: { passwords: {} },
    limits: { maxMediaBytes: 1024 },
  },
  wa: {},
  dispatcher: () => ({ lastMessageIn: () => null }),
} as never;

// ─── What a row records ──────────────────────────────────────────────────────

describe('feedMedia — what the feed keeps about an attachment', () => {
  const base = { fileName: null, transcript: null, error: null };

  it('records the stored name, the mime, the duration and whether it was spoken', () => {
    expect(
      feedMedia({
        ...base,
        kind: 'audio',
        path: `media/${CHAT}/${NOTE}`,
        mimetype: 'audio/ogg; codecs=opus',
        bytes: 42,
        seconds: 7,
        isVoiceNote: true,
      }),
    ).toEqual({ kind: 'audio', bytes: 42, name: NOTE, mime: 'audio/ogg; codecs=opus', seconds: 7, voice: true });
  });

  it('names the original picture, not the downscaled copy the agent is pointed at', () => {
    const row = feedMedia({
      ...base,
      kind: 'image',
      path: `media/${CHAT}/0000000002-3B99.jpg.view.jpg`,
      mimetype: 'image/jpeg',
      bytes: 9,
      seconds: null,
      isVoiceNote: false,
    });
    expect(row.name).toBe('0000000002-3B99.jpg');
    expect(row.voice).toBe(false);
  });

  it('records no name for a download that failed', () => {
    const row = feedMedia({
      ...base,
      kind: 'audio',
      path: null,
      mimetype: 'audio/ogg',
      bytes: null,
      seconds: 900,
      isVoiceNote: true,
      error: 'attachment is larger than the limit',
    });
    expect(row).toMatchObject({ kind: 'audio', name: null, seconds: 900 });
  });
});

// ─── What the Chat page is handed ────────────────────────────────────────────

describe('chatTranscript — a voice note as an item', () => {
  const items = (chatKey: string): Array<Record<string, unknown>> =>
    (chatTranscript(deps, chatKey, 50) as { items: Array<Record<string, unknown>> }).items;

  it('carries the row id, the label facts and the words from the sidecar', () => {
    keep(CHAT, NOTE, 'Hey, can you check the Gaudi photo?');
    const uid = voiceRow(CHAT);

    const [item] = items(CHAT);
    expect(item).toMatchObject({
      kind: 'said',
      direction: 'in',
      text: '',
      uid,
      media: [
        { kind: 'audio', bytes: AUDIO.length, seconds: 7, voice: true, transcript: 'Hey, can you check the Gaudi photo?', playable: true },
      ],
    });
  });

  it('gives a text-only message neither a handle nor an empty list', () => {
    feed.inbound({ chatKey: CHAT, chatName: 'Les', isGroup: false, from: 'Les', text: 'hello', media: [], accepted: true, reason: null });
    const [item] = items(CHAT);
    expect(item).toMatchObject({ text: 'hello' });
    expect(item).not.toHaveProperty('uid');
    expect(item).not.toHaveProperty('media');
  });

  it('still labels a note recorded before names were kept, and offers no player for it', () => {
    feed.inbound({
      chatKey: CHAT, chatName: 'Les', isGroup: false, from: 'Les', text: '',
      media: [{ kind: 'audio', bytes: 93535 }], accepted: true, reason: null,
    });
    const [item] = items(CHAT);
    expect(item).toMatchObject({ media: [{ kind: 'audio', bytes: 93535, seconds: null, voice: false, transcript: null, playable: false }] });
  });

  it('reports a note whose file was deleted as no longer playable, with no words', () => {
    const file = keep(CHAT, NOTE, 'gone soon');
    voiceRow(CHAT);
    unlinkSync(file);
    unlinkSync(transcriptFor(file));
    const [item] = items(CHAT);
    expect(item).toMatchObject({ media: [{ playable: false, transcript: null }] });
  });

  it('picks up words that arrive after the row was written', () => {
    const file = keep(CHAT);
    voiceRow(CHAT);
    expect(items(CHAT)[0]).toMatchObject({ media: [{ transcript: null }] });
    writeFileSync(transcriptFor(file), 'better late');
    expect(items(CHAT)[0]).toMatchObject({ media: [{ transcript: 'better late' }] });
  });
});

// ─── The resolver's refusals ─────────────────────────────────────────────────

describe('chatMediaPath — which file a row id names', () => {
  it('names the file the row recorded, inside that chat', () => {
    const file = keep(CHAT);
    const uid = voiceRow(CHAT);
    expect(chatMediaPath(CHAT, uid)).toBe(file);
  });

  it('refuses the same row asked for under another chat key', () => {
    keep(CHAT);
    const uid = voiceRow(CHAT);
    expect(chatMediaPath(OTHER, uid)).toBeNull();
  });

  it('refuses a chat key or row id that is not one', () => {
    keep(CHAT);
    const uid = voiceRow(CHAT);
    expect(chatMediaPath('../state', uid)).toBeNull();
    expect(chatMediaPath(CHAT, '../../salt')).toBeNull();
    expect(chatMediaPath(CHAT, uid.toUpperCase())).toBeNull();
    expect(chatMediaPath(CHAT, '')).toBeNull();
  });

  it('refuses an id nothing was recorded under', () => {
    keep(CHAT);
    voiceRow(CHAT);
    expect(chatMediaPath(CHAT, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeNull();
  });

  it('refuses a row from before names were recorded, and a download that failed', () => {
    const old = feed.inbound({
      chatKey: CHAT, chatName: 'Les', isGroup: false, from: 'Les', text: '',
      media: [{ kind: 'audio', bytes: 93535 }], accepted: true, reason: null,
    }).uid;
    const failed = voiceRow(CHAT, null);
    expect(chatMediaPath(CHAT, old)).toBeNull();
    expect(chatMediaPath(CHAT, failed)).toBeNull();
  });

  it('refuses a row whose recorded name climbs out of the media root', () => {
    // Nothing writes a row like this; the point is that if something ever
    // did, the name is still put through the same guard the Media page uses.
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.salt, 'the deployment salt');
    const climbing = voiceRow(CHAT, '../../../state/salt');
    const absolute = voiceRow(CHAT, paths.salt);
    expect(chatMediaPath(CHAT, climbing)).toBeNull();
    expect(chatMediaPath(CHAT, absolute)).toBeNull();
  });

  it('refuses an outbound row, which never names an inbound file', () => {
    keep(CHAT);
    const uid = feed.outbound(CHAT, 'voice', 'what he said').uid;
    expect(chatMediaPath(CHAT, uid)).toBeNull();
  });
});

// ─── The route, through the panel's own door ────────────────────────────────

describe('GET /api/chat/media', () => {
  let base = '';
  let token = '';
  let server: ReturnType<typeof startPanel> = null;

  beforeEach(async () => {
    server = startPanel(deps);
    if (server === null) throw new Error('the panel did not start');
    await new Promise<void>((ready) => server!.once('listening', () => ready()));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    token = readFileSync(paths.panelToken, 'utf8').trim();
  });
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
  });

  const get = (query: string, withToken = true): Promise<Response> =>
    fetch(`${base}/api/chat/media?${query}${withToken ? `&t=${token}` : ''}`);

  it('refuses without a credential, before looking anything up', async () => {
    keep(CHAT);
    const uid = voiceRow(CHAT);
    const res = await get(`key=${CHAT}&id=${uid}`, false);
    expect(res.status).toBe(401);
  });

  it('serves the recording as audio, privately cached', async () => {
    keep(CHAT);
    const uid = voiceRow(CHAT);
    const res = await get(`key=${CHAT}&id=${uid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/ogg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(Buffer.from(await res.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it('answers 404, not 400, to an id that names nothing', async () => {
    keep(CHAT);
    const uid = voiceRow(CHAT);
    expect((await get(`key=${OTHER}&id=${uid}`)).status).toBe(404);
    expect((await get(`key=${CHAT}&id=not-a-row`)).status).toBe(404);
    expect((await get(`key=${CHAT}`)).status).toBe(404);
  });

  it('answers 404 once the file behind a good id has been deleted', async () => {
    const file = keep(CHAT);
    const uid = voiceRow(CHAT);
    unlinkSync(file);
    expect(existsSync(file)).toBe(false);
    expect((await get(`key=${CHAT}&id=${uid}`)).status).toBe(404);
  });
});
