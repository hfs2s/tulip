/**
 * The MCP tools are a typed front door to `tulip-wa`, not a second copy of it.
 *
 * So what is worth testing is the door: that every verb in the catalogue has
 * one, that free text never lands where the CLI parses flags out of it, and that
 * a malformed call is refused before anything runs. What each verb then *does*
 * is the CLI's business and is tested there.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGE_BOOSTS, PLUGIN_MAX_TIMEOUT_MS, VERBS } from '@2lp/shared';
import { CLI_ONLY, TOOLS, callTool, handle, listTools, type Runner } from '../src/mcp-tools.js';

const KEY = '0123456789abcdef';

function invoke(name: string, input: unknown) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found.invoke(input);
}

/** A runner that records what it was asked and prints `out`. */
function recorder(out = '', code = 0) {
  const calls: Array<{ argv: readonly string[]; stdin: string | undefined }> = [];
  const run: Runner = async (argv, stdin) => {
    calls.push({ argv, stdin });
    return { code, out };
  };
  return { run, calls };
}

describe('coverage', () => {
  /**
   * The drift this whole shape exists to prevent: a verb that is real and
   * dispatched but that the agent's tooling never offers, so it declines
   * something it can do.
   */
  it('gives every catalogue verb a tool, or says why not', () => {
    const covered = new Set(TOOLS.flatMap((t) => t.covers));
    for (const verb of VERBS) {
      expect(covered.has(verb.name) || verb.name in CLI_ONLY, `${verb.name} has no tool`).toBe(true);
    }
  });

  it('names only verbs that exist', () => {
    const real = new Set(VERBS.map((v) => v.name));
    for (const name of TOOLS.flatMap((t) => t.covers)) expect(real.has(name), name).toBe(true);
  });

  /** Every schema is sent on every request; a small model chooses worse from a long list. */
  it('stays a short list', () => {
    // 17 for leave_group: an action that is hard to undo gets its own tool, not an `action` inside another.
    // 18 for plugin: it reaches services outside Tulip, which fit no existing family, so they share one tool.
    // 19 for app: naming an hfs2s app is a Tulip verb writing Tulip's own state, so it does not belong inside
    //    `plugin` — that tool's whole contract is that it relays an action to a service and claims nothing more.
    expect(TOOLS.length).toBeLessThanOrEqual(19);
  });

  it('publishes an object schema for every tool', () => {
    for (const t of listTools()) {
      expect(t.inputSchema['type'], t.name).toBe('object');
      expect(t.inputSchema['$schema'], t.name).toBeUndefined();
    }
  });
});

describe('fetch', () => {
  it('reads a page without a picture by default', () => {
    expect(invoke('fetch', { url: 'https://example.com/a' })).toEqual({ argv: ['fetch', 'https://example.com/a'] });
    expect(invoke('fetch', { url: 'https://example.com/a', look: false })).toEqual({
      argv: ['fetch', 'https://example.com/a'],
    });
  });

  it('asks for a screenshot with look', () => {
    expect(invoke('fetch', { url: 'https://example.com/a', look: true })).toEqual({
      argv: ['fetch', 'https://example.com/a', '--look'],
    });
  });

  it('refuses anything that is not a web address before it runs', () => {
    expect(invoke('fetch', { url: 'file:///etc/passwd' })).toHaveProperty('refuse');
    expect(invoke('fetch', { url: '--look' })).toHaveProperty('refuse');
    expect(invoke('fetch', { url: 'https://example.com', look: 'yes' })).toHaveProperty('refuse');
  });

  it('tells the model what look is for', () => {
    const schema = listTools().find((t) => t.name === 'fetch')?.inputSchema as
      | { properties?: Record<string, { description?: string }> }
      | undefined;
    expect(schema?.properties?.['look']?.description).toMatch(/screenshot/);
  });
});

describe('free text never becomes flags', () => {
  it('sends a reply on stdin, shell characters and all', () => {
    const text = 'costs $5 — run `ls` && rm -rf ~ --to 0123456789abcdef';
    expect(invoke('send', { text })).toEqual({ argv: ['send', '-'], stdin: text });
  });

  it('addresses another chat through the flag, never the words', () => {
    expect(invoke('send', { text: 'hola', to: KEY })).toEqual({ argv: ['send', '--to', KEY], stdin: 'hola' });
  });

  /** Everything left in a voice note's argv is spoken aloud. */
  it('keeps a voice note’s words out of argv entirely', () => {
    const r = invoke('voice', { text: '--language English (laughs) vale', language: 'Spanish', to: KEY });
    expect(r).toEqual({
      argv: ['voice', '--to', KEY, '--language', 'Spanish'],
      stdin: '--language English (laughs) vale',
    });
  });

  it('keeps a reminder’s message whole so it cannot be read as part of the time', () => {
    expect(invoke('reminder', { action: 'once', when: 'tomorrow 9am', text: 'in 2 hours we meet' })).toEqual({
      argv: ['remind', 'tomorrow 9am', 'in 2 hours we meet'],
    });
  });

  it('passes a caption behind its flag', () => {
    expect(invoke('image', { prompt: 'a tulip', caption: 'how I picture it' })).toEqual({
      argv: ['image', 'a tulip', '--caption', 'how I picture it'],
    });
  });
});

