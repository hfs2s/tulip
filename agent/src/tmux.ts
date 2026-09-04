/**
 * tmux, as a typed surface.
 *
 * The agent is a real Claude Code session in a terminal, exactly as in Iris —
 * an operator can `docker compose exec` in and attach, take over a conversation
 * mid-turn, and type at the prompt themselves. That is worth keeping, and it is
 * why the driver talks to a TUI rather than to an SDK.
 *
 * **Target syntax.** `=name` is an exact *session* match and is valid only
 * where tmux expects a session (`has-session`, `kill-session`). Pane commands —
 * `send-keys`, `capture-pane` — want a pane, where `=name` is read as a *pane*
 * name and fails with "can't find pane". Getting this wrong is not a syntax
 * error, it is a silent match against the wrong target: without the `=`, `-t`
 * falls back to matching by name *prefix*, so a target meant for one window can
 * land on another whose name merely starts the same way. Every target built
 * here is fully qualified, `session:window`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The one tmux session; each chat gets a window inside it. */
export const SESSION = 'tulip';

export interface TmuxResult {
  ok: boolean;
  stdout: string;
}

async function tmux(args: readonly string[]): Promise<TmuxResult> {
  try {
    const { stdout } = await run('tmux', [...args], { maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** A fully qualified pane target: this session, this window, its active pane. */
export const paneTarget = (window: string): string => `${SESSION}:${window}`;

export async function serverRunning(): Promise<boolean> {
  return (await tmux(['has-session', '-t', `=${SESSION}`])).ok;
}

/** Every window in the session, in tmux's own order. */
export async function listWindows(): Promise<string[]> {
  const result = await tmux(['list-windows', '-t', `=${SESSION}`, '-F', '#{window_name}']);
  if (!result.ok) return [];
  return result.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

export async function windowExists(window: string): Promise<boolean> {
  const result = await tmux(['list-windows', '-t', `=${SESSION}`, '-F', '#{window_name}']);
  if (!result.ok) return false;
  return result.stdout.split('\n').some((line) => line.trim() === window);
}

/**
 * Create the session, or a window inside it, running `command`.
 *
 * The window is sized explicitly and pinned. A tmux window defaults to
 * `window-size latest`, which lets any attaching client reflow it — and the
 * supervisor reads this pane to decide whether a turn is running, so a reflow
 * triggered by an operator opening a terminal would change what the parser
 * sees. `window-size` is a *window* option; setting it with a session target
 * fails with "no such window", which is why the target here is `session:window`.
 */
export async function spawnWindow(
  window: string,
  cwd: string,
  command: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<boolean> {
  // Per-window environment, not per-session. `tulip-wa` and the hooks read
  // TULIP_CHAT_DIR to find out which conversation they belong to, and it has to
  // stay correct after the agent changes directory — which it will.
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const started = (await serverRunning())
    ? await tmux(['new-window', '-d', '-t', `=${SESSION}`, '-n', window, '-c', cwd, ...envArgs, ...command])
    : await tmux([
        'new-session', '-d', '-s', SESSION, '-n', window, '-c', cwd,
        '-x', '200', '-y', '50', ...envArgs, ...command,
      ]);
  if (!started.ok) return false;

  await tmux(['set-option', '-w', '-t', paneTarget(window), 'window-size', 'manual']);
  await tmux(['resize-window', '-t', paneTarget(window), '-x', '200', '-y', '50']);
  await tmux(['set-option', '-t', `=${SESSION}`, 'history-limit', '20000']);
  return true;
}

export async function killWindow(window: string): Promise<void> {
  await tmux(['kill-window', '-t', paneTarget(window)]);
}

/** The last `lines` of a window's pane. Empty string if it is not there. */
export async function capture(window: string, lines = 40): Promise<string> {
  const result = await tmux(['capture-pane', '-p', '-t', paneTarget(window), '-S', `-${lines}`]);
  return result.stdout;
}

/**
 * The last `lines` of a pane *with its escape sequences intact*.
 *
 * `capture` strips them, which is correct for the supervisor's parser — it
 * matches on text and an escape sequence in the middle of a word would break
 * it — and wrong for anything that has to look like the session. `-e` keeps
 * colour, attributes and cursor positioning, so a viewer arriving mid-session
 * can be painted once before the live stream takes over.
 */
export async function captureAnsi(window: string, lines = 50): Promise<string> {
  const result = await tmux(['capture-pane', '-p', '-e', '-t', paneTarget(window), '-S', `-${lines}`]);
  return result.stdout;
}

/**
 * Stream a pane's output to a file, live.
 *
 * `-o` is what makes this safe to call on every tick: tmux opens a pipe only if
 * that pane does not already have one, so repeated calls are free and a pane
 * that was replaced gets its pipe back without any bookkeeping here.
 *
 * The command runs inside this container as a child of the tmux server, and
 * appends to the outbound volume. Note which direction that is: the bridge
 * *reads a file the agent wrote*, exactly as it does for actions and status. No
 * socket is opened, no port is published, and the bridge gains no route to this
 * pane — which is the property the whole two-container split exists to keep.
 */
export async function startPipe(window: string, file: string): Promise<void> {
  await tmux(['pipe-pane', '-o', '-t', paneTarget(window), `cat >> ${JSON.stringify(file)}`]);
}

/** Stop streaming. `pipe-pane` with no command closes the pane's pipe. */
export async function stopPipe(window: string): Promise<void> {
  await tmux(['pipe-pane', '-t', paneTarget(window)]);
}

/**
 * Type a line and submit it.
 *
 * `-l` sends the text literally, so quotes, emoji and anything else in the
 * line cannot be interpreted as a key name. The line is only ever a short
 * pointer to a file — the sender's actual text never goes through `send-keys`,
 * which is what stops a multi-line message submitting itself halfway through.
 */
export async function sendLine(window: string, line: string): Promise<void> {
  await tmux(['send-keys', '-t', paneTarget(window), '-l', line]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await tmux(['send-keys', '-t', paneTarget(window), 'Enter']);
}

/**
 * Type text without submitting it.
 *
 * `sendLine` appends an Enter, which is right for the supervisor's prompt — a
 * pointer to a batch file, typed and submitted in one move — and wrong for an
 * operator at a keyboard, where Enter is a keystroke they make themselves. A
 * terminal that submitted on every character would be unusable.
 */
export async function sendText(window: string, text: string): Promise<void> {
  await tmux(['send-keys', '-t', paneTarget(window), '-l', text]);
}

export async function sendKey(window: string, key: string): Promise<void> {
  await tmux(['send-keys', '-t', paneTarget(window), key]);
}
