/**
 * The per-chat Claude Code session pool.
 *
 * One tmux window per conversation, capped and reaped, with session ids derived
 * from the chat key. The derivation is the whole resumability story, carried
 * over from Iris: nothing is stored, so killing the container, deleting the
 * pool's state or rebooting the host loses no context — the next message from
 * that chat runs `claude --resume <the same uuid>` because the id is a pure
 * function of inputs we still have.
 *
 * The cap is what makes per-chat isolation affordable. Sessions are cheap to
 * resume and expensive to keep resident, so at most `maxLive` windows exist at
 * once and the least recently used is closed to make room. A closed session is
 * not a lost one.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionUuidFor } from '@tulip/shared';
import { seedClaudeConfig } from './claude-config.js';
import { log } from './log.js';
import { capture, killWindow, sendKey, spawnWindow, windowExists } from './tmux.js';
import { ensureWorkspace, WORKSPACE_ROOT, type ChatWorkspace } from './workspace.js';

export interface Session {
  readonly chatKey: string;
  readonly window: string;
  readonly uuid: string;
  readonly workspace: ChatWorkspace;
  readonly startedAt: number;
  lastUsedAt: number;
  turns: number;
}

/** The idle TUI always shows one of these once it is ready for input. */
const READY = /bypass permissions on|\? for shortcuts|Try "|╭─+╮/;
/** Shown for exactly as long as a turn is running. */
const WORKING = /esc to interrupt/i;

/**
 * Dialogs that capture the keyboard.
 *
 * An unattended session has nobody to answer them, and while one is up every
 * keystroke — Enter included — goes to the dialog instead of the prompt. The
 * message ends up typed but never submitted, which looks exactly like a
 * delivered message that was simply ignored.
 */
const DIALOGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Is this a project you created or one you trust|Yes, I trust this folder/i, 'Enter'],
  [/How is Claude doing this session/i, '0'],
  // First-run onboarding. `claude-config.ts` answers these in the config file
  // before the spawn, which is deterministic; these patterns are the backstop
  // for a release that adds a screen the config does not cover. Accepting the
  // highlighted default is right for all of them — the questions are cosmetic.
  [/Choose the text style|Syntax theme:|Let's get started/i, 'Enter'],
  [/Press Enter to continue|to continue…/i, 'Enter'],
  // "Detected a custom API key in your environment — use it?" defaults to
  // "No (recommended)", so Enter is the wrong key: Up selects Yes first.
  // claude-config.ts pre-approves the key, making this the backstop.
  [/Detected a custom API key in your environment/i, 'Up'],
];

/**
 * States that accept input, look healthy, and fail every turn instantly. No
 * amount of retrying helps and only a human can clear them, so they are
 * reported rather than absorbed.
 */
