/**
 * Plugins: the one sender whose destination is written in the request.
 *
 * Everything the agent sends is addressed by the turn it answers; a plugin
 * names its own recipient, because it is a service on the host with nobody to
 * answer. What stands between that and "a file in a directory can message
 * anyone" is the grant in config.json, so that is what most of this checks —
 * each dimension of it, refused on its own:
 *
 *   - the directory must be configured and enabled
 *   - the recipient must be on the list, and "any" never reaches a group
 *   - the kind must be allowed, the action unexpired, the chat unblocked
 *   - the hour must have room
 *
 * And the delivery contract the Iris-era services depend on: a receipt where
 * they look for it, a `.failed` when it will never go, and never a second send
 * of something already delivered.
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateRoot = mkdtempSync(join(tmpdir(), 'tulip-plugins-state-'));
process.env['TULIP_STATE_DIR'] = stateRoot;

const { PluginHost, recipientAllowed } = await import('../src/plugins.js');
const { PluginSettings } = await import('../src/config.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

let root: string;
let now: number;
let wa: { connected: boolean; sendText: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn> };
let blocked: Set<string>;
let records: Array<{ chatKey: string; jid: string; altJid: string | null; mergedInto: string | null }>;

function host(plugins: Record<string, Record<string, unknown>>): InstanceType<typeof PluginHost> {
  const parsed = Object.fromEntries(Object.entries(plugins).map(([k, v]) => [k, PluginSettings.parse(v)]));
  return new PluginHost({
    wa: wa as never,
    config: { plugins: parsed },
    chats: { all: () => records as never, isBlocked: (k: string) => blocked.has(k) },
    dir: root,
    now: () => now,
  });
}

function drop(plugin: string, file: string, action: unknown): string {
  const dir = join(root, plugin);
  mkdirSync(dir, { recursive: true });
  const full = join(dir, file);
  writeFileSync(full, typeof action === 'string' ? action : JSON.stringify(action));
  return full;
}

const files = (plugin: string): string[] => readdirSync(join(root, plugin)).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tulip-plugins-'));
  now = 1_800_000_000_000;
  wa = { connected: true, sendText: vi.fn(async () => null), sendImage: vi.fn(async () => null) };
  blocked = new Set();
  records = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('delivery', () => {
  it('sends a text action and leaves a receipt in its place', async () => {
    drop('anchor', 'a1.json', { id: 'a1', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'good morning' });
    await host({ anchor: { enabled: true, recipients: ['34600000001'] } }).drain();
    expect(wa.sendText).toHaveBeenCalledWith('34600000001@s.whatsapp.net', 'good morning');
    expect(files('anchor')).toEqual(['a1.sent']);
  });

  it('accepts an action in the shape Iris services write', async () => {
    // `chat`, `slug`, `source` and `queuedAt` are what morning-anchor.js
    // writes today. Pointing it at a plugin directory must be the only change.
    drop('anchor', '1788987608001-b4c17de3.json', {
      id: '1788987608001-b4c17de3',
      chat: '100000000000042@lid',
      slug: '100000000000042_lid',
      queuedAt: now,
      kind: 'text',
      text: 'lights out',
      source: 'morning-anchor:lights-out',
    });
    await host({ anchor: { enabled: true, recipients: ['100000000000042@lid'] } }).drain();
    expect(wa.sendText).toHaveBeenCalledWith('100000000000042@lid', 'lights out');
  });

  it('names the receipt for the external id, where the Iris services look for it', async () => {
    const id = '0f6a2df2-9040-4592-8f66-27cd25ea6921';
    drop('bibim', `bibim-${id}-1a2b3c4d.json`, {
      id: `bibim-${id}-1a2b3c4d`, externalId: id, chat: '34600000002@s.whatsapp.net',
      kind: 'text', text: 'your ticket', source: 'bibim-club', expiresAt: now + 60_000,
    });
    await host({ bibim: { enabled: true, recipients: 'any' } }).drain();
    expect(files('bibim')).toEqual([`bibim-${id}.sent`]);
  });

  it('never sends twice what a receipt says was already delivered', async () => {
    const id = '286ac4f7-45d3-464d-a4e1-acbe6738b09a';
    drop('bibim', `bibim-${id}.sent`, '{}');
    drop('bibim', `bibim-${id}-99999999.json`, {
      id: `bibim-${id}-99999999`, externalId: id, to: '34600000002@s.whatsapp.net', kind: 'text', text: 'again',
    });
    await host({ bibim: { enabled: true, recipients: 'any' } }).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(files('bibim')).toEqual([`bibim-${id}.sent`]);
  });

  it('sends an image by its name inside the plugin directory', async () => {
    const dir = join(root, 'photobooth');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'photobooth-x.png'), PNG);
    // Iris wrote an absolute host path. Only the last component is used.
    drop('photobooth', 'p1.json', {
      id: 'p1', kind: 'image', to: '34600000003@s.whatsapp.net',
      path: '/home/someone/iris/outbox/photobooth-x.png', caption: 'keepsake',
    });
    await host({ photobooth: { enabled: true, kinds: ['image'], recipients: 'any' } }).drain();
    expect(wa.sendImage).toHaveBeenCalledTimes(1);
    expect(wa.sendImage.mock.calls[0]?.[2]).toBe('keepsake');
  });

  it('does nothing while WhatsApp is disconnected', async () => {
    wa.connected = false;
    drop('anchor', 'a1.json', { id: 'a1', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'hi' });
    await host({ anchor: { enabled: true, recipients: ['34600000001'] } }).drain();
    expect(files('anchor')).toEqual(['a1.json']);
  });
});

describe('the grant', () => {
  it('ignores a directory with no entry in config', async () => {
    drop('stranger', 'a.json', { id: 'a', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'hi' });
    await host({}).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(files('stranger')).toEqual(['a.json']);
  });

  it('ignores a configured plugin that is switched off', async () => {
    drop('anchor', 'a.json', { id: 'a', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'hi' });
    await host({ anchor: { enabled: false, recipients: ['34600000001'] } }).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(files('anchor')).toEqual(['a.json']);
  });

  it('refuses a recipient that is not on the list, and the default list is nobody', async () => {
    drop('anchor', 'a.json', { id: 'a', kind: 'text', to: '34600000009@s.whatsapp.net', text: 'hi' });
    await host({ anchor: { enabled: true } }).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(files('anchor')).toEqual(['a.failed']);
  });

  it('never lets "any" reach a group', () => {
    expect(recipientAllowed('120363429498103037@g.us', 'any')).toBe(false);
    expect(recipientAllowed('120363429498103037@g.us', ['120363429498103037@g.us'])).toBe(true);
    expect(recipientAllowed('34600000001@s.whatsapp.net', 'any')).toBe(true);
    expect(recipientAllowed('34600000001@s.whatsapp.net', ['34600000001'])).toBe(true);
    expect(recipientAllowed('34600000001@s.whatsapp.net', ['346000000011'])).toBe(false);
    expect(recipientAllowed('100000000000042@lid', ['100000000000042@lid'])).toBe(true);
  });

  it('refuses a kind the plugin was not given', async () => {
    const dir = join(root, 'anchor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.png'), PNG);
    drop('anchor', 'a.json', { id: 'a', kind: 'image', to: '34600000001@s.whatsapp.net', file: 'x.png' });
    await host({ anchor: { enabled: true, recipients: ['34600000001'] } }).drain();
    expect(wa.sendImage).not.toHaveBeenCalled();
    expect(files('anchor')).toContain('a.failed');
  });

  it('refuses an action past its expiry rather than sending it late', async () => {
    drop('bibim', 'a.json', { id: 'a', kind: 'text', to: '34600000002@s.whatsapp.net', text: 'late', expiresAt: now - 1 });
    await host({ bibim: { enabled: true, recipients: 'any' } }).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(files('bibim')).toEqual(['a.failed']);
  });

  it('refuses a chat an operator has blocked', async () => {
    records = [{ chatKey: 'aaaaaaaaaaaaaaaa', jid: '34600000001@s.whatsapp.net', altJid: null, mergedInto: null }];
    blocked.add('aaaaaaaaaaaaaaaa');
    drop('anchor', 'a.json', { id: 'a', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'hi' });
    await host({ anchor: { enabled: true, recipients: ['34600000001'] } }).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(files('anchor')).toEqual(['a.failed']);
  });

  it('refuses a field it does not understand', async () => {
    drop('anchor', 'a.json', { id: 'a', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'hi', cc: '34600000002' });
    await host({ anchor: { enabled: true, recipients: ['34600000001'] } }).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    expect(files('anchor')).toEqual(['a.failed']);
  });

  it('holds what is over the hour instead of dropping it', async () => {
    drop('anchor', 'a.json', { id: 'a', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'one' });
    drop('anchor', 'b.json', { id: 'b', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'two' });
    const h = host({ anchor: { enabled: true, recipients: ['34600000001'], perHour: 1 } });
    await h.drain();
    expect(wa.sendText).toHaveBeenCalledTimes(1);
    expect(files('anchor')).toEqual(['a.sent', 'b.json']);
    now += 3_600_001;
    await h.drain();
    expect(wa.sendText).toHaveBeenCalledTimes(2);
  });
});

describe('failure', () => {
  it('retries a failed send with backoff, then gives up with a .failed', async () => {
    wa.sendText.mockRejectedValue(new Error('socket closed'));
    drop('anchor', 'a.json', { id: 'a', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'hi' });
    const h = host({ anchor: { enabled: true, recipients: ['34600000001'] } });
    await h.drain();
    await h.drain(); // inside the backoff: not attempted again
    expect(wa.sendText).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      await h.drain();
    }
    expect(wa.sendText).toHaveBeenCalledTimes(4);
    expect(files('anchor')).toEqual(['a.failed']);
    expect(h.status().find((s) => s.name === 'anchor')?.lastError).toMatch(/gave up after 4 attempts/);
  });

  it('keeps nothing of a private plugin’s message in its .failed', async () => {
    drop('photobooth', 'a.json', { id: 'a', kind: 'text', to: '34600000003@s.whatsapp.net', text: 'your secret link' });
    await host({ photobooth: { enabled: true, kinds: ['image'], recipients: 'any', private: true } }).drain();
    const failed = readFileSync(join(root, 'photobooth', 'a.failed'), 'utf8');
    expect(failed).not.toContain('secret');
    expect(failed).not.toContain('34600000003');
  });
});

describe('the filesystem is hostile', () => {
  it('will not follow a link planted as the image', async () => {
    const outside = join(root, 'outside.png');
    writeFileSync(outside, PNG);
    const dir = join(root, 'photobooth');
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, 'link.png'));
    drop('photobooth', 'a.json', { id: 'a', kind: 'image', to: '34600000003@s.whatsapp.net', file: 'link.png' });
    await host({ photobooth: { enabled: true, kinds: ['image'], recipients: 'any' } }).drain();
    expect(wa.sendImage).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'a.failed'))).toBe(true);
  });

  it('will not read a name with a path in it', async () => {
    drop('photobooth', 'a.json', { id: 'a', kind: 'image', to: '34600000003@s.whatsapp.net', file: '../state/panel-token' });
    await host({ photobooth: { enabled: true, kinds: ['image'], recipients: 'any' } }).drain();
    expect(wa.sendImage).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a picture', async () => {
    const dir = join(root, 'photobooth');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fake.png'), 'not an image at all');
    drop('photobooth', 'a.json', { id: 'a', kind: 'image', to: '34600000003@s.whatsapp.net', file: 'fake.png' });
    await host({ photobooth: { enabled: true, kinds: ['image'], recipients: 'any' } }).drain();
    expect(wa.sendImage).not.toHaveBeenCalled();
  });

  it('ignores a plugin directory that is a link', async () => {
    const real = mkdtempSync(join(tmpdir(), 'tulip-plugins-real-'));
    writeFileSync(join(real, 'a.json'), JSON.stringify({ id: 'a', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'hi' }));
    symlinkSync(real, join(root, 'anchor'));
    await host({ anchor: { enabled: true, recipients: ['34600000001'] } }).drain();
    expect(wa.sendText).not.toHaveBeenCalled();
    rmSync(real, { recursive: true, force: true });
  });
});

/**
 * A callable plugin keeps its manifest, calls and answers in this same
 * directory. The sender must walk past all three: a manifest read as an action
 * is refused and renamed to `.failed`, which quietly unlists the plugin.
 */
