/**
 * What a result says, decided against a fake Chromium — and the real process
 * handling, decided against real processes.
 *
 * The second half matters more than it looks. On the Pi there is no memory
 * cgroup, so the deadline and the process-group kill are the controls that
 * actually protect the host. They are tested with `sh` standing in for
 * Chromium: the thing being checked is that a child *and its children* are
 * gone when the deadline passes, and that does not need a browser.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG_MAGIC, type BrowseRequest } from '@2lp/shared/browse';
import { chromiumArgs, runChromium, type RunChromium, type RunResult } from '../src/chromium.js';
import { classify, openPage } from '../src/page.js';

const ID = '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b';
const PNG = Buffer.concat([PNG_MAGIC, Buffer.from('rest of a png')]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tulip-browser-'));
  dirs.push(dir);
  return dir;
}

function ran(partial: Partial<RunResult> = {}): RunResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    overflow: false,
    spawnError: null,
    ...partial,
  };
}

/** A Chromium that answers the DOM run with `dom` and writes `picture` for the screenshot run. */
function fake(dom: RunResult, picture?: Buffer): { run: RunChromium; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunChromium = async (_bin, args) => {
    calls.push([...args]);
    const flag = args.find((a) => a.startsWith('--screenshot='));
    if (flag !== undefined) {
      if (picture !== undefined) writeFileSync(flag.slice('--screenshot='.length), picture);
      return ran();
    }
    return dom;
  };
  return { run, calls };
}

const request = (screenshot = false): BrowseRequest => ({ id: ID, url: 'https://example.com/', screenshot });
const deps = (run: RunChromium, tmpDir: string) => ({
  run,
  bin: '/usr/lib/chromium/chromium',
  proxy: 'http://172.31.241.10:3128',
  tmpDir,
});

const PAGE = '<html><head><title>Example</title></head><body><p>Hello from the page</p></body></html>';

