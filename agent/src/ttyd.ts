/**
 * The real terminal, served over a UNIX socket.
 *
 * The panel used to render the pane from a byte stream the agent wrote to a
 * file. That works and it is not a terminal: no PTY, so no resize, no mouse, no
 * scrollback of its own, and input arrives as injected keys rather than
 * keystrokes. ttyd gives the genuine article, and it is what the council wall's
 * component is built around — reusing that component means having this.
 *
 * **A socket, never a port, and that is the entire security argument.** ttyd
 * listens on the outbound handoff volume, which both containers already mount;
 * the bridge connects to it. The direction is what matters: the agent gains no
 * way to dial the bridge, and this container keeps `internal: true` with no
 * route, no published port and no DNS. A terminal was added without adding a
 * network.
 *
 * What it does cost, stated rather than waved away: the bridge's proxy now
 * parses bytes an untrusted process chose. That is a real surface. It is much
 * smaller than a routable network — the agent cannot initiate, cannot reach
 * anything else in the bridge, and still cannot see the WhatsApp credentials.
 *
 * There is no authentication here. ttyd on a socket is reachable only through
 * the bridge, which is what the panel's token gates — including on the
 * WebSocket upgrade, which bypasses the ordinary request path and is the
 * sharpest edge in the version of this iris runs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { outPaths } from '@tulip/shared';
import { log } from './log.js';
import { SESSION } from './tmux.js';

/** Long enough that a crash loop is visible in the log rather than a busy wait. */
const RESTART_MS = 3000;

let child: ChildProcess | null = null;
let stopping = false;

function args(): string[] {
  return [
    // The socket, in place of a port. `-i` takes either; this is the choice
    // that keeps the agent off the network.
    '-i', outPaths.ttyd,
    // Writable, because taking over a conversation from the panel is the point.
    // Read-only would make this a nicer version of what it replaces.
    '-W',
    // ttyd's own "are you sure you want to leave" prompt fires inside an iframe
    // the panel controls, where it is noise rather than a safeguard.
    '-t', 'disableLeaveAlert=true',
    // No reconnect banner: the panel decides when the frame is mounted.
    '-t', 'disableReconnect=false',
    // Attach to the session rather than a window. Which window is shown follows
    // tmux's active window, which the supervisor selects — so following the
    // busy chat costs a `select-window` rather than a restart.
    'tmux', 'attach', '-t', SESSION,
  ];
}

/**
 * Start ttyd, and keep it started.
 *
 * A stale socket file left by an unclean exit stops the next bind, so it is
 * removed first — safe because only ttyd ever writes it, and only one ttyd runs.
 */
export function startTtyd(): void {
  if (stopping || child !== null) return;
  try {
    if (existsSync(outPaths.ttyd)) rmSync(outPaths.ttyd, { force: true });
  } catch {
    /* if it cannot be removed the bind fails and the restart loop reports it */
  }

  const proc = spawn('ttyd', args(), { stdio: ['ignore', 'ignore', 'pipe'] });
  child = proc;

  proc.stderr?.on('data', (chunk: Buffer) => {
    // ttyd is chatty on stderr; only the lines that mean it failed are worth a
    // log entry, and they are the ones nobody would otherwise see.
    const line = chunk.toString('utf8').trim();
    if (/error|failed|cannot|unable/i.test(line)) log('ttyd.stderr', { line: line.slice(0, 200) });
  });

  proc.on('exit', (code) => {
    child = null;
    if (stopping) return;
    log('ttyd.exited', { code, note: 'restarting' });
    setTimeout(startTtyd, RESTART_MS).unref();
  });

  proc.on('error', (err) => {
    child = null;
    if (stopping) return;
    log('ttyd.spawnFailed', { err: String(err.message) });
    setTimeout(startTtyd, RESTART_MS).unref();
  });

  log('ttyd.started', { socket: outPaths.ttyd });
}

/** For a clean shutdown. The socket goes with it, so the next start can bind. */
export function stopTtyd(): void {
  stopping = true;
  child?.kill('SIGTERM');
  child = null;
  try {
    rmSync(outPaths.ttyd, { force: true });
  } catch {
    /* nothing to remove */
  }
}
