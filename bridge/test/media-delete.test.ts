/**
 * Deleting an attachment, and the guard that decides which file that is.
 *
 * This is the panel's second write endpoint and its only irreversible one:
 * there is no trash, nothing keeps a copy, and the bridge runs with both media
 * roots mounted read-write. So the interesting tests are not "does it delete
 * the file" but "what else could it be talked into deleting" — the WhatsApp
 * session store and the chat key map both sit on the bridge's own volume, a
 * couple of `..` segments away from the media roots.
 *
 * The environment is set before the import because the roots are read from it
 * at module load; a scratch directory keeps the assertions honest about a real
 * filesystem rather than a mocked one.
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'tulip-media-'));
process.env['TULIP_IN_DIR'] = join(root, 'in');
process.env['TULIP_OUT_DIR'] = join(root, 'out');

const { deleteMedia, resolveMedia } = await import('../src/panel-api.js');
const { inPaths, transcriptFor } = await import('@tulip/shared');

const CHAT = '17f1f7d2c1a600d2';
const VOICE = '1788527429000-3A8B3241D25E.ogg';

afterAll(() => rmSync(root, { recursive: true, force: true }));

function scratchVoiceNote(): string {
  const dir = inPaths.mediaFor(CHAT);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, VOICE);
  writeFileSync(file, 'OggS-pretend-audio');
  writeFileSync(transcriptFor(file), 'Hey, can you check the Gaudi photo?');
  return file;
}

beforeEach(() => {
  rmSync(join(root, 'in'), { recursive: true, force: true });
  rmSync(join(root, 'out'), { recursive: true, force: true });
});

describe('resolveMedia — what it refuses to name', () => {
  it('refuses a chat key that is not one', () => {
    expect(resolveMedia('not-a-key', VOICE, 'in')).toBeNull();
    // Right alphabet, wrong length: the pattern is anchored, so this is a
    // prefix of a real key rather than a real key.
    expect(resolveMedia('17f1f7d2c1a600', VOICE, 'in')).toBeNull();
    expect(resolveMedia('', VOICE, 'in')).toBeNull();
  });

  it('refuses a name that is a path rather than a name', () => {
    for (const name of [
      '../../../state/session/creds.json',
      'sub/dir/file.ogg',
      '..',
      '/etc/passwd',
    ]) {
      expect(resolveMedia(CHAT, name, 'in')).toBeNull();
    }
  });

  it('refuses a dotfile', () => {
    // Nothing the bridge writes into a media directory begins with a dot, so
    // anything that does was named by whoever is asking.
    expect(resolveMedia(CHAT, '.env', 'in')).toBeNull();
  });

  it('refuses a direction that is not one of the two roots', () => {
    expect(resolveMedia(CHAT, VOICE, 'state')).toBeNull();
    expect(resolveMedia(CHAT, VOICE, '')).toBeNull();
    expect(resolveMedia(CHAT, VOICE, '../state')).toBeNull();
  });

  it('names a file under the root it was asked for, and only there', () => {
    const inbound = resolveMedia(CHAT, VOICE, 'in');
    const outbound = resolveMedia(CHAT, VOICE, 'out');
    expect(inbound).toContain(join('in', 'media', CHAT, VOICE));
    expect(outbound).not.toBe(inbound);
  });
});

describe('deleteMedia — the file and what was said in it', () => {
  it('removes the recording and its transcript together', () => {
    const file = scratchVoiceNote();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(transcriptFor(file))).toBe(true);

    expect(deleteMedia(CHAT, VOICE, 'in')).toMatchObject({ ok: true });
    expect(existsSync(file)).toBe(false);
    // The point of the sidecar: an operator who deleted a voice note has not
    // left its words behind in the list.
    expect(existsSync(transcriptFor(file))).toBe(false);
  });

  it('deletes an attachment that has no transcript', () => {
    const dir = inPaths.mediaFor(CHAT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'photo.jpg'), 'not-really-a-jpeg');

    expect(deleteMedia(CHAT, 'photo.jpg', 'in')).toMatchObject({ ok: true });
    expect(existsSync(join(dir, 'photo.jpg'))).toBe(false);
  });

  it('says so when it is already gone, rather than claiming success', () => {
    expect(deleteMedia(CHAT, 'never-existed.ogg', 'in')).toMatchObject({ ok: false });
  });

  it('leaves the chat directory in place', () => {
    // One file, never a directory. A delete that removed an empty parent would
    // be a different and much sharper tool.
    const file = scratchVoiceNote();
    deleteMedia(CHAT, VOICE, 'in');
    expect(existsSync(inPaths.mediaFor(CHAT))).toBe(true);
    expect(file).toContain(CHAT);
  });
});

describe('deleteMedia — what it cannot be talked into', () => {
  it('will not climb out of the media root', () => {
    // Stands in for the WhatsApp credentials: a real file, outside both roots,
    // reachable only by escaping.
    const secret = join(root, 'creds.json');
    writeFileSync(secret, '{"whatsapp":"credentials"}');

    for (const name of [
      '../../creds.json',
      '../../../creds.json',
      '..%2f..%2fcreds.json',
      'media/../../../creds.json',
    ]) {
      expect(deleteMedia(CHAT, name, 'in')).toMatchObject({ ok: false });
    }
    expect(existsSync(secret)).toBe(true);
    expect(readFileSync(secret, 'utf8')).toContain('credentials');
  });

  it('will not delete another chat’s attachment through a crafted name', () => {
    const other = 'aaaaaaaaaaaaaaaa';
    const dir = inPaths.mediaFor(other);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'theirs.ogg'), 'someone else');

    expect(deleteMedia(CHAT, `../${other}/theirs.ogg`, 'in')).toMatchObject({ ok: false });
    expect(existsSync(join(dir, 'theirs.ogg'))).toBe(true);
  });
});
