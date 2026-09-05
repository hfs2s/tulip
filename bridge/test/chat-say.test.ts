/**
 * The operator speaking as Juan.
 *
 * Two send paths leave this panel and they are not variations of each other.
 * `sendToChat` types at Claude Code's prompt: the agent reads it, decides what
 * to say, and the words that arrive are its own. `sayAsJuan` puts the
 * operator's words on WhatsApp directly — no agent, no session, no turn — and
 * the person receiving it cannot tell it from a message Juan wrote.
 *
 * That second one is the more consequential, and it is the one with no agent
 * standing between a typo and a stranger's phone. So the checks in front of it
 * are what this file is about: a real chat, not blocked, within the rate limit,
 * and attachments that belong to the conversation being written into.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const KEY = 'abcdef0123456789';
const OTHER = 'fedcba9876543210';
const JID = '15551234567@s.whatsapp.net';

const box = mkdtempSync(join(tmpdir(), 'tulip-say-'));
mkdirSync(join(box, 'in'), { recursive: true });
mkdirSync(join(box, 'out'), { recursive: true });
process.env['TULIP_IN_DIR'] = join(box, 'in');
process.env['TULIP_OUT_DIR'] = join(box, 'out');
process.env['TULIP_STATE_DIR'] = join(box, 'state');

const api = await import('../src/panel-api.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let sent: Array<{ how: string; jid: string; detail: string }> = [];
let admit: { ok: boolean; reason?: string } = { ok: true };

beforeEach(() => {
  sent = [];
  admit = { ok: true };
  rmSync(join(box, 'in', 'media'), { recursive: true, force: true });
});
afterAll(() => rmSync(box, { recursive: true, force: true }));

function deps(known: readonly string[] = [KEY, OTHER], blocked = false) {
  return {
    config: { limits: { maxMediaBytes: 16_777_216 } },
    chats: {
      get: (k: string) => (known.includes(k) ? { chatKey: k, name: 'Ana', blocked } : null),
      jidFor: (k: string) => (known.includes(k) ? JID : null),
    },
    limiter: { admitOutbound: () => admit },
    wa: {
      sendText: async (jid: string, text: string) => { sent.push({ how: 'text', jid, detail: text }); },
      sendImage: async (jid: string) => { sent.push({ how: 'image', jid, detail: '' }); },
      sendFile: async (jid: string, _b: Buffer, _m: string, name: string) => {
        sent.push({ how: 'file', jid, detail: name });
      },
    },
  } as unknown as Parameters<typeof api.sayAsJuan>[0];
}

describe('sending as Juan', () => {
  it('puts the words on the wire, with no session anywhere in sight', async () => {
    const out = await api.sayAsJuan(deps(), KEY, 'Running ten minutes late — sorry!');
    expect(out.ok).toBe(true);
    expect(sent).toEqual([{ how: 'text', jid: JID, detail: 'Running ten minutes late — sorry!' }]);
  });

  it('refuses a blocked chat', async () => {
    const out = await api.sayAsJuan(deps([KEY], true), KEY, 'hello');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('blocked');
    expect(sent).toEqual([]);
  });

  it('refuses an unknown chat, and one with no destination', async () => {
    expect((await api.sayAsJuan(deps(), '0000000000000000', 'hi')).ok).toBe(false);
    expect((await api.sayAsJuan(deps(), 'nothex', 'hi')).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('refuses an empty message, and one over the cap', async () => {
    expect((await api.sayAsJuan(deps(), KEY, '   ')).ok).toBe(false);
    expect((await api.sayAsJuan(deps(), KEY, 'x'.repeat(4001))).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('is charged against the chat it writes into', async () => {
    admit = { ok: false, reason: 'too many just now' };
    const out = await api.sayAsJuan(deps(), KEY, 'hello');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('too many just now');
    expect(sent).toEqual([]);
  });

  it('sends an attachment, and a message with only an attachment', async () => {
    const stored = api.attachToChat(deps(), KEY, 'image/png', PNG, 'shot.png');
    const out = await api.sayAsJuan(deps(), KEY, '', [stored.path!]);
    expect(out.ok).toBe(true);
    expect(sent).toEqual([{ how: 'image', jid: JID, detail: '' }]);
  });

  it('sends a document as a file rather than as a picture', async () => {
    const doc = api.attachToChat(deps(), KEY, 'application/pdf',
      Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32)]), 'receipt.pdf');
    await api.sayAsJuan(deps(), KEY, 'here', [doc.path!]);
    expect(sent[0]).toMatchObject({ how: 'file' });
    expect(sent[0]!.detail).toMatch(/\.pdf$/);
    expect(sent[1]).toMatchObject({ how: 'text', detail: 'here' });
  });

  /** The same rule `sendToChat` follows, and for the same reason. */
  it('will not carry an attachment from another conversation', async () => {
    const theirs = api.attachToChat(deps(), OTHER, 'image/png', PNG, 'shot.png');
    const out = await api.sayAsJuan(deps(), KEY, 'look', [theirs.path!]);
    expect(out.ok).toBe(true);
    expect(sent).toEqual([{ how: 'text', jid: JID, detail: 'look' }]);
  });

  it('ignores a path that escapes or was never written', async () => {
    for (const bad of [`media/${KEY}/../../../etc/passwd`, `media/${KEY}/op-1-deadbeef.png`, '/etc/passwd']) {
      sent = [];
      await api.sayAsJuan(deps(), KEY, 'hello', [bad]);
      expect(sent, bad).toEqual([{ how: 'text', jid: JID, detail: 'hello' }]);
    }
  });

  it('reports a WhatsApp failure rather than claiming it went', async () => {
    const broken = deps();
    (broken as unknown as { wa: { sendText: () => Promise<void> } }).wa.sendText = async () => {
      throw new Error('socket closed');
    };
    const out = await api.sayAsJuan(broken, KEY, 'hello');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('socket closed');
  });
});
