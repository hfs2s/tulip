/**
 * `updateSettings` writing `config.json`.
 *
 * The docblock on that function promises "a failed save must change nothing at
 * all", and the write-then-apply ordering is there to keep it. One case
 * inverted the promise: the raw file is read so the `_comment` keys survive the
 * round trip, and the read was wrapped in a bare `catch` annotated "first
 * write, or the file is gone". It also caught a *parse failure on a file that
 * exists* — leaving `raw` empty, so the atomic write replaced the entire file
 * with just the patched section.
 *
 * That is the shape `atomicFile.ts` exists to prevent, arriving through a
 * different door: a failed read must never be indistinguishable from an empty
 * result. OPERATIONS.md actively invites the setup ("config/config.json by hand
 * → docker compose restart bridge"), so a trailing comma plus one toggle in the
 * panel silently emptied `operators` and set `audience.everyone` to false on
 * the next restart — reported as `Saved.`
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Set before the module under test is imported: it reads the path once.
const dir = mkdtempSync(join(tmpdir(), 'tulip-settings-'));
const configFile = join(dir, 'config.json');
process.env['TULIP_CONFIG'] = configFile;
process.env['TULIP_STATE_DIR'] = dir;
process.env['TULIP_IN_DIR'] = join(dir, 'in');
process.env['TULIP_OUT_DIR'] = join(dir, 'out');

const { updateSettings } = await import('../src/panel-api.js');
const { parseConfig } = await import('../src/config.js');

function deps() {
  const config = parseConfig({
    audience: { everyone: false, numbers: ['15551234567'] },
    operators: { numbers: ['15559876543'] },
  });
  return {
    config,
    wa: {} as never,
    chats: { syncContacts: () => {}, flush: () => {} } as never,
    limiter: {} as never,
    dispatcher: () => ({}) as never,
  };
}

beforeEach(() => { if (existsSync(configFile)) unlinkSync(configFile); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('a config.json that cannot be parsed', () => {
  it('refuses the save rather than overwriting every other section', async () => {
    // A trailing comma and a missing brace: the classic hand-edit slip.
    const original = '{\n  "audience": { "everyone": false },\n  "operators": { "numbers": ["15559876543"] },\n';
    writeFileSync(configFile, original);
    const d = deps();

    const result = updateSettings(d, { groups: { enabled: true } });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('not valid JSON');
    // The broken file is left exactly as it was, so the operator can still see
    // what they typed and fix it.
    expect(readFileSync(configFile, 'utf8')).toBe(original);
  });

  it('does not apply the change to the running config either', async () => {
    writeFileSync(configFile, '{ "groups": ');
    const d = deps();

    updateSettings(d, { audience: { everyone: true } });

    expect(d.config.audience.everyone).toBe(false);
  });
});

describe('a config.json that is absent', () => {
  it('is treated as a first write, not as a failure', async () => {
    const result = updateSettings(deps(), { groups: { enabled: true } });

    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ groups: { enabled: true } });
  });
});

describe('a valid config.json', () => {
  it('keeps every section and comment the patch did not touch', async () => {
    writeFileSync(configFile, JSON.stringify({
      _comment: 'hand-written, and it must survive the round trip',
      audience: { everyone: false, numbers: ['15551234567'] },
      operators: { numbers: ['15559876543'] },
    }, null, 2));

    expect(updateSettings(deps(), { groups: { enabled: true } }).ok).toBe(true);

    const raw = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect(raw['_comment']).toBe('hand-written, and it must survive the round trip');
    expect(raw['operators']).toEqual({ numbers: ['15559876543'] });
    expect(raw['groups']).toEqual({ enabled: true });
  });
});
