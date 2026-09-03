import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Limiter, type LimiterOptions } from '../src/ratelimit.js';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const HOUR = 3_600_000;

const OPTIONS: LimiterOptions = {
  messagesPerHour: 20,
  burst: 5,
  turnsPerDay: 40,
  newSendersPerHour: 30,
  outboundPerChatPerHour: 60,
};

const KEY = 'aaaaaaaaaaaaaaaa';
const limiter = (over: Partial<LimiterOptions> = {}, file: string | null = null): Limiter =>
  new Limiter({ ...OPTIONS, ...over }, file);

const temporaries: string[] = [];
afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tulip-limiter-'));
  temporaries.push(dir);
  return join(dir, 'senders.json');
}

describe('Limiter — token bucket', () => {
  it('allows a burst and then refuses', () => {
    const limits = limiter();
    for (let i = 0; i < OPTIONS.burst; i++) {
      expect(limits.admitMessage(KEY, T0).ok).toBe(true);
    }
    const refused = limits.admitMessage(KEY, T0);
    expect(refused).toMatchObject({ ok: false, reason: 'sending too quickly' });
  });

  it('reports how long to wait, and honours it', () => {
    const limits = limiter();
    for (let i = 0; i < OPTIONS.burst; i++) limits.admitMessage(KEY, T0);

    const refused = limits.admitMessage(KEY, T0);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;

    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(limits.admitMessage(KEY, T0 + refused.retryAfterMs).ok).toBe(true);
  });

  it('refills at the configured rate', () => {
    const limits = limiter({ messagesPerHour: 60, burst: 1 });
    expect(limits.admitMessage(KEY, T0).ok).toBe(true);
    expect(limits.admitMessage(KEY, T0 + 30_000).ok).toBe(false); // half a minute
    expect(limits.admitMessage(KEY, T0 + 60_000).ok).toBe(true); // one minute
  });

  // Without a cap, a dormant account accumulates a month of allowance and can
  // spend it all at once — exactly the traffic shape the limiter exists to stop.
  it('caps accumulated allowance at the burst size', () => {
    const limits = limiter();
    limits.admitMessage(KEY, T0);

    const muchLater = T0 + 30 * 24 * HOUR;
    for (let i = 0; i < OPTIONS.burst; i++) {
      expect(limits.admitMessage(KEY, muchLater).ok).toBe(true);
    }
    expect(limits.admitMessage(KEY, muchLater).ok).toBe(false);
  });

  it('keeps separate allowances per sender', () => {
    const limits = limiter();
    for (let i = 0; i < OPTIONS.burst; i++) limits.admitMessage('aaaaaaaaaaaaaaaa', T0);
    expect(limits.admitMessage('aaaaaaaaaaaaaaaa', T0).ok).toBe(false);
    expect(limits.admitMessage('bbbbbbbbbbbbbbbb', T0).ok).toBe(true);
  });
});