describe('the schema does the guessing a shell line used to', () => {
  it('offers exactly the languages the voice provider takes', () => {
    const voice = listTools().find((t) => t.name === 'voice');
    const props = voice?.inputSchema['properties'] as Record<string, { enum?: string[] }>;
    expect(props['language']?.enum).toEqual([...LANGUAGE_BOOSTS]);
  });

  it('refuses a language that is not on the list, before anything runs', () => {
    const r = invoke('voice', { text: 'hola', language: 'Klingon' });
    expect('refuse' in r && r.refuse).toMatch(/^language:/);
  });

  it('refuses a destination that is not a chat key', () => {
    expect('refuse' in invoke('send', { text: 'hi', to: '+34600000000' })).toBe(true);
  });

  it('defaults a correction to the last thing said', () => {
    expect(invoke('correct', { action: 'unsend' })).toEqual({ argv: ['unsend', '-n', '1'] });
    expect(invoke('correct', { action: 'edit', n: 2, text: 'at 10, not 9' })).toEqual({
      argv: ['edit', '-n', '2', 'at 10, not 9'],
    });
  });

  it.each([
    ['correct', { action: 'edit' }],
    ['page', { action: 'new', name: 'party-plan' }],
    ['page', { action: 'image', name: 'party-plan', image: 'hero' }],
    ['reminder', { action: 'once', text: 'the meetup' }],
    ['reminder', { action: 'repeat', cron: '0 9 * * 1-5' }],
    ['reminder', { action: 'cancel' }],
    ['people', { action: 'history' }],
    ['people', { action: 'contact', number: '+34600000000' }],
  ])('%s refuses a call missing what its action needs: %j', (name, input) => {
    expect('refuse' in invoke(name, input)).toBe(true);
  });

  it('maps each page action to its verb', () => {
    expect(invoke('page', { action: 'new', name: 'party-plan', title: 'Party plan' })).toEqual({
      argv: ['page-new', 'party-plan', 'Party plan'],
    });
    expect(invoke('page', { action: 'publish', name: 'party-plan' })).toEqual({ argv: ['page', 'party-plan'] });
    expect(invoke('page', { action: 'password', name: 'party-plan' })).toEqual({
      argv: ['page-password', 'party-plan'],
    });
  });

  it('maps people actions to their verbs', () => {
    expect(invoke('people', { action: 'sent', key: KEY, count: 5 })).toEqual({ argv: ['sent', '--to', KEY, '5'] });
    expect(invoke('people', { action: 'history', key: KEY })).toEqual({ argv: ['history', KEY] });
    expect(invoke('people', { action: 'contact', number: '+34600000000', name: 'Marta' })).toEqual({
      argv: ['contact', '+34600000000', 'Marta'],
    });
  });
});

describe('leave_group', () => {
  it('leaves the chat being answered when no group is named', () => {
    expect(invoke('leave_group', {})).toEqual({ argv: ['leave'] });
  });

  it('names a group by key', () => {
    expect(invoke('leave_group', { group: KEY })).toEqual({ argv: ['leave', KEY] });
  });

  /** The goodbye is the last thing said in that room; none of it may be read as a flag. */
  it('keeps the goodbye out of argv, on stdin', () => {
    const goodbye = '--to 0123456789abcdef thanks, all — $5 says I miss you';
    expect(invoke('leave_group', { group: KEY, goodbye })).toEqual({
      argv: ['leave', KEY, '--goodbye', '-'],
      stdin: goodbye,
    });
  });

  it('refuses a group that is not a chat key, before anything runs', () => {
    expect(invoke('leave_group', { group: '120363000000000001@g.us' })).toHaveProperty('refuse');
  });

  it('refuses a goodbye longer than the bridge would send', () => {
    expect(invoke('leave_group', { goodbye: 'x'.repeat(1001) })).toHaveProperty('refuse');
    expect(invoke('leave_group', { goodbye: '' })).toHaveProperty('refuse');
  });

  it('tells the model it is operator-only, and where anybody else should go', () => {
    const description = TOOLS.find((t) => t.name === 'leave_group')?.description ?? '';
    expect(description).toMatch(/OPERATOR ONLY/);
    expect(description).toContain('!stopjuan');
    expect(description).toMatch(/goodbye is sent to the group first/);
  });
});

