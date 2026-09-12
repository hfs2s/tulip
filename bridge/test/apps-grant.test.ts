/**
 * `apps.grants`, where it is actually enforced.
 *
 * The panel page is worth nothing if the refusal happens after the call has
 * been written: the hfs2s plugin ssh's into a box and `exec` runs commands in
 * somebody's live app, so a call that should have been refused is one the box
 * may already have acted on. So the property under test is the same one
 * plugin-calls.test.ts holds for the other rules — **refused before anything
 * is written into the plugin's directory** — plus the two edges of the grant
 * itself: an operator is never refused, and a call naming no workspace is not
 * governed by this at all.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env['TULIP_STATE_DIR'] ??= mkdtempSync(join(tmpdir(), 'tulip-appgrant-state-'));

vi.mock('../src/minimax.js', () => ({ synthesise: vi.fn(), generateImage: vi.fn() }));
vi.mock('../src/mediaStore.js', () => ({ retainOutbound: vi.fn() }));

const PHONE = '15551234567@s.whatsapp.net';
const WORKSPACE = '28c21d3c';

/** The real plugin's shape, cut to the two actions this needs. */
const MANIFEST = {
  label: 'hfs2s',
  description: 'The hfs2s hosting box.',
  actions: [
    { name: 'status', summary: 'Every workspace.' },
    { name: 'health', summary: 'Whether one workspace answers.', args: { workspace: 'The 8-character workspace id.' } },
  ],
};

let roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function harness(appsFor: (chatKey: string) => Record<string, unknown> = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), 'tulip-appgrant-'));
  roots.push(root);
  const out = join(root, 'out');
  mkdirSync(join(out, 'actions'), { recursive: true });
  mkdirSync(join(out, 'files'), { recursive: true });
  mkdirSync(join(root, 'in'), { recursive: true });
  const pluginsDir = join(root, 'plugins');
  mkdirSync(join(pluginsDir, 'hfs2s', 'answers'), { recursive: true });
  mkdirSync(join(pluginsDir, 'hfs2s', 'calls'), { recursive: true });
  writeFileSync(join(pluginsDir, 'hfs2s', 'manifest.json'), JSON.stringify(MANIFEST));
  vi.stubEnv('TULIP_OUT_DIR', out);
  vi.stubEnv('TULIP_IN_DIR', join(root, 'in'));
  vi.stubEnv('TULIP_STATE_DIR', root);
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, '{}');
  vi.stubEnv('TULIP_CONFIG', configFile);

  vi.resetModules();
  const { Outbox } = await import('../src/outbox.js');
  const { ChatRegistry } = await import('../src/chats.js');
  const { TurnRegistry } = await import('../src/turns.js');
  const { Limiter } = await import('../src/ratelimit.js');
  const { parseConfig } = await import('../src/config.js');
  const { outPaths, inPaths } = await import('@2lp/shared');

  // The registry first: it salts its own keys, so the key to grant does not
  // exist until it does, and a key borrowed from another harness is a different
  // conversation entirely.
  const chats = new ChatRegistry(join(root, 'salt'), join(root, 'chats.json'));
  const direct = chats.keyFor(PHONE, false, Date.now());
  const config = parseConfig({
    operators: { numbers: ['15551110000'] },
    // operatorOnly off: the whole point of a grant is letting the person whose
    // app it is ask about their own app, which they cannot do while only an
    // operator may call the plugin at all.
    plugins: { hfs2s: { label: 'hfs2s', callable: { enabled: true, operatorOnly: false, timeoutMs: 1000 } } },
    apps: appsFor(direct),
  });
  const turns = new TurnRegistry(config.limits.turnTimeoutMs, config.limits.outboundPerTurn, config.limits.toolsPerTurn);
  const limiter = new Limiter({
    messagesPerHour: 1000, burst: 50, turnsPerDay: 1000, newSendersPerHour: 1000, outboundPerChatPerHour: 1000,
  });
  const wa = { sendText: vi.fn(async () => null), typing: vi.fn(async () => null) };
  const outbox = new Outbox({
    wa: wa as never, config, chats, turns, limiter, lastMessageIn: () => null, setPagePasswords: () => undefined, pluginsDir,
  });
  return {
    chatKey: direct,
    calls: (): string[] => readdirSync(join(pluginsDir, 'hfs2s', 'calls')),
    async ask(action: Record<string, unknown>, operator = false): Promise<string> {
      const turn = turns.open(PHONE, direct, Date.now(), operator);
      const id = randomUUID();
      writeFileSync(outPaths.action(id), JSON.stringify({ id, turnId: turn.turnId, ...action }));
      await outbox.drain();
      return id;
    },
    answer(id: string): { ok: boolean; error: string | null } | null {
      try {
        return JSON.parse(readFileSync(inPaths.result(id), 'utf8')) as { ok: boolean; error: string | null };
      } catch {
        return null;
      }
    },
    /**
     * `drain` does not await a plugin call — it would hold every other chat's
     * reply behind one — so an allowed call is still in flight when the queue
     * is empty. A refusal, by contrast, is written before `drain` returns,
     * which is what the `calls()` assertions rely on.
     */
    async settled(id: string, ms = 6000): Promise<{ ok: boolean; error: string | null }> {
      const deadline = Date.now() + ms;
      for (;;) {
        try {
          return JSON.parse(readFileSync(inPaths.result(id), 'utf8')) as { ok: boolean; error: string | null };
        } catch {
          if (Date.now() > deadline) throw new Error('timed out waiting for the answer');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    },
  };
}

describe('working on an app a conversation was not granted', () => {
  it('is refused, and nothing is written into the plugin’s directory', async () => {
    const h = await harness();
    const id = await h.ask({ kind: 'pluginCall', plugin: 'hfs2s', action: 'health', args: { workspace: WORKSPACE } });
    expect(h.answer(id)?.ok).toBe(false);
    expect(h.answer(id)?.error).toContain('not this conversation’s to work on');
    expect(h.calls()).toEqual([]);
  });

  it('is allowed once the operator grants that chat that app', async () => {
    const granted = await harness((chatKey) => ({ grants: { [WORKSPACE]: [chatKey] } }));
    const id = await granted.ask({ kind: 'pluginCall', plugin: 'hfs2s', action: 'health', args: { workspace: WORKSPACE } });
    // Nothing answers in this test, so it times out — which is the proof it got
    // past the gate and was written, where the refusal above never was.
    expect((await granted.settled(id)).error).toContain('did not answer');
  });

  it('is still refused for a different app than the one granted', async () => {
    const granted = await harness((chatKey) => ({ grants: { '3f5c57a8': [chatKey] } }));
    const id = await granted.ask({ kind: 'pluginCall', plugin: 'hfs2s', action: 'health', args: { workspace: WORKSPACE } });
    expect(granted.answer(id)?.error).toContain('not this conversation’s to work on');
    expect(granted.calls()).toEqual([]);
  });
});

describe('naming an app', () => {
  it('is refused for an app this conversation was not granted', async () => {
    const h = await harness();
    const id = await h.ask({ kind: 'appLabel', workspace: WORKSPACE, label: 'mine now' });
    expect(h.answer(id)?.ok).toBe(false);
    expect(h.answer(id)?.error).toContain('not this conversation’s to work on');
  });

  it('is allowed for an app it was granted', async () => {
    const granted = await harness((chatKey) => ({ grants: { [WORKSPACE]: [chatKey] } }));
    const id = await granted.ask({ kind: 'appLabel', workspace: WORKSPACE, label: 'The shop' });
    expect(granted.answer(id)?.ok).toBe(true);
  });
});

describe('what the grant does not govern', () => {
  it('never refuses an operator', async () => {
    const h = await harness(() => ({ grants: { [WORKSPACE]: [] } }));
    const id = await h.ask({ kind: 'pluginCall', plugin: 'hfs2s', action: 'health', args: { workspace: WORKSPACE } }, true);
    expect((await h.settled(id)).error).toContain('did not answer');
  });

  it('lets an operator ask about the box', async () => {
    const h = await harness();
    const id = await h.ask({ kind: 'pluginCall', plugin: 'hfs2s', action: 'status', args: {} }, true);
    expect((await h.settled(id)).error).toContain('did not answer');
  });

  /**
   * The hole that opens the moment `operatorOnly` is switched off so that a
   * client's group can work on that client's app: `status` lists every
   * workspace on the box and `box` reports the machine, and neither names a
   * workspace for a grant to govern. Granting one app is not consent to see
   * the rest.
   */
  it('keeps the box’s own listing away from a chat that is not an operator', async () => {
    const h = await harness();
    const id = await h.ask({ kind: 'pluginCall', plugin: 'hfs2s', action: 'status', args: {} });
    expect(h.answer(id)?.ok).toBe(false);
    expect(h.answer(id)?.error).toContain('hosting box as a whole');
    expect(h.calls()).toEqual([]);
  });

  it('keeps it away even from a chat that was granted an app', async () => {
    const granted = await harness((chatKey) => ({ grants: { [WORKSPACE]: [chatKey] } }));
    const id = await granted.ask({ kind: 'pluginCall', plugin: 'hfs2s', action: 'status', args: {} });
    expect(granted.answer(id)?.error).toContain('hosting box as a whole');
    expect(granted.calls()).toEqual([]);
  });
});
