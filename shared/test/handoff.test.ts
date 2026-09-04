import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CurrentTurn, InboundMessage, InboxBatch } from '../src/handoff.js';
import { writeFileAtomic, writeJsonAtomic } from '../src/atomic.js';

const TURN = '11111111-2222-4333-8444-555555555555';
const KEY = 'a1b2c3d4e5f60718';

const batch = (over: Record<string, unknown> = {}): unknown => ({
  turnId: TURN,
  chatKey: KEY,
  chatName: 'someone',
  isGroup: false,
  receivedAt: '2026-01-01T12:00:00.000Z',
  messages: [
    { from: 'someone', at: '2026-01-01T12:00:00.000Z', text: 'hello', quoted: null, media: [] },
  ],
  ...over,
});

describe('InboxBatch', () => {
  it('accepts a well-formed batch', () => {
    expect(InboxBatch.safeParse(batch()).success).toBe(true);
  });

  it('rejects a chat key that is not the fixed opaque shape', () => {
    // The key is interpolated into filesystem paths and tmux window names, so
    // its shape is what makes that safe to do without further escaping.
    for (const chatKey of ['../../etc', 'A1B2C3D4E5F60718', 'short', `${KEY}0`, '']) {
      expect(InboxBatch.safeParse(batch({ chatKey })).success).toBe(false);
    }
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(InboxBatch.safeParse(batch({ chatJid: '15551234567@s.whatsapp.net' })).success).toBe(false);
  });

  it('requires at least one message and caps the batch', () => {
    expect(InboxBatch.safeParse(batch({ messages: [] })).success).toBe(false);
    const many = Array.from({ length: 51 }, () => ({
      from: 'x', at: '2026-01-01T12:00:00.000Z', text: 'y', quoted: null, media: [],
    }));
    expect(InboxBatch.safeParse(batch({ messages: many })).success).toBe(false);
  });

  it('constrains media paths to the inbound media directory', () => {
    const withMedia = (path: unknown): unknown =>
      batch({
        messages: [{
          from: 'someone', at: '2026-01-01T12:00:00.000Z', text: '', quoted: null,
          media: [{
            kind: 'image', path, mimetype: 'image/jpeg', bytes: 10,
            fileName: null, seconds: null, isVoiceNote: false, error: null,
          }],
        }],
      });

    expect(InboxBatch.safeParse(withMedia(`media/${KEY}/1-abc.jpg`)).success).toBe(true);
    expect(InboxBatch.safeParse(withMedia(null)).success).toBe(true); // download failed
    for (const bad of ['/etc/passwd', `../../${KEY}/x.jpg`, `media/${KEY}/../../x`, 'x.jpg']) {
      expect(InboxBatch.safeParse(withMedia(bad)).success).toBe(false);
    }
  });
});

describe('CurrentTurn', () => {
  const current = (over: Record<string, unknown> = {}): unknown => ({
    turnId: TURN,
    chatKey: KEY,
    chatName: 'someone',
    isGroup: false,
    batch: `batches/${TURN}.json`,
    startedAt: '2026-01-01T12:00:00.000Z',
    ...over,
  });

  it('accepts a well-formed pointer', () => {
    expect(CurrentTurn.safeParse(current()).success).toBe(true);
  });

  it('constrains the batch path to the batches directory', () => {
    for (const bad of ['/etc/passwd', '../../secret.json', 'batches/../../x.json', `${TURN}.json`]) {
      expect(CurrentTurn.safeParse(current({ batch: bad })).success).toBe(false);
    }
  });
});

describe('atomic writes', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'tulip-atomic-'));
    roots.push(root);
    return root;
  };

  it('writes the whole file', () => {
    const root = scratch();
    writeJsonAtomic(join(root, 'a.json'), { hello: 'world' });
    expect(JSON.parse(readFileSync(join(root, 'a.json'), 'utf8'))).toEqual({ hello: 'world' });
  });

  it('creates parent directories', () => {
    const root = scratch();
    writeFileAtomic(join(root, 'deep', 'nested', 'f.txt'), 'x');
    expect(readFileSync(join(root, 'deep', 'nested', 'f.txt'), 'utf8')).toBe('x');
  });

  // A reader on the other side of the volume polls this directory. A pile of
  // abandoned temporaries is how a transient error becomes a permanent one.
  it('leaves no temporary file behind on success', () => {
    const root = scratch();
    writeJsonAtomic(join(root, 'a.json'), { n: 1 });
    expect(readdirSync(root).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('replaces an existing file completely rather than overwriting in place', () => {
    const root = scratch();
    const file = join(root, 'a.json');
    writeJsonAtomic(file, { long: 'x'.repeat(500) });
    writeJsonAtomic(file, { short: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ short: 1 });
  });

  it('throws, and cleans up, when the target cannot be written', () => {
    expect(() => writeFileAtomic('/proc/definitely-not-writable/x', 'y')).toThrow();
  });
});

/**
 * `mentionsMe` exists for judgement mode, where the agent rather than the gate
 * decides whether to speak. Without it the agent could not tell "somebody
 * @mentioned me" from "somebody typed my name", which is the difference between
 * a question aimed at it and a question aimed at the person sitting next to it.
 */
describe('mentionsMe', () => {
  const message = {
    from: 'Someone',
    at: new Date().toISOString(),
    text: 'are you here, Maria?',
    quoted: null,
    media: [],
  };

  it('is carried through when the bridge sets it', () => {
    const parsed = InboundMessage.safeParse({ ...message, mentionsMe: true });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mentionsMe).toBe(true);
  });

  it('defaults to false on a batch written before the field existed', () => {
    // The upgrade case: a batch already on disk when the bridge restarts. It
    // must still parse, and must not claim to have been addressed.
    const parsed = InboundMessage.safeParse(message);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mentionsMe).toBe(false);
  });

  it('is still rejected when it is not a boolean', () => {
    expect(InboundMessage.safeParse({ ...message, mentionsMe: 'yes' }).success).toBe(false);
  });
});