describe('openPage — a page', () => {
  it('returns the title and text, runs once, and leaves no profile behind', async () => {
    const tmp = scratch();
    const { run, calls } = fake(ran({ stdout: PAGE }));
    const { result, screenshot } = await openPage(request(), deps(run, tmp));

    expect(result).toMatchObject({
      id: ID,
      ok: true,
      failure: null,
      title: 'Example',
      text: 'Hello from the page',
      screenshot: false,
    });
    expect(screenshot).toBeNull();
    expect(calls).toHaveLength(1);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('takes a picture in a second run when asked, and returns it when it is a PNG', async () => {
    const tmp = scratch();
    const { run, calls } = fake(ran({ stdout: PAGE }), PNG);
    const { result, screenshot } = await openPage(request(true), deps(run, tmp));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.some((a) => a.startsWith('--screenshot='))).toBe(true);
    expect(result.screenshot).toBe(true);
    expect(screenshot?.equals(PNG)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('keeps the text and drops a picture that is not a PNG', async () => {
    const { run } = fake(ran({ stdout: PAGE }), Buffer.from('GIF89a not a png'));
    const { result, screenshot } = await openPage(request(true), deps(run, scratch()));
    expect(result.ok).toBe(true);
    expect(result.screenshot).toBe(false);
    expect(screenshot).toBeNull();
  });

  it('keeps the text when the picture never appears', async () => {
    const { run } = fake(ran({ stdout: PAGE }));
    const { result } = await openPage(request(true), deps(run, scratch()));
    expect(result).toMatchObject({ ok: true, screenshot: false, text: 'Hello from the page' });
  });

  it('is not fooled by a page that merely mentions a network error', async () => {
    const { run } = fake(ran({ stdout: '<body><p>If you see ERR_CONNECTION_REFUSED, restart.</p></body>' }));
    const { result } = await openPage(request(), deps(run, scratch()));
    expect(result.ok).toBe(true);
  });
});

describe('openPage — failures are codes', () => {
  /**
   * Shaped like Chromium 152's network error page, trimmed from a real one —
   * including the comment that names ERR_INTERNET_DISCONNECTED *before* the
   * real code, which is what the first version of this reported.
   */
  const netErrorPage = (code: string): string =>
    '<html dir="ltr" lang="en"><head><title>localhost</title>' +
    '<script>// Some errors (in C++, such as net::ERR_INTERNET_DISCONNECTED) result in the dino game</script></head>' +
    `<body class="neterror" style="font-family: sans"><div id="main-frame-error" class="interstitial-wrapper">` +
    `<div class="error-code"><!--?lit$264405225$-->${code}</div></div>` +
    `<script>var loadTimeDataRaw = {"details":"Details","errorCode":"${code}","fontfamily":"sans"};</script></body></html>`;

  /** And its certificate warning, which arrives as a page titled "Privacy error". */
  const certificatePage = (code: string): string =>
    '<html dir="ltr" lang="en"><head><title>Privacy error</title></head><body id="body" class="ssl">' +
    '<div class="interstitial-wrapper"><div id="main-content"><h1>Your connection is not private</h1></div>' +
    `<div class="error-code" role="button" aria-expanded="false">net::${code}</div></div>` +
    `<script>var loadTimeDataRaw = {"errorCode":"net::${code}","heading":"Your connection is not private"};</script>` +
    '</body></html>';

  it.each([
    ['a tunnel the proxy refused', ran({ stdout: netErrorPage('ERR_TUNNEL_CONNECTION_FAILED') }), 'unreachable', 'ERR_TUNNEL_CONNECTION_FAILED'],
    ['a certificate warning', ran({ stdout: certificatePage('ERR_CERT_DATE_INVALID') }), 'certificate', 'ERR_CERT_DATE_INVALID'],
    ['the proxy itself down', ran({ stdout: netErrorPage('ERR_PROXY_CONNECTION_FAILED') }), 'proxy-down', 'ERR_PROXY_CONNECTION_FAILED'],
    ['an error page with no readable code', ran({ stdout: '<body class="neterror"><div id="main-frame-error"></div></body>' }), 'error-page', null],
    ['an error page whose code is only on screen', ran({ stdout: '<body class="neterror"><div id="main-frame-error"><div class="error-code">ERR_NAME_NOT_RESOLVED</div></div></body>' }), 'unreachable', 'ERR_NAME_NOT_RESOLVED'],
    ['no page, reason on stderr', ran({ stderr: 'ERROR: net::ERR_NAME_NOT_RESOLVED at …' }), 'unreachable', 'ERR_NAME_NOT_RESOLVED'],
    ['no page, no reason', ran({ code: 1 }), 'crashed', null],
    ['the deadline', ran({ timedOut: true, stdout: '<p>half a page' }), 'timeout', null],
    ['a binary that will not start', ran({ spawnError: 'ENOENT' }), 'crashed', null],
  ])('reports %s', async (_label, dom, failure, netError) => {
    const { run, calls } = fake(dom, PNG);
    const { result, screenshot } = await openPage(request(true), deps(run, scratch()));
    expect(result).toMatchObject({ ok: false, failure, netError, text: '', title: '', screenshot: false });
    expect(screenshot).toBeNull();
    // A failed page is not photographed.
    expect(calls).toHaveLength(1);
  });
});

describe('classify', () => {
  it.each([
    [null, 'error-page'],
    ['ERR_PROXY_CONNECTION_FAILED', 'proxy-down'],
    ['ERR_SSL_PROTOCOL_ERROR', 'certificate'],
    ['ERR_CERT_AUTHORITY_INVALID', 'certificate'],
    ['ERR_CONNECTION_RESET', 'unreachable'],
    ['ERR_TIMED_OUT', 'unreachable'],
    ['ERR_BLOCKED_BY_CLIENT', 'error-page'],
  ])('%s is %s', (code, expected) => {
    expect(classify(code)).toBe(expected);
  });
});

describe('chromiumArgs', () => {
  const args = chromiumArgs({ proxy: 'http://172.31.241.10:3128', userDataDir: '/tmp/p', url: 'https://example.com/' });

  it('puts the URL last, after every flag', () => {
    expect(args.at(-1)).toBe('https://example.com/');
    expect(args.at(-2)).toBe('--dump-dom');
  });

  it('sends everything, loopback included, through the proxy', () => {
    expect(args).toContain('--proxy-server=http://172.31.241.10:3128');
    expect(args).toContain('--proxy-bypass-list=<-loopback>');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  });

  it('carries the memory caps', () => {
    expect(args).toContain('--js-flags=--max-old-space-size=256');
    expect(args).toContain('--renderer-process-limit=1');
  });

  /** Virtual time never advances past `next dev`'s open hot-reload socket. See chromium.ts. */
  it('bounds the load with --timeout, never with virtual time', () => {
    expect(args).toContain('--timeout=10000');
    expect(args.some((a) => a.startsWith('--virtual-time-budget'))).toBe(false);
  });

  it('takes a screenshot instead of dumping the DOM when given a path', () => {
    const shot = chromiumArgs({ proxy: 'http://p:1', userDataDir: '/tmp/p', url: 'https://x.test/', screenshotPath: '/tmp/s.png' });
    expect(shot).toContain('--screenshot=/tmp/s.png');
    expect(shot).not.toContain('--dump-dom');
  });
});

describe('runChromium — the process controls', () => {
  const env = { PATH: '/usr/bin:/bin' };

  it('collects stdout and the exit code', async () => {
    const r = await runChromium('/bin/sh', ['-c', 'echo hello'], { timeoutMs: 5000, maxStdout: 1000, env });
    expect(r).toMatchObject({ code: 0, stdout: 'hello\n', timedOut: false, overflow: false, spawnError: null });
  });

  it('kills the whole process group at the deadline, children included', async () => {
    const started = Date.now();
    const r = await runChromium('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 300, maxStdout: 1000, env });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);

    const orphan = Number(r.stdout.trim());
    expect(Number.isInteger(orphan) && orphan > 0).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(orphan, 0)).toThrow();
  });

  it('stops reading, and stops the process, at the output cap', async () => {
    const r = await runChromium('/bin/sh', ['-c', 'yes'], { timeoutMs: 5000, maxStdout: 1000, env });
    expect(r.overflow).toBe(true);
    expect(r.stdout).toHaveLength(1000);
    expect(r.timedOut).toBe(false);
  });

  it('reports a binary that is not there', async () => {
    const r = await runChromium('/nonexistent/chromium', [], { timeoutMs: 1000, maxStdout: 1000, env });
    expect(r.spawnError).toBe('ENOENT');
  });
});
