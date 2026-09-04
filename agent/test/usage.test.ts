/**
 * The token meter reads files another process is actively appending to, so the
 * cases that matter are the ragged ones: a half-written final line, a file that
 * grew since last time, a session resumed and rewritten.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageMeter } from '../src/usage.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function scratch(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'tulip-usage-'));
  roots.push(root);
  const dir = join(root, 'a-project');
  mkdirSync(dir, { recursive: true });
  return { root, file: join(dir, 'session.jsonl') };
}

function reply(uuid: string, at: Date, tokens: Partial<Record<string, number>> = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: at.toISOString(),
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: tokens['input'] ?? 10,
        output_tokens: tokens['output'] ?? 5,
        cache_creation_input_tokens: tokens['cacheWrite'] ?? 0,
        cache_read_input_tokens: tokens['cacheRead'] ?? 0,
      },
    },
  }) + '\n';
}

describe('UsageMeter', () => {
  it('buckets into rolling windows', () => {
    const { root, file } = scratch();
    const now = Date.now();
    writeFileSync(file,
      reply('a', new Date(now - 10 * 60_000), { input: 100, output: 20 }) +
      reply('b', new Date(now - 5 * 3_600_000), { input: 200, output: 40 }) +
      reply('c', new Date(now - 3 * 86_400_000), { input: 400, output: 80 }));

    const r = new UsageMeter(root).report(now);
    expect(r.hour).toMatchObject({ input: 100, output: 20, replies: 1 });
    expect(r.day).toMatchObject({ input: 300, output: 60, replies: 2 });
    expect(r.week).toMatchObject({ input: 700, output: 140, replies: 3 });
  });

  it('counts appended lines once, and only the new ones', () => {
    const { root, file } = scratch();
    const now = Date.now();
    writeFileSync(file, reply('a', new Date(now - 60_000), { input: 10 }));

    const meter = new UsageMeter(root);
    expect(meter.report(now).hour.replies).toBe(1);

    // Re-reporting must not double count what it already consumed.
    expect(meter.report(now).hour.replies).toBe(1);

    appendFileSync(file, reply('b', new Date(now - 30_000), { input: 10 }));
    expect(meter.report(now).hour.replies).toBe(2);
  });

  it('leaves a half-written final line for the next pass', () => {
    const { root, file } = scratch();
    const now = Date.now();
    writeFileSync(file, reply('a', new Date(now - 60_000)) + '{"type":"assistant","uuid":"b","times');

    const meter = new UsageMeter(root);
    expect(meter.report(now).hour.replies).toBe(1);

    // Completing the line makes it count, and it is not lost or duplicated.
    writeFileSync(file, reply('a', new Date(now - 60_000)) + reply('b', new Date(now - 50_000)));
    expect(meter.report(now).hour.replies).toBe(2);
  });

  it('ignores anything that is not an assistant reply with usage', () => {
    const { root, file } = scratch();
    const now = Date.now();
    writeFileSync(file,
      JSON.stringify({ type: 'user', uuid: 'u', timestamp: new Date(now).toISOString() }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'n', timestamp: new Date(now).toISOString(), message: {} }) + '\n' +
      'not json at all\n' +
      reply('a', new Date(now - 60_000)));

    expect(new UsageMeter(root).report(now).hour.replies).toBe(1);
  });

  it('does not count a negative or non-numeric token field', () => {
    const { root, file } = scratch();
    const now = Date.now();
    writeFileSync(file, JSON.stringify({
      type: 'assistant', uuid: 'a', timestamp: new Date(now - 60_000).toISOString(),
      message: { model: 'm', usage: { input_tokens: -5, output_tokens: 'lots', cache_read_input_tokens: 7 } },
    }) + '\n');

    const r = new UsageMeter(root).report(now);
    expect(r.hour).toMatchObject({ input: 0, output: 0, cacheRead: 7 });
  });

  it('reports empty rather than throwing when there are no transcripts', () => {
    const root = mkdtempSync(join(tmpdir(), 'tulip-usage-'));
    roots.push(root);
    const r = new UsageMeter(join(root, 'missing')).report(Date.now());
    expect(r.week).toMatchObject({ input: 0, output: 0, replies: 0 });
    expect(r.models).toEqual([]);
  });

  it('ranks models by total tokens', () => {
    const { root, file } = scratch();
    const now = Date.now();
    const other = JSON.stringify({
      type: 'assistant', uuid: 'z', timestamp: new Date(now - 60_000).toISOString(),
      message: { model: 'glm-5.3-flash', usage: { input_tokens: 9000, output_tokens: 0 } },
    }) + '\n';
    writeFileSync(file, reply('a', new Date(now - 60_000), { input: 10 }) + other);

    const r = new UsageMeter(root).report(now);
    expect(r.models[0]).toMatchObject({ name: 'glm-5.3-flash' });
    expect(r.models).toHaveLength(2);
  });
});