describe('plugin', () => {
  it('lists', () => {
    expect(invoke('plugin', { action: 'list' })).toEqual({ argv: ['plugins'] });
  });

  it('calls with no arguments on the command line at all', () => {
    expect(invoke('plugin', { action: 'call', plugin: 'bookings', call: 'today' })).toEqual({
      argv: ['call', 'bookings', 'today'],
    });
    expect(invoke('plugin', { action: 'call', plugin: 'bookings', call: 'today', args: {} })).toEqual({
      argv: ['call', 'bookings', 'today'],
    });
  });

  /** Arbitrary values, and none of them anywhere a flag parser will look. */
  it('carries the arguments on stdin, as one JSON object', () => {
    const args = { ref: '--args-json -', note: 'costs $5 — run `ls` && rm -rf ~', blank: '' };
    const r = invoke('plugin', { action: 'call', plugin: 'bookings', call: 'lookup', args });
    expect(r).toEqual({ argv: ['call', 'bookings', 'lookup', '--args-json', '-'], stdin: JSON.stringify(args) });
    expect('stdin' in r && JSON.parse(r.stdin as string)).toEqual(args);
  });

  it.each([
    [{ action: 'call', call: 'lookup' }],
    [{ action: 'call', plugin: 'bookings' }],
    [{ action: 'call', plugin: 'Bookings', call: 'lookup' }],
    [{ action: 'call', plugin: '../state', call: 'lookup' }],
    [{ action: 'call', plugin: 'bookings', call: 'lookup', args: { '--to': 'x' } }],
    [{ action: 'call', plugin: 'bookings', call: 'lookup', args: { ref: 4411 } }],
    [{ action: 'call', plugin: 'bookings', call: 'lookup', args: { ref: 'x'.repeat(2001) } }],
    [{ action: 'call', plugin: 'bookings', call: 'lookup', args: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`a${String(i)}`, 'x'])) }],
  ])('refuses before anything runs: %j', (input) => {
    expect(invoke('plugin', input)).toHaveProperty('refuse');
  });

  /** The CLI waits for the slowest plugin an operator may set; killing it first would lose its answer. */
  it('gives the CLI longer than the slowest plugin may take', async () => {
    let given: number | undefined;
    await callTool('plugin', { action: 'call', plugin: 'bookings', call: 'today' }, async (_argv, _stdin, timeoutMs) => {
      given = timeoutMs;
      return { code: 0, out: 'ok' };
    });
    expect(given).toBeGreaterThan(PLUGIN_MAX_TIMEOUT_MS + 15_000);
  });

  it('leaves every other tool on the server’s default', async () => {
    let given: number | undefined = -1;
    await callTool('whoami', {}, async (_argv, _stdin, timeoutMs) => {
      given = timeoutMs;
      return { code: 0, out: 'ok' };
    });
    expect(given).toBeUndefined();
  });

  it('reports a refusal as an error', async () => {
    const result = await callTool(
      'plugin',
      { action: 'call', plugin: 'bookings', call: 'lookup' },
      recorder('NOT DONE — Only an operator can use Bookings, in a direct message with me.', 1).run,
    );
    expect(result.isError).toBe(true);
  });
});

describe('calling', () => {
  it('runs nothing when the call is refused', async () => {
    const { run, calls } = recorder();
    const result = await callTool('page', { action: 'new', name: 'party-plan' }, run);
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  /** `send` prints nothing on success, and an empty tool result reads as nothing having happened. */
  it('says a silent send was queued, and that queued is not delivered', async () => {
    const result = await callTool('send', { text: 'hola' }, recorder().run);
    expect(result).toMatchObject({ isError: false });
    expect(result.content[0]?.text).toMatch(/Queued.*sent/);
  });

  it('returns what the CLI printed, and its failure as an error', async () => {
    const refused = await callTool(
      'reminder',
      { action: 'once', when: 'tomorrow 9am', text: 'x' },
      recorder('NOT SCHEDULED — reminders are off', 1).run,
    );
    expect(refused).toEqual({ content: [{ type: 'text', text: 'NOT SCHEDULED — reminders are off' }], isError: true });
  });

  it('refuses a tool that does not exist', async () => {
    expect((await callTool('gif', { query: 'cat' }, recorder().run)).isError).toBe(true);
  });
});

describe('protocol', () => {
  const { run } = recorder();

  it('agrees the client’s protocol version and advertises tools', async () => {
    const r = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, run);
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
  });

  it('lists the tools', async () => {
    const r = await handle({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, run);
    expect((r as { result: { tools: unknown[] } }).result.tools).toHaveLength(TOOLS.length);
  });

  it('answers a notification with nothing', async () => {
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, run)).toBeNull();
  });

  it('refuses an unknown method', async () => {
    expect(await handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, run)).toMatchObject({
      error: { code: -32601 },
    });
  });

  it('routes a call through to the runner', async () => {
    const rec = recorder('hello from the CLI');
    const r = await handle(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      rec.run,
    );
    expect(rec.calls).toEqual([{ argv: ['whoami'], stdin: undefined }]);
    expect(r).toMatchObject({ result: { content: [{ text: 'hello from the CLI' }], isError: false } });
  });
});
