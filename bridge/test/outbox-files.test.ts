import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutboxAction } from '@tulip/shared';
import { resolveOutboundFile } from '../src/outbox.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch outbox, plus a "secret" beside it standing in for /state/session. */
function scratch(): { files: string; secret: string } {
  const root = mkdtempSync(join(tmpdir(), 'tulip-outbox-'));
  roots.push(root);
  const files = join(root, 'out', 'files');
  mkdirSync(files, { recursive: true });
  const secret = join(root, 'creds.json');
  writeFileSync(secret, '{"whatsapp":"credentials"}');
  return { files, secret };
}

describe('resolveOutboundFile — accepts what it should', () => {
  it('accepts a real PNG', () => {
    const { files } = scratch();
    writeFileSync(join(files, 'chart.png'), PNG);
    expect(resolveOutboundFile('chart.png', files)).toMatchObject({
      ok: true,
      mimetype: 'image/png',
    });
  });

  it('accepts a JPEG under either extension', () => {
    const { files } = scratch();
    writeFileSync(join(files, 'a.jpg'), JPEG);
    writeFileSync(join(files, 'b.jpeg'), JPEG);
    expect(resolveOutboundFile('a.jpg', files).ok).toBe(true);
    expect(resolveOutboundFile('b.jpeg', files).ok).toBe(true);
  });

  it('accepts text formats without a magic-byte check', () => {
    const { files } = scratch();
    writeFileSync(join(files, 'notes.md'), '# hello');
    writeFileSync(join(files, 'data.csv'), 'a,b\n1,2');
    expect(resolveOutboundFile('notes.md', files)).toMatchObject({ ok: true, mimetype: 'text/markdown' });
    expect(resolveOutboundFile('data.csv', files)).toMatchObject({ ok: true, mimetype: 'text/csv' });
  });
});

/**
 * The attack this function exists to stop. The agent shares the volume but not
 * the namespace, so a symlink it creates is resolved by the *bridge*, where the
 * WhatsApp credentials live.
 */
describe('resolveOutboundFile — symlink escape', () => {
  it('refuses a symlink pointing at the credentials, rather than following it', () => {
    const { files, secret } = scratch();
    symlinkSync(secret, join(files, 'holiday.png'));

    expect(resolveOutboundFile('holiday.png', files)).toEqual({
      ok: false,
      reason: 'file is a symlink',
    });
  });

  it('refuses a symlink to an absolute system path', () => {
    const { files } = scratch();
    symlinkSync('/etc/passwd', join(files, 'photo.png'));
    expect(resolveOutboundFile('photo.png', files).ok).toBe(false);
  });

  // The agent has write access to this volume, so it can remove the outbox
  // directory and put a symlink in its place. Every per-file check would then
  // confine correctly to the wrong root.
  it('refuses to use an outbox directory that has been replaced by a symlink', () => {
    const { files } = scratch();
    const elsewhere = mkdtempSync(join(tmpdir(), 'tulip-elsewhere-'));
    roots.push(elsewhere);
    writeFileSync(join(elsewhere, 'leak.png'), PNG);
    // Something a real deployment would have next door, with an allowlisted
    // extension: the map from chat keys back to phone numbers.
    writeFileSync(join(elsewhere, 'chats.json'), '{"chats":[]}');

    const swapped = join(files, '..', 'swapped');
    symlinkSync(elsewhere, swapped);

    expect(resolveOutboundFile('leak.png', swapped)).toEqual({
      ok: false,
      reason: 'the outbox directory has been replaced',
    });
    expect(resolveOutboundFile('chats.json', swapped).ok).toBe(false);
  });

  it('refuses when the outbox directory is missing entirely', () => {
    const { files } = scratch();
    expect(resolveOutboundFile('x.png', join(files, 'nope'))).toEqual({
      ok: false,
      reason: 'the outbox directory is missing',
    });
  });
});