describe('the call protocol shares the directory', () => {
  const ACTION = { id: 'x', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'not for sending' };

  it('ignores manifest.json, calls/ and answers/, and still sends the real action', async () => {
    drop('bookings', 'manifest.json', { description: 'Bookings', actions: [] });
    mkdirSync(join(root, 'bookings', 'calls'));
    mkdirSync(join(root, 'bookings', 'answers'));
    writeFileSync(join(root, 'bookings', 'calls', 'c1.json'), JSON.stringify(ACTION));
    writeFileSync(join(root, 'bookings', 'answers', 'c1.json'), JSON.stringify(ACTION));
    drop('bookings', 'a1.json', { id: 'a1', kind: 'text', to: '34600000001@s.whatsapp.net', text: 'real' });

    const h = host({ bookings: { enabled: true, recipients: ['34600000001'] } });
    await h.drain();

    expect(wa.sendText).toHaveBeenCalledTimes(1);
    expect(wa.sendText).toHaveBeenCalledWith('34600000001@s.whatsapp.net', 'real');
    expect(files('bookings')).toEqual(['a1.sent', 'answers', 'calls', 'manifest.json']);
    expect(readdirSync(join(root, 'bookings', 'calls'))).toEqual(['c1.json']);
    expect(readdirSync(join(root, 'bookings', 'answers'))).toEqual(['c1.json']);
    expect(h.status().find((s) => s.name === 'bookings')?.pending).toBe(0);
  });
});

describe('status', () => {
  it('shows a directory nobody configured, so a misdirected service is visible', () => {
    mkdirSync(join(root, 'mystery'), { recursive: true });
    const status = host({ anchor: { enabled: true, recipients: [] } }).status();
    expect(status.map((s) => [s.name, s.configured, s.present])).toEqual([
      ['anchor', true, false],
      ['mystery', false, true],
    ]);
  });
});