const FATAL: ReadonlyArray<readonly [RegExp, string]> = [
  [/Login expired|Please run \/login|Invalid API key|authentication_error/i, 'Claude Code credentials are not valid'],
  [/Credit balance is too low|insufficient_quota/i, 'the Anthropic account is out of credit'],
  [/usage limit reached|rate.?limit/i, 'the Anthropic usage limit has been reached'],
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface PoolOptions {
  /** Windows resident at once. Beyond this, the least recently used is closed. */
  readonly maxLive: number;
  /** How long the TUI is given to draw before we type into it. */
  readonly readyTimeoutMs: number;
  /** Extra arguments for the `claude` invocation. */
  readonly claudeArgs: readonly string[];
  readonly model: string | null;
}

export class SessionPool {
  private readonly live = new Map<string, Session>();

  constructor(private readonly options: PoolOptions) {}

  list(): Session[] {
    return [...this.live.values()];
  }

  /**
   * Get the session for a chat, spawning or resuming it as needed.
   *
   * Returns null if the session could not be brought up; the caller reports
   * that rather than typing into a window that may not exist.
   */
  async acquire(chatKey: string, generation: number): Promise<Session | null> {
    const existing = this.live.get(chatKey);
    if (existing && (await windowExists(existing.window))) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    // The window is gone — the process died, or an operator closed it. Drop the
    // stale record and spawn again; the context is on disk under the same uuid.
    if (existing) this.live.delete(chatKey);

    await this.makeRoom();

    const workspace = ensureWorkspace(chatKey);
    // Before the spawn, every time: Claude Code rewrites its config on exit, so
    // a flag set once at boot can be gone by the next session.
    seedClaudeConfig(workspace.dir);
    const uuid = sessionUuidFor(chatKey, generation);
    const window = `c-${chatKey}`;
    const resuming = transcriptExists(uuid);

    const command = [
      'claude',
      ...(resuming ? ['--resume', uuid] : ['--session-id', uuid]),
      ...this.options.claudeArgs,
      ...(this.options.model === null ? [] : ['--model', this.options.model]),
    ];

    if (!(await spawnWindow(window, workspace.dir, command, { TULIP_CHAT_DIR: workspace.dir }))) {
      log('session.spawnFailed', { chatKey });
      return null;
    }

    const ready = await this.waitReady(window);
    log(resuming ? 'session.resumed' : 'session.spawned', { chatKey, ready, live: this.live.size + 1 });

    if (!ready) {
      // Typing into a half-drawn TUI loses characters. Tear it down so the next
      // attempt is a clean spawn rather than a window wedged on a dialog.
      log('session.readyTimeout', { chatKey, tail: (await capture(window, 12)).trim().slice(-300) });
      await killWindow(window);
      return null;
    }

    const session: Session = {
      chatKey,
      window,
      uuid,
      workspace,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      turns: 0,
    };
    this.live.set(chatKey, session);
    return session;
  }

  /** Close the least recently used session until there is room for one more. */
  private async makeRoom(): Promise<void> {
    while (this.live.size >= this.options.maxLive) {
      let oldest: Session | null = null;
      for (const session of this.live.values()) {
        if (oldest === null || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
      }
      if (oldest === null) return;
      log('session.evicted', {
        chatKey: oldest.chatKey,
        idleMs: Date.now() - oldest.lastUsedAt,
        note: 'context is on disk and resumes on the next message',
      });
      await killWindow(oldest.window);
      this.live.delete(oldest.chatKey);
    }
  }

  /** Close sessions idle for longer than `idleMs`. */
  async reap(idleMs: number): Promise<void> {
    const now = Date.now();
    for (const session of [...this.live.values()]) {
      if (now - session.lastUsedAt < idleMs) continue;
      log('session.reaped', { chatKey: session.chatKey, idleMs: now - session.lastUsedAt });
      await killWindow(session.window);
      this.live.delete(session.chatKey);
    }
  }

  /** Is this window mid-turn? The pane is the authority; hooks can stop firing. */
  async isWorking(window: string): Promise<boolean> {
    return WORKING.test(await capture(window, 6));
  }

  /** Something only a human can clear, or null. */
  async fatalState(window: string): Promise<string | null> {
    const screen = await capture(window, 60);
    // Only the most recent turn's result counts: the TUI keeps finished turns
    // on screen, so a failure from hours ago would otherwise be reported as a
    // permanent, self-healing-proof outage.
    const lines = screen.split('\n');
    let latest: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = (lines[i] ?? '').trim();
      if (line.startsWith('●')) {
        latest = line;
        break;
      }
    }
    if (latest === null) return null;
    return FATAL.find(([pattern]) => pattern.test(latest))?.[1] ?? null;
  }

  /**
   * Clear anything sitting between us and the prompt. Safe when nothing is
   * blocking: each key is sent only while its own dialog is on screen.
   */
  async clearObstructions(window: string): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const screen = await capture(window, 40);
      const hit = DIALOGS.find(([pattern]) => pattern.test(screen));
      if (!hit) return;
      log('session.dialog', { window, dismissedWith: hit[1] });
      await sendKey(window, hit[1]);
      await sleep(800);
    }
    log('session.dialogStuck', { window, note: 'a dialog is still on screen after three attempts' });
  }

  private async waitReady(window: string): Promise<boolean> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    while (Date.now() < deadline) {
      const screen = await capture(window, 80);
      if (DIALOGS.some(([pattern]) => pattern.test(screen))) {
        await this.clearObstructions(window);
        continue;
      }
      if (READY.test(screen)) {
        await sleep(300); // let the final frame settle
        return true;
      }
      await sleep(500);
    }
    return false;
  }
}

/** Has Claude Code ever written a transcript for this session id? */
function transcriptExists(uuid: string): boolean {
  const projects = join(process.env['CLAUDE_CONFIG_DIR'] ?? join(WORKSPACE_ROOT, '.claude'), 'projects');
  try {
    return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${uuid}.jsonl`)));
  } catch {
    return false;
  }
}
