/**
 * Running Chromium, once per page, and making sure it stops.
 *
 * ── Why the limits are here and not in the compose file ─────────────────────
 *
 * The obvious protection for the host is `mem_limit`. **On the Pi this runs on
 * it does nothing**: Raspberry Pi OS ships with the memory cgroup controller
 * disabled, and Docker drops a limit it cannot enforce with a single warning
 * line at startup (THREAT-MODEL.md R6). A page that allocates without bound
 * would take the whole box — the bridge and the WhatsApp session with it. So
 * the controls that actually hold are ones this process applies itself:
 *
 *   - **One page at a time.** The loop in index.ts is serial by construction;
 *     there is never a second Chromium to add to the first.
 *   - **A hard kill.** `SIGKILL` to the whole process group at the deadline —
 *     not `SIGTERM`, which a wedged renderer can ignore, and not the browser
 *     process alone, which would leave its renderers running as orphans.
 *   - **A JavaScript heap cap** (`--max-old-space-size`) and one renderer
 *     (`--renderer-process-limit=1`). Neither bounds everything Chromium can
 *     allocate — images and layout live outside the V8 heap — but together they
 *     bound the part a hostile script controls directly.
 *
 * ── Why `--no-sandbox` ───────────────────────────────────────────────────────
 *
 * Chromium's sandbox needs either user namespaces or a setuid helper, and this
 * container has neither on purpose: `cap_drop: [ALL]`, `no-new-privileges`,
 * and every setuid bit stripped from the image. The container *is* the sandbox
 * — no route but a proxy that refuses private addresses, no DNS, a read-only
 * root, nothing on disk worth reading. A renderer exploit here gains exactly
 * what the page already had.
 *
 * ── Why `--timeout` and not `--virtual-time-budget` ─────────────────────────
 *
 * Virtual time was the first choice: it runs a page's timers ahead so a page
 * drawn by scripts is finished when the DOM is read. It does not work on the
 * pages this exists for. Virtual time only advances while no request is in
 * flight, and every app on hfs2s.app is served by `next dev`, which holds a
 * hot-reload connection open for as long as the page is open. Measured from
 * this container against the live sites: with a budget, the apps regularly
 * produced no DOM at all and were killed at the deadline — the operator's own
 * landing page included, on its second attempt — and adding `--timeout` did
 * not rescue them, because it does not bound virtual time. `--timeout` alone
 * reads the page at its load event, or stops loading at the limit and reads
 * whatever is there; it returned every one of them in under seven seconds. The
 * cost is that a page drawn entirely by scripts *after* its load event may be
 * read before it is drawn.
 *
 * Spawned with an argv array and no shell, always. The URL is the one argument
 * that came from outside, and it is the last one, after `--`-style flags have
 * all been given, so it cannot be read as a flag: the bridge and the request
 * schema both require it to begin with `https://`.
 */
import { spawn } from 'node:child_process';

export interface RunOptions {
  timeoutMs: number;
  /** Stop reading, and kill the browser, once stdout reaches this many bytes. */
  maxStdout: number;
  /** Kept for diagnosis only — a net error code when the DOM is empty. */
  maxStderr?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout hit `maxStdout` and was cut there. */
  overflow: boolean;
  /** The binary could not be started at all. */
  spawnError: string | null;
}

export type RunChromium = (bin: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

/** When Chromium stops loading and reads the page. See the header. */
export const LOAD_TIMEOUT_MS = 10_000;

export interface ArgsOptions {
  proxy: string;
  userDataDir: string;
  url: string;
  /** Present for the screenshot run: where Chromium writes the PNG. */
  screenshotPath?: string;
  userAgent?: string;
}

/**
 * The flags, in one place so a reviewer can read them as a list.
 *
 * `--proxy-bypass-list=<-loopback>` is the one that looks odd. Chromium
 * bypasses the proxy for localhost by default; that rule *removes* the
 * implicit bypass, so even a page asking for `https://localhost/` goes to the
 * proxy — which refuses it. Nothing listens on loopback in this container, but
 * the fewer paths that do not pass through the one control, the better.
 */
export function chromiumArgs(options: ArgsOptions): string[] {
  const args = [
    '--headless=new',
    '--no-sandbox',
    `--proxy-server=${options.proxy}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-component-update',
    '--disable-breakpad',
    '--mute-audio',
    '--hide-scrollbars',
    '--js-flags=--max-old-space-size=256',
    '--renderer-process-limit=1',
    `--user-data-dir=${options.userDataDir}`,
    // Stop loading here and read what there is. Well inside the hard kill, so
    // a slow page comes back as a slow page rather than as a timeout.
    `--timeout=${LOAD_TIMEOUT_MS}`,
    '--window-size=1280,1600',
  ];
  if (options.userAgent) args.push(`--user-agent=${options.userAgent}`);
  args.push(options.screenshotPath === undefined ? '--dump-dom' : `--screenshot=${options.screenshotPath}`);
  args.push(options.url);
  return args;
}

/** Kill a whole process group, tolerating one that has already gone. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export const runChromium: RunChromium = (bin, args, options) =>
  new Promise((resolve) => {
    const maxStderr = options.maxStderr ?? 16 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let settled = false;

    // `detached` makes the child the leader of a new process group, so the
    // deadline can kill it *and* every renderer it spawned with one signal.
    const child = spawn(bin, [...args], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? {},
      shell: false,
    });

    const finish = (partial: Partial<RunResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Reap stragglers. A renderer that outlives its browser is exactly the
      // memory this file exists to take back.
      killGroup(child.pid);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        overflow,
        spawnError: null,
        ...partial,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (overflow) return;
      stdout += chunk;
      if (stdout.length >= options.maxStdout) {
        stdout = stdout.slice(0, options.maxStdout);
        overflow = true;
        killGroup(child.pid);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxStderr) stderr = (stderr + chunk).slice(0, maxStderr);
    });

    child.once('error', (err) => finish({ spawnError: (err as NodeJS.ErrnoException).code ?? err.message }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