describe('Limiter — daily turn budget', () => {
  it('refuses once the budget is spent', () => {
    const limits = limiter({ turnsPerDay: 3, messagesPerHour: 10_000, burst: 50 });
    for (let i = 0; i < 3; i++) limits.spendTurn(KEY, T0);

    expect(limits.admitMessage(KEY, T0)).toMatchObject({ ok: false, reason: 'daily limit reached' });
  });

  it('resets at UTC midnight', () => {
    const limits = limiter({ turnsPerDay: 1, messagesPerHour: 10_000, burst: 50 });
    limits.spendTurn(KEY, T0);
    expect(limits.admitMessage(KEY, T0).ok).toBe(false);

    const tomorrow = Date.UTC(2026, 0, 2, 0, 0, 1);
    expect(limits.admitMessage(KEY, tomorrow).ok).toBe(true);
  });

  it('points at the reset time when it refuses', () => {
    const limits = limiter({ turnsPerDay: 1, messagesPerHour: 10_000, burst: 50 });
    limits.spendTurn(KEY, T0);
    const refused = limits.admitMessage(KEY, T0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBe(Date.UTC(2026, 0, 2) - T0);
  });

  // A batch of five messages costs one model call. Charging five would punish
  // someone for typing the way people type.
  it('charges per turn, not per message', () => {
    const limits = limiter({ turnsPerDay: 2, messagesPerHour: 10_000, burst: 50 });
    for (let i = 0; i < 10; i++) expect(limits.admitMessage(KEY, T0).ok).toBe(true);
    limits.spendTurn(KEY, T0);
    expect(limits.admitMessage(KEY, T0).ok).toBe(true);
  });
});

describe('Limiter — new sender window', () => {
  it('refuses once too many unknown senders arrive in an hour', () => {
    const limits = limiter({ newSendersPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      expect(limits.admitMessage(`key${String(i).padStart(13, '0')}`, T0).ok).toBe(true);
    }
    expect(limits.admitMessage('keyoverflow00000', T0)).toMatchObject({
      ok: false,
      reason: 'too many first-time senders in the last hour',
    });
  });

  it('does not penalise senders it already knows', () => {
    const limits = limiter({ newSendersPerHour: 1 });
    limits.admitMessage(KEY, T0);
    limits.admitMessage('bbbbbbbbbbbbbbbb', T0); // trips the window
    expect(limits.admitMessage(KEY, T0 + 1000).ok).toBe(true);
  });

  it('slides, so the window recovers', () => {
    const limits = limiter({ newSendersPerHour: 2 });
    expect(limits.admitMessage('aaaaaaaaaaaaaaaa', T0).ok).toBe(true);
    expect(limits.admitMessage('bbbbbbbbbbbbbbbb', T0).ok).toBe(true);
    expect(limits.admitMessage('cccccccccccccccc', T0).ok).toBe(false);
    expect(limits.admitMessage('dddddddddddddddd', T0 + HOUR + 1).ok).toBe(true);
  });

  // A sender refused by the window must not be registered as a result, or one
  // refusal becomes a permanent exemption from the check.
  it('does not register a sender it refused', () => {
    const limits = limiter({ newSendersPerHour: 1 });
    limits.admitMessage('aaaaaaaaaaaaaaaa', T0);
    expect(limits.admitMessage('bbbbbbbbbbbbbbbb', T0).ok).toBe(false);
    expect(limits.isKnown('bbbbbbbbbbbbbbbb')).toBe(false);
    // Still inside the window, so the retry is refused too rather than waved
    // through as familiar traffic.
    expect(limits.admitMessage('bbbbbbbbbbbbbbbb', T0 + 1000).ok).toBe(false);
  });
});

describe('Limiter — outbound cap', () => {
  // This one bounds the agent rather than the user: a compromised or looping
  // agent is stopped here rather than after WhatsApp bans the number.
  it('refuses once the hourly outbound cap is reached', () => {
    const limits = limiter({ outboundPerChatPerHour: 3 });
    for (let i = 0; i < 3; i++) expect(limits.admitOutbound(KEY, T0).ok).toBe(true);
    expect(limits.admitOutbound(KEY, T0)).toMatchObject({ ok: false, reason: 'outbound hourly cap reached' });
  });

  it('resets on the hour boundary', () => {
    const limits = limiter({ outboundPerChatPerHour: 1 });
    limits.admitOutbound(KEY, T0);
    expect(limits.admitOutbound(KEY, T0).ok).toBe(false);
    expect(limits.admitOutbound(KEY, T0 + HOUR).ok).toBe(true);
  });
});

describe('Limiter — persistence', () => {
  // Restarting the bridge must not be a way to clear someone's limits.
  it('survives a restart', () => {
    const file = scratch();
    const first = limiter({}, file);
    for (let i = 0; i < OPTIONS.burst; i++) first.admitMessage(KEY, T0);
    expect(first.admitMessage(KEY, T0).ok).toBe(false);
    first.flush();

    const second = limiter({}, file);
    expect(second.admitMessage(KEY, T0).ok).toBe(false);
    expect(second.isKnown(KEY)).toBe(true);
  });

  it('carries the daily budget across a restart', () => {
    const file = scratch();
    const first = limiter({ turnsPerDay: 1, messagesPerHour: 10_000, burst: 50 }, file);
    first.spendTurn(KEY, T0);
    first.flush();

    const second = limiter({ turnsPerDay: 1, messagesPerHour: 10_000, burst: 50 }, file);
    expect(second.admitMessage(KEY, T0)).toMatchObject({ ok: false, reason: 'daily limit reached' });
  });

  it('starts empty rather than half-loading corrupt state', () => {
    const file = scratch();
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(file, '{"senders":{"x":{"tokens":"not a number"}}}');
    const limits = limiter({}, file);
    expect(limits.size).toBe(0);
    expect(limits.admitMessage(KEY, T0).ok).toBe(true);
  });

  it('tolerates an unreadable state file', () => {
    const limits = limiter({}, '/nonexistent/directory/senders.json');
    expect(limits.admitMessage(KEY, T0).ok).toBe(true);
    expect(() => limits.flush()).not.toThrow();
  });

  it('does nothing when no file is configured', () => {
    const limits = limiter();
    limits.admitMessage(KEY, T0);
    expect(() => limits.flush()).not.toThrow();
  });
});