describe('resolveOutboundFile — path traversal', () => {
  it.each([
    ['parent traversal', '../creds.json'],
    ['deep traversal', '../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['nested path', 'sub/dir/file.png'],
    ['backslash path', '..\\creds.json'],
    ['bare dots', '..'],
    ['dotfile', '.env'],
  ])('refuses %s', (_label, name) => {
    const { files } = scratch();
    expect(resolveOutboundFile(name, files).ok).toBe(false);
  });
});

describe('resolveOutboundFile — type and size', () => {
  it('refuses an extension that is not on the allowlist', () => {
    const { files } = scratch();
    for (const name of ['script.sh', 'binary.exe', 'archive.zip', 'page.html', 'lib.so', 'noext']) {
      writeFileSync(join(files, name), 'x');
      expect(resolveOutboundFile(name, files).ok).toBe(false);
    }
  });

  // Stops a text file being passed off as an image, which is how a renamed
  // payload gets past a client that trusts the declared type.
  it('refuses content that does not match the claimed type', () => {
    const { files } = scratch();
    writeFileSync(join(files, 'fake.png'), 'this is not a png');
    expect(resolveOutboundFile('fake.png', files)).toEqual({
      ok: false,
      reason: 'file does not contain image/png data',
    });
  });

  it('refuses an empty file', () => {
    const { files } = scratch();
    writeFileSync(join(files, 'empty.png'), '');
    expect(resolveOutboundFile('empty.png', files)).toMatchObject({ ok: false, reason: 'file is empty' });
  });

  it('refuses a file over the size cap', () => {
    const { files } = scratch();
    writeFileSync(join(files, 'huge.png'), Buffer.concat([PNG, Buffer.alloc(17 * 1024 * 1024)]));
    expect(resolveOutboundFile('huge.png', files)).toMatchObject({ ok: false });
  });

  it('refuses a directory', () => {
    const { files } = scratch();
    mkdirSync(join(files, 'folder.png'));
    expect(resolveOutboundFile('folder.png', files)).toEqual({
      ok: false,
      reason: 'file is not a regular file',
    });
  });

  it('refuses a file that is not there', () => {
    const { files } = scratch();
    expect(resolveOutboundFile('missing.png', files)).toEqual({ ok: false, reason: 'file does not exist' });
  });
});

/**
 * The schema is the other half of the boundary: the agent has no vocabulary for
 * naming a recipient, so no amount of cleverness in the payload produces one.
 */
describe('OutboxAction schema', () => {
  const base = {
    id: '11111111-2222-4333-8444-555555555555',
    turnId: '99999999-8888-4777-8666-555555555555',
  };

  it('accepts a well-formed text action', () => {
    expect(OutboxAction.safeParse({ ...base, kind: 'text', text: 'hello' }).success).toBe(true);
  });

  it.each([
    ['a chat id', { chat: '15551234567@s.whatsapp.net' }],
    ['a recipient', { to: '15551234567' }],
    ['an absolute path', { path: '/state/session/creds.json' }],
    ['a shell command', { command: 'cat /state/session/creds.json' }],
    ['a url', { url: 'https://evil.test/collect' }],
  ])('refuses an action carrying %s', (_label, extra) => {
    const result = OutboxAction.safeParse({ ...base, kind: 'text', text: 'hello', ...extra });
    expect(result.success).toBe(false);
  });

  it('refuses a file action whose name is a path', () => {
    for (const file of ['../../creds.json', '/etc/passwd', 'sub/file.png', '..']) {
      expect(OutboxAction.safeParse({ ...base, kind: 'file', file, caption: null }).success).toBe(false);
    }
  });

  it('refuses an unknown action kind', () => {
    expect(OutboxAction.safeParse({ ...base, kind: 'exec', text: 'x' }).success).toBe(false);
  });

  it('refuses a turn id that is not a UUID', () => {
    expect(OutboxAction.safeParse({ ...base, turnId: 'any-turn', kind: 'text', text: 'x' }).success).toBe(false);
  });

  it('caps text length', () => {
    expect(OutboxAction.safeParse({ ...base, kind: 'text', text: 'x'.repeat(4097) }).success).toBe(false);
    expect(OutboxAction.safeParse({ ...base, kind: 'text', text: '' }).success).toBe(false);
  });
});
